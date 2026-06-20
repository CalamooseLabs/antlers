// Small shared helpers for vibe-server. ZERO external imports (see ./main.ts).

export function isError(e: unknown): e is Error {
  return e instanceof Error;
}

// Safe identifier for a directory/project name (no slashes, no traversal).
export function isValidName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

// Web Crypto wants ArrayBuffer-backed views; normalise to the strict
// `BufferSource` (vs `Uint8Array<ArrayBufferLike>`) typings of recent TS libs.
export const buf = (u: Uint8Array): BufferSource => u as BufferSource;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function unb64url(s: string): Uint8Array {
  let t = s.replaceAll("-", "+").replaceAll("_", "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// One-line JSON log to stdout/stderr — greppable in `journalctl` without
// pulling in a logging dependency (the zero-import constraint).
export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, ctx: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx });
  if (level === "error") console.error(line);
  else console.log(line);
}
