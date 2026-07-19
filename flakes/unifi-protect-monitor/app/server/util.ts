// Small shared helpers (logging, HTTP responses, cookies, constant-time compare).
// ZERO external imports — only Deno.* and Web platform globals.

export type LogLevel = "debug" | "info" | "warn" | "error";

// One-line JSON logs to stderr so systemd-journald captures structured records and
// they never intermix with the fMP4 bytes we pipe over sockets.
export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  const rec: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
  if (extra) Object.assign(rec, extra);
  const line = JSON.stringify(rec);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function isError(e: unknown): e is Error {
  return e instanceof Error;
}

export function errMsg(e: unknown): string {
  return isError(e) ? e.message : String(e);
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function text(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

export function notFound(msg = "not found"): Response {
  return text(msg, 404);
}

export function badRequest(msg = "bad request"): Response {
  return text(msg, 400);
}

export function unauthorized(msg = "unauthorized"): Response {
  return text(msg, 401);
}

// Constant-time byte comparison so password/cookie checks don't leak length/content
// via timing. Compares UTF-8 encodings; unequal lengths still walk a fixed loop.
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// base64url of raw bytes (no padding) — used for cookie signatures / random ids.
export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId(bytesLen = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytesLen)));
}

// Parse a Cookie header into a plain map. Tolerant of spaces and missing values.
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// Sleep that resolves early if the AbortSignal fires (for reconnect backoff loops).
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
