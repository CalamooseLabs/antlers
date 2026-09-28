// Small shared helpers for cobblemon-overlay. ZERO external imports (see
// ./main.ts) — only Deno.* and Web platform globals, so the deno-cache FOD
// stays empty and the build works offline in the nix sandbox.

export function isError(e: unknown): e is Error {
  return e instanceof Error;
}

// One-line JSON log to stdout/stderr — greppable in `journalctl` without
// pulling in a logging dependency (the zero-import constraint).
export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, ctx: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx });
  if (level === "error") console.error(line);
  else console.log(line);
}

// JSON Response helper.
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Escape a string for interpolation into HTML text/attribute context. EVERY
// player-controlled string (nicknames, quest names, location, trainer names)
// must pass through this (server-side pages) or be set via textContent
// (client-side pages) before it reaches markup.
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Constant-time-ish string comparison for the token gates: XOR-accumulate
// over the longer length (missing bytes read as 0) plus a length mix, so the
// comparison time does not depend on where the first mismatch is.
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// Extract the token from an `Authorization: Bearer <token>` header value
// (case-insensitive scheme, surrounding whitespace trimmed). "" when the
// header is absent or malformed.
export function parseBearerToken(headerValue: string | null): string {
  if (!headerValue) return "";
  const m = /^\s*Bearer[ \t]+(\S.*?)\s*$/i.exec(headerValue);
  return m ? m[1] : "";
}

// The shared token gate (/ingest, /control, the mod-facing /effects routes):
// true when no token is configured, else the presented `Authorization: Bearer`
// (or, unless `bearerOnly`, the `X-Overlay-Token` header) must match —
// compared timing-safely. `bearerOnly` is the multichat-facing effects token.
export function checkToken(req: Request, token: string, opts: { bearerOnly?: boolean } = {}): boolean {
  if (!token) return true;
  const presented = parseBearerToken(req.headers.get("authorization")) ||
    (opts.bearerOnly ? "" : req.headers.get("x-overlay-token")) || "";
  return timingSafeEqual(presented, token);
}

// Whether a RAW socket peer address (Deno.serve's info.remoteAddr — there is no
// proxy in front, so never a forwarded header) is loopback. Gates the
// multichat-facing effect routes: multichat runs on the same broadcast host.
export function isLoopbackIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}

// Browser-origin hardening for the /effects routes: true when a browser PAGE
// sent this request — any `Origin` header (a browser always sends one on a
// cross-site POST, whatever its value, even "null"), or a `Sec-Fetch-Site`
// other than `none` (typed/bookmarked) / `same-origin`. multichat (Deno fetch),
// the mod (Java HttpClient) and curl send neither, so they are never refused;
// a page elsewhere in a browser on the broadcast host can't drive the queue.
export function isBrowserCrossOrigin(req: Request): boolean {
  if (req.headers.get("origin") !== null) return true;
  const site = req.headers.get("sec-fetch-site");
  if (site === null) return false;
  const s = site.trim().toLowerCase();
  return s !== "none" && s !== "same-origin";
}

// ---- durable persistence (state.json, effects.json) ----

// Atomic + durable replace: write a UNIQUE tmp file in the same directory (so
// overlapping writers can never rename each other's tmp away), fsync its data,
// then rename over the target. The tmp file is removed on any failure.
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const data = new TextEncoder().encode(text);
  try {
    const f = await Deno.open(tmp, { write: true, create: true, truncate: true });
    try {
      let off = 0;
      while (off < data.length) off += await f.write(data.subarray(off));
      await f.syncData();
    } finally {
      f.close();
    }
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

// SERIALIZED writer with a generation counter. Owners call touch() on every
// mutation and `await flush()` to make everything mutated so far durable.
// Guarantees (the two reproduced state.json races):
//  - at most ONE write is in flight; concurrent flush() calls wait on it
//    instead of racing a second rename;
//  - a mutation that lands WHILE a write is in flight bumps the generation
//    past the one that write captured, so it stays dirty and the next flush()
//    writes it (a late mutation can never be marked clean by an older write).
// render() runs synchronously when a write starts, so each write is a
// consistent snapshot. path "" = persistence disabled (flush is a no-op).
//
// Exact attribution (the effect queue's write-through rollback relies on it):
// touch() returns the generation it created and flush(upTo) resolves as soon
// as a write that rendered at or after `upTo` has landed — so a committer is
// failed ONLY by the write that would have carried its own mutation, never by
// a later one it merely waited behind (flush() with no argument = everything
// so far). `onSaved` gets the exact text of each write that landed.
//
// A FAILED write, without `onFailed` (state.json): it rejects every flush()
// waiting on it and everything stays dirty for the next flush (no rollback, no
// retry). WITH `onFailed` (effects.json's write-through rollback): the failed
// write's own rejection handler — synchronously, before the writer is idle
// again, so no request can mutate or start a write in between — marks every
// generation not yet durable, (savedGen, gen], as DROPPED (mutations touched
// while the write was in flight included), has the owner roll memory back to
// the last text onSaved reported, and counts memory == disk again. A
// flush(upTo) whose generation was dropped then rejects with that error even
// if a later write lands (its mutation is gone from memory); one saved before
// the failure still resolves; a mutation made after it gets a fresh write of
// its own. Pass touch()'s generation straight to flush() in the same
// synchronous step: a dropped range is kept only while a flush() may ask.
export interface SerialWriterOpts {
  onSaved?: (text: string) => void; // the exact text of each write that LANDED
  onFailed?: (err: unknown) => void; // restore memory to the last onSaved text — synchronously, no touch()
  write?: (path: string, text: string) => Promise<void>; // default writeFileAtomic (tests inject one)
}

export class SerialWriter {
  #path: string;
  #render: () => string;
  #onSaved: ((text: string) => void) | null;
  #onFailed: ((err: unknown) => void) | null;
  #write: (path: string, text: string) => Promise<void>;
  #gen = 0;
  #savedGen = 0;
  #inflight: Promise<void> | null = null;
  // generations an onFailed rollback dropped — (from, to] — and why
  #dropped: { from: number; to: number; err: unknown }[] = [];
  // upTo → how many flush() calls are asking about it (bounds #dropped)
  #waiting = new Map<number, number>();

  constructor(path: string, render: () => string, opts: SerialWriterOpts = {}) {
    this.#path = path;
    this.#render = render;
    this.#onSaved = opts.onSaved ?? null;
    this.#onFailed = opts.onFailed ?? null;
    this.#write = opts.write ?? writeFileAtomic;
  }

  touch(): number {
    return ++this.#gen;
  }

  get dirty(): boolean {
    return this.#savedGen < this.#gen;
  }

  async flush(upTo: number = this.#gen): Promise<void> {
    if (!this.#path) {
      this.#savedGen = this.#gen;
      return;
    }
    const want = Math.min(upTo, this.#gen); // (a generation that doesn't exist yet can never land)
    this.#waiting.set(want, (this.#waiting.get(want) ?? 0) + 1);
    try {
      for (;;) {
        // rolled back → this caller's mutation is gone, whatever has landed since
        const dropped = this.#dropped.find((d) => d.from < want && want <= d.to);
        if (dropped) throw dropped.err;
        if (this.#savedGen >= want) return;
        if (this.#inflight === null) this.#start();
        try {
          await this.#inflight;
        } catch (e) {
          if (this.#onFailed === null) throw e; // no rollback: it stays dirty for the next flush
          // (rolled back — the top of the loop says whether `want` went with it)
        }
      }
    } finally {
      const n = (this.#waiting.get(want) ?? 1) - 1;
      if (n > 0) this.#waiting.set(want, n);
      else this.#waiting.delete(want);
      // a range entirely below every generation still being asked about is dead
      if (this.#dropped.length) {
        const oldest = Math.min(...this.#waiting.keys()); // Infinity when none
        this.#dropped = this.#dropped.filter((d) => d.to >= oldest);
      }
    }
  }

  // Start ONE write of everything mutated so far (render() runs NOW). Each
  // settle handler runs start to finish without yielding, so no request
  // continuation can see the writer idle before a failure's rollback is done
  // (clearing #inflight first is invisible to them — and means even a throwing
  // onFailed can't leave a dead write for every later flush to spin on).
  #start(): void {
    const gen = this.#gen;
    const text = this.#render();
    this.#inflight = this.#write(this.#path, text).then(
      () => {
        this.#inflight = null;
        if (gen > this.#savedGen) {
          this.#savedGen = gen;
          this.#onSaved?.(text);
        }
      },
      (e) => {
        this.#inflight = null;
        if (this.#onFailed !== null) {
          // every generation not yet durable — incl. ones touched while this
          // write was in flight — goes with the owner's rollback, right now
          const to = this.#gen;
          if (to > this.#savedGen) this.#dropped.push({ from: this.#savedGen, to, err: e });
          this.#savedGen = to; // memory == disk again once onFailed returns
          this.#onFailed(e);
        }
        throw e;
      },
    );
  }
}
