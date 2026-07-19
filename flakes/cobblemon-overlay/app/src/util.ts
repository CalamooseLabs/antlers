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

// Constant-time-ish string comparison for the ingest token gate: XOR-accumulate
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
