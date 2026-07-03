// Small shared helpers for vibe-server. ZERO external imports (see ./main.ts).

export function isError(e: unknown): e is Error {
  return e instanceof Error;
}

// Safe identifier for a directory/project name (no slashes, no traversal).
export function isValidName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

// Whether a RAW socket peer address (not the x-forwarded-for value) is loopback.
// Gates the local self-registration endpoints — a manually-run `vibe` is always
// on the same host as the server.
export function isLoopbackIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}

// Extract the token from an `Authorization: Bearer <token>` header value
// (case-insensitive scheme, surrounding whitespace trimmed). "" when the header
// is absent or malformed. Gates the loopback CLI API (a local `vibe ls` / `vibe
// open`) with the discovery-file token, the same secret that gates /api/register.
export function parseBearerToken(headerValue: string | null): string {
  if (!headerValue) return "";
  const m = /^\s*Bearer[ \t]+(\S.*?)\s*$/i.exec(headerValue);
  return m ? m[1] : "";
}

// ---- pure path / name helpers (no filesystem access; unit-tested) ----

// Normalize an ABSOLUTE path: resolve "." / ".." segments and collapse duplicate
// slashes, without touching the filesystem. ".." can never climb above root, so
// the result always stays rooted at "/". Returns "/" for the root itself.
export function normalizeAbs(p: string): string {
  const stack: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return "/" + stack.join("/");
}

// Whether normalized path `p` is inside (or equal to) normalized `root`. "/"
// contains everything; "/home" contains "/home" and "/home/x" but NOT "/homework".
export function withinRoot(root: string, p: string): boolean {
  if (root === "/") return true;
  return p === root || p.startsWith(root + "/");
}

// Reduce a string to the directory/label charset [A-Za-z0-9_-]: collapse runs of
// other characters to a single "-" and trim leading/trailing "-". Empty result
// (e.g. all-slashes) falls back to "project".
export function sanitizeName(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length ? cleaned : "project";
}

// Return `base`, or `base-2`, `base-3`, … so the result is not in `taken`.
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
}

// Final path segment (basename) of an absolute path. "/a/b" → "b", "/a/b/" → "b",
// "/" → "".
export function basenameOf(p: string): string {
  const n = normalizeAbs(p);
  return n === "/" ? "" : n.slice(n.lastIndexOf("/") + 1);
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
