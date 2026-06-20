// Authentication: HMAC-signed session cookie, constant-time password check,
// cookie helpers, and per-IP login rate-limiting. ZERO external imports.

import { b64url, buf, unb64url } from "./util.ts";

const COOKIE = "vibe_session";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let hmacKey: CryptoKey;

export async function getSecret(stateDir: string): Promise<Uint8Array> {
  const path = `${stateDir}/cookie.secret`;
  try {
    return await Deno.readFile(path);
  } catch {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeFile(path, secret, { mode: 0o600 });
    return secret;
  }
}

export async function initKey(secret: Uint8Array): Promise<void> {
  hmacKey = await crypto.subtle.importKey(
    "raw",
    buf(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function makeToken(): Promise<string> {
  const payload = JSON.stringify({
    iat: Date.now(),
    n: b64url(crypto.getRandomValues(new Uint8Array(8))),
  });
  const payloadBytes = new TextEncoder().encode(payload);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, buf(payloadBytes)));
  return `${b64url(payloadBytes)}.${b64url(sig)}`;
}

async function verifyToken(token: string): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  try {
    const payloadBytes = unb64url(token.slice(0, dot));
    const sig = unb64url(token.slice(dot + 1));
    const ok = await crypto.subtle.verify("HMAC", hmacKey, buf(sig), buf(payloadBytes));
    if (!ok) return false;
    const { iat } = JSON.parse(new TextDecoder().decode(payloadBytes));
    return typeof iat === "number" && Date.now() - iat <= TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(new TextEncoder().encode(s))));
}

function ctEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function checkPassword(submitted: string, passwordFile: string): Promise<boolean> {
  let expected: string;
  try {
    expected = (await Deno.readTextFile(passwordFile)).trim();
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  // Compare SHA-256 digests so the comparison is fixed-length and constant-time.
  return ctEq(await sha256(submitted), await sha256(expected));
}

// ---- cookies ----

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v; // tolerate malformed percent-encoding rather than throwing
      }
    }
  }
  return out;
}

// `secure` adds the Secure attribute (HTTPS-only) — set when the request arrived
// over TLS (directly or via a reverse proxy's x-forwarded-proto). It is left OFF
// on a plain-HTTP LAN so the cookie is still returned by the browser there.
function cookieAttrs(secure: boolean): string {
  return `Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}

export function setCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(secure)}; Max-Age=${
    Math.floor(TOKEN_TTL_MS / 1000)
  }`;
}

export function clearCookie(secure: boolean): string {
  return `${COOKIE}=; ${cookieAttrs(secure)}; Max-Age=0`;
}

export async function newSessionCookie(secure: boolean): Promise<string> {
  return setCookie(await makeToken(), secure);
}

export async function isAuthed(req: Request): Promise<boolean> {
  const token = parseCookies(req.headers.get("cookie"))[COOKIE];
  return token ? await verifyToken(token) : false;
}

// ---- per-IP login rate limiting ----
//
// A shared password over a LAN is brute-forceable; throttle failed attempts with
// exponential backoff after a few free tries. In-memory only (no dependency).

interface Attempt {
  count: number;
  blockedUntil: number;
}

const loginAttempts = new Map<string, Attempt>();
const LOGIN_FREE_TRIES = 3;
const LOGIN_MAX_BACKOFF_S = 900; // 15 minutes
const LOGIN_TRACK_CAP = 4096;

export function loginAllowed(ip: string): { ok: boolean; retryAfter: number } {
  const a = loginAttempts.get(ip);
  if (!a) return { ok: true, retryAfter: 0 };
  const now = Date.now();
  if (now < a.blockedUntil) return { ok: false, retryAfter: Math.ceil((a.blockedUntil - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

export function loginFailed(ip: string): void {
  const now = Date.now();
  const a = loginAttempts.get(ip) ?? { count: 0, blockedUntil: 0 };
  a.count++;
  const over = a.count - LOGIN_FREE_TRIES;
  const delay = over <= 0 ? 0 : Math.min(2 ** over, LOGIN_MAX_BACKOFF_S);
  a.blockedUntil = now + delay * 1000;
  loginAttempts.set(ip, a);
  if (loginAttempts.size > LOGIN_TRACK_CAP) {
    for (const [k, v] of loginAttempts) {
      if (v.blockedUntil < now) loginAttempts.delete(k);
      if (loginAttempts.size <= LOGIN_TRACK_CAP) break;
    }
  }
}

export function loginSucceeded(ip: string): void {
  loginAttempts.delete(ip);
}
