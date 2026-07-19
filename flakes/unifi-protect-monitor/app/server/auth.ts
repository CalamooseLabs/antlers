// Optional shared-password gate (mirrors the robomoose/vibe-server pattern). When a
// passwordFile is configured, a signed cookie gates everything except the health check,
// the login page, and the login endpoint; otherwise the UI is passwordless (fine on a
// trusted LAN / behind the kiosk). HMAC-SHA256 via crypto.subtle. ZERO external imports.

import { Config } from "./config.ts";
import { b64url, errMsg, log, parseCookies, timingSafeEqual } from "./util.ts";

const COOKIE = "upm_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class AuthGate {
  #password = "";
  #key: CryptoKey | null = null;
  // When a passwordFile was configured but is unreadable/empty we FAIL CLOSED: the gate is
  // "enabled" but broken, so every request is denied (503) rather than silently exposing
  // the cameras passwordless. (An unset passwordFile is intentionally passwordless.)
  #broken = false;
  enabled = false;

  // Load the password (if any) and a persistent cookie-signing secret from the state dir
  // (so restarts don't invalidate sessions). Passwordless when no passwordFile is set.
  async init(cfg: Config): Promise<void> {
    if (cfg.passwordFile) {
      this.enabled = true; // the operator asked for auth — honour it or fail closed
      try {
        this.#password = (await Deno.readTextFile(cfg.passwordFile)).trim();
        if (this.#password.length === 0) {
          this.#broken = true;
          log("error", "passwordFile is empty — refusing all access (fail closed)", { path: String(cfg.passwordFile) });
        }
      } catch (e) {
        this.#broken = true;
        log("error", "failed to read passwordFile — refusing all access (fail closed)", { err: errMsg(e) });
      }
    }
    if (!this.enabled || this.#broken) return;

    const secretPath = `${cfg.stateDir}/cookie-secret`;
    let secret: Uint8Array;
    try {
      secret = await Deno.readFile(secretPath);
    } catch {
      secret = crypto.getRandomValues(new Uint8Array(32));
      try {
        await Deno.mkdir(cfg.stateDir, { recursive: true });
        await Deno.writeFile(secretPath, secret, { mode: 0o600 });
      } catch (e) {
        log("warn", "could not persist cookie secret (sessions reset on restart)", { err: errMsg(e) });
      }
    }
    // Copy into a fresh ArrayBuffer-backed view so the WebCrypto typings accept it.
    const keyData = new Uint8Array(secret);
    this.#key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }

  async #sign(msg: string): Promise<string> {
    const sig = await crypto.subtle.sign("HMAC", this.#key!, new TextEncoder().encode(msg));
    return b64url(new Uint8Array(sig));
  }

  async #makeCookieValue(): Promise<string> {
    const exp = String(Date.now() + TTL_MS);
    return `${exp}.${await this.#sign(exp)}`;
  }

  async #valid(value: string | undefined): Promise<boolean> {
    if (!value || !this.#key) return false;
    const dot = value.indexOf(".");
    if (dot < 0) return false;
    const exp = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return timingSafeEqual(sig, await this.#sign(exp));
  }

  // True only for a genuinely misconfigured gate (passwordFile set but unusable).
  get broken(): boolean {
    return this.#broken;
  }

  async isAuthed(req: Request): Promise<boolean> {
    if (this.#broken) return false; // fail closed
    if (!this.enabled) return true;
    const cookies = parseCookies(req.headers.get("cookie"));
    return await this.#valid(cookies[COOKIE]);
  }

  // POST /api/login { password } -> sets the cookie or 401.
  async login(req: Request): Promise<Response> {
    if (this.#broken) return new Response("authentication is misconfigured", { status: 503 });
    if (!this.enabled) return new Response(null, { status: 204 });
    let password = "";
    try {
      const body = await req.json();
      password = String(body?.password ?? "");
    } catch { /* empty */ }
    if (!timingSafeEqual(password, this.#password)) {
      return new Response("invalid password", { status: 401 });
    }
    const cookie = `${COOKIE}=${await this.#makeCookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`;
    return new Response(null, { status: 204, headers: { "set-cookie": cookie } });
  }

  logout(): Response {
    const cookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    return new Response(null, { status: 204, headers: { "set-cookie": cookie } });
  }
}
