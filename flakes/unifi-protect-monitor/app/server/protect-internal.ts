// Client for UniFi Protect's INTERNAL API (/proxy/protect/api/*), used ONLY for recorded
// video (the public Integration API has no recordings endpoint). Unlike the integration
// API, the internal API rejects the X-API-KEY (a bare request 401s; the key yields a 500) —
// it needs a UniFi OS SESSION: POST /api/auth/login → a `TOKEN` JWT cookie + an
// `x-csrf-token` header, re-login near expiry / on 401. TLS to the local self-signed
// console is accepted via the compiled binary's baked --unsafely-ignore-certificate-errors.
// ZERO external imports.

import { errMsg, log } from "./util.ts";

// A tiny fair semaphore (slot handed off to a waiter without touching the active count, so
// it can never exceed max). Bounds concurrent recorded-clip exports so a burst can't pile up
// heavy console transmux jobs.
class Semaphore {
  #max: number;
  #active = 0;
  #queue: Array<() => void> = [];
  constructor(max: number) {
    this.#max = max;
  }
  async acquire(): Promise<void> {
    if (this.#active < this.#max) {
      this.#active++;
      return;
    }
    await new Promise<void>((r) => this.#queue.push(r));
  }
  release(): void {
    const next = this.#queue.shift();
    if (next) next(); // hand the slot to a waiter (active unchanged)
    else this.#active--;
  }
}

// Wrap a stream so `release` runs exactly once when it ends, errors, or is cancelled (client
// disconnect) — used to free a semaphore slot only when the clip has finished streaming.
function releaseOnDone(source: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let released = false;
  const rel = () => {
    if (released) return;
    released = true;
    try {
      release();
    } catch { /* ignore */ }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          rel();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        rel();
        controller.error(e);
      }
    },
    cancel(reason) {
      rel();
      return reader.cancel(reason);
    },
  });
}

export interface RecordingCoverage {
  recordingStart: number | null; // unix ms, oldest footage
  recordingEnd: number | null; // unix ms, newest footage
  mode: string; // always | detections | never | unknown
}

// Decode a JWT's `exp` (seconds) to unix ms without any library. Exported for tests.
export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = JSON.parse(atob(b64)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Clamp a requested [start,end] window to the camera's recorded coverage and cap its
// length to maxMs (the guard against console export timeouts on long ranges). Returns null
// if the window is empty/invalid. Pure — exported for tests.
export function clampClipWindow(
  startMs: number,
  endMs: number,
  coverage: RecordingCoverage | undefined,
  maxMs: number,
): { start: number; end: number } | null {
  let s = Math.floor(startMs);
  let e = Math.floor(endMs);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  if (coverage?.recordingStart != null) s = Math.max(s, coverage.recordingStart);
  if (coverage?.recordingEnd != null) e = Math.min(e, coverage.recordingEnd);
  if (e <= s) return null;
  if (e - s > maxMs) e = s + maxMs;
  return { start: s, end: e };
}

function readSetCookies(headers: Headers): string[] {
  const h = headers as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = headers.get("set-cookie");
  return one ? [one] : [];
}

export class ProtectInternalClient {
  #root: string;
  #username: string;
  #getPassword: () => Promise<string>;
  #token = "";
  #csrf = "";
  #expMs = 0;
  #loginInFlight: Promise<void> | null = null;
  #bootstrapCache: { data: Map<string, RecordingCoverage>; exp: number } | null = null;
  #exportSem = new Semaphore(3); // cap concurrent recorded-clip exports

  constructor(consoleRoot: string, username: string, getPassword: () => Promise<string>) {
    this.#root = consoleRoot.replace(/\/+$/, "");
    this.#username = username;
    this.#getPassword = getPassword;
  }

  async #login(): Promise<void> {
    const password = await this.#getPassword();
    if (!this.#username || !password) throw new Error("recordings: username/password not configured");
    const res = await fetch(`${this.#root}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: this.#username, password, rememberMe: true }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`login failed: ${res.status} ${res.statusText}${txt ? ` — ${txt.slice(0, 160)}` : ""}`);
    }
    await res.body?.cancel().catch(() => {});
    let token = "";
    for (const c of readSetCookies(res.headers)) {
      const m = c.match(/^TOKEN=([^;]+)/);
      if (m) token = m[1];
    }
    if (!token) throw new Error("login succeeded but returned no TOKEN cookie");
    this.#token = token;
    this.#csrf = res.headers.get("x-csrf-token") ?? this.#csrf;
    this.#expMs = decodeJwtExpMs(token) ?? Date.now() + 60 * 60 * 1000;
    log("info", "internal session established", { expiresInSec: Math.max(0, Math.round((this.#expMs - Date.now()) / 1000)) });
  }

  // Login only when there's no token or it's within 60s of expiry; serialize concurrent
  // callers behind one in-flight login so a burst of clip requests logs in once.
  async #ensureSession(): Promise<void> {
    if (this.#token && this.#expMs - Date.now() > 60_000) return;
    if (!this.#loginInFlight) {
      this.#loginInFlight = this.#login().finally(() => {
        this.#loginInFlight = null;
      });
    }
    await this.#loginInFlight;
  }

  #authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Cookie: `TOKEN=${this.#token}`, "x-csrf-token": this.#csrf, ...extra };
  }

  // Ensure a session, send auth headers, and re-login once on a 401. Opportunistically
  // refreshes the csrf token from any response that carries a new one. `signal` (when given)
  // aborts the outbound request on client disconnect. The 401 reset is a compare-and-swap on
  // the token that actually failed, so a request racing behind a fresh re-login reuses it
  // rather than forcing a redundant second login.
  async #authedFetch(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    await this.#ensureSession();
    const used = this.#token;
    let res = await fetch(url, { headers: this.#authHeaders(headers), signal });
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      if (this.#token === used) {
        this.#token = "";
        this.#expMs = 0;
      }
      await this.#ensureSession();
      res = await fetch(url, { headers: this.#authHeaders(headers), signal });
    }
    const newCsrf = res.headers.get("x-csrf-token");
    if (newCsrf) this.#csrf = newCsrf;
    return res;
  }

  // GET /proxy/protect/api/bootstrap → per-camera recorded coverage. Cached ~30s (heavy).
  async getBootstrapCameras(): Promise<Map<string, RecordingCoverage>> {
    const now = Date.now();
    if (this.#bootstrapCache && this.#bootstrapCache.exp > now) return this.#bootstrapCache.data;
    const res = await this.#authedFetch(`${this.#root}/proxy/protect/api/bootstrap`, { accept: "application/json" });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`bootstrap -> ${res.status} ${res.statusText}`);
    }
    const boot = (await res.json()) as {
      cameras?: Array<{
        id: string;
        stats?: { video?: { recordingStart?: number | null; recordingEnd?: number | null } };
        recordingSettings?: { mode?: string };
      }>;
    };
    const map = new Map<string, RecordingCoverage>();
    for (const c of boot.cameras ?? []) {
      if (!c.id) continue;
      map.set(c.id, {
        recordingStart: c.stats?.video?.recordingStart ?? null,
        recordingEnd: c.stats?.video?.recordingEnd ?? null,
        mode: c.recordingSettings?.mode ?? "unknown",
      });
    }
    this.#bootstrapCache = { data: map, exp: now + 30_000 };
    return map;
  }

  // GET /proxy/protect/api/video/export → a streamed video/mp4. Returns a Response whose body
  // the router pipes through without buffering. A concurrency slot is held for the WHOLE
  // stream (released when it ends/errors/cancels) so a burst can't pile up console transmux
  // jobs; `signal` aborts the upstream fetch on client disconnect (incl. during establishment).
  async exportClip(cameraId: string, startMs: number, endMs: number, channel: number, signal?: AbortSignal): Promise<Response> {
    const qs = new URLSearchParams({
      camera: cameraId,
      start: String(startMs),
      end: String(endMs),
      channel: String(channel),
    });
    const url = `${this.#root}/proxy/protect/api/video/export?${qs}`;
    await this.#exportSem.acquire();
    let res: Response;
    try {
      res = await this.#authedFetch(url, { accept: "video/mp4" }, signal);
    } catch (e) {
      this.#exportSem.release();
      throw e;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      this.#exportSem.release();
      return res;
    }
    const body = releaseOnDone(res.body, () => this.#exportSem.release());
    return new Response(body, { status: res.status, statusText: res.statusText });
  }

  // GET /proxy/protect/api/cameras/{id}/recording-snapshot → a JPEG frame at an arbitrary
  // recorded timestamp (the scrubber hover preview).
  async recordingSnapshot(
    cameraId: string,
    tsMs: number,
    w?: number,
    h?: number,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
    const qs = new URLSearchParams({ ts: String(tsMs) });
    if (w) qs.set("w", String(w));
    if (h) qs.set("h", String(h));
    const res = await this.#authedFetch(
      `${this.#root}/proxy/protect/api/cameras/${encodeURIComponent(cameraId)}/recording-snapshot?${qs}`,
      { accept: "image/jpeg" },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`recording-snapshot -> ${res.status}`);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "image/jpeg" };
  }

  // Best-effort startup probe (logs coverage or a clear reason; never fatal).
  async healthCheck(): Promise<void> {
    try {
      const cams = await this.getBootstrapCameras();
      log("info", "recordings: internal session OK", { cameras: cams.size });
    } catch (e) {
      log("warn", "recordings: internal session/health check failed", { err: errMsg(e) });
    }
  }
}
