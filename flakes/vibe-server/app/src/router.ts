// HTTP routing: a public landing page + login + liveness probe, then everything
// else behind the session cookie.

import type { ServerConfig } from "./config.ts";
import {
  checkPassword,
  clearCookie,
  isAuthed,
  loginAllowed,
  loginFailed,
  loginSucceeded,
  newSessionCookie,
  passwordRequired,
} from "./auth.ts";
import {
  deregisterExternal,
  getSession,
  heartbeatExternal,
  killSession,
  listSessions,
  registerExternal,
  registerTokenMatches,
  sessionCount,
  spawnSession,
} from "./sessions.ts";
import { listPresets, resolvePreset } from "./presets.ts";
import {
  cancelClaudeLogin,
  claudeAuthStatus,
  loginState,
  startClaudeLogin,
  submitClaudeCode,
} from "./claude.ts";
import { streamLog } from "./sse.ts";
import { renderLog } from "./term.ts";
import { gitDiffMulti } from "./diff.ts";
import { canCommit, canPush, cleanMessage, cleanPin, commitAndPush } from "./commit.ts";
import { json, readJsonLimited } from "./http.ts";
import { INDEX_HTML } from "./html.ts";
import { isLoopbackIp, isValidName } from "./util.ts";

// `peerIp` is the RAW socket peer (not x-forwarded-for) — used to confine the
// local self-registration endpoints to loopback.
export async function handler(req: Request, config: ServerConfig, clientIp: string, peerIp: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  // Mark the cookie Secure only when the request actually arrived over TLS
  // (directly or via a reverse proxy), so plain-HTTP LAN use still works.
  const secure = req.headers.get("x-forwarded-proto") === "https" || url.protocol === "https:";

  // When TLS is required, refuse plain-HTTP requests (except the liveness probe
  // and the loopback-only self-registration endpoint, which a local `vibe` always
  // reaches over plain HTTP on 127.0.0.1, bypassing any TLS front).
  if (config.requireTLS && !secure && path !== "/healthz" && path !== "/api/register") {
    return json({ error: "HTTPS required" }, 426);
  }

  if (path === "/" && method === "GET") {
    return new Response(INDEX_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // Unauthenticated liveness probe for monitoring / readiness checks.
  if (path === "/healthz" && method === "GET") {
    return json({ ok: true, sessions: sessionCount() });
  }

  // Public: lets the login page decide whether to prompt for a password or sign
  // in automatically (passwordless mode). Reveals nothing sensitive.
  if (path === "/api/auth-mode" && method === "GET") {
    return json({ passwordRequired: passwordRequired(config.passwordFile) });
  }

  if (path === "/api/login" && method === "POST") {
    // Passwordless mode (no passwordFile configured): grant a session cookie to
    // anyone who can reach the service — no password check, no rate limiting.
    if (!passwordRequired(config.passwordFile)) {
      return json({ ok: true }, 200, { "set-cookie": await newSessionCookie(secure) });
    }
    const gate = loginAllowed(clientIp);
    if (!gate.ok) return json({ error: "Too many attempts" }, 429, { "retry-after": String(gate.retryAfter) });
    const body: Record<string, unknown> = await readJsonLimited(req).catch(() => ({}));
    const ok = typeof body.password === "string" && await checkPassword(body.password, config.passwordFile);
    if (!ok) {
      loginFailed(clientIp);
      return json({ error: "Invalid password" }, 401);
    }
    loginSucceeded(clientIp);
    return json({ ok: true }, 200, { "set-cookie": await newSessionCookie(secure) });
  }

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearCookie(secure) });
  }

  // ---- local self-registration (a manually-run `vibe` on this host) ----
  // NOT cookie-gated: gated by the loopback peer + the discovery-file token (POST)
  // / per-registration token (PUT heartbeat, DELETE deregister). Lets a hand-run
  // `vibe` appear in the session list. See sessions.ts + main.ts.
  if (path === "/api/register") {
    if (!isLoopbackIp(peerIp)) return json({ error: "Forbidden" }, 403);
    const body: Record<string, unknown> = await readJsonLimited(req).catch(() => ({}));
    if (method === "POST") {
      if (typeof body.token !== "string" || !registerTokenMatches(body.token)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const name = body.name;
      const dir = body.dir;
      const pid = typeof body.pid === "number" ? body.pid : Number(body.pid);
      if (typeof name !== "string" || !isValidName(name)) return json({ error: "Invalid name" }, 400);
      // Absolute path, length-capped, and free of control characters (defense in
      // depth — the UI also renders it via textContent, never innerHTML).
      if (typeof dir !== "string" || !dir.startsWith("/") || dir.length > 4096 || [...dir].some((c) => c.charCodeAt(0) < 0x20)) {
        return json({ error: "Invalid dir" }, 400);
      }
      if (!Number.isInteger(pid) || pid <= 0) return json({ error: "Invalid pid" }, 400);
      try {
        return json(await registerExternal({ name, dir, pid }), 201);
      } catch {
        return json({ error: "Could not register" }, 400);
      }
    }
    if (method === "PUT" || method === "DELETE") {
      if (typeof body.id !== "string" || typeof body.token !== "string") {
        return json({ error: "Invalid" }, 400);
      }
      const ok = method === "PUT"
        ? heartbeatExternal(body.id, body.token)
        : deregisterExternal(body.id, body.token);
      return json({ ok }, ok ? 200 : 404);
    }
    return json({ error: "Method not allowed" }, 405);
  }

  // Everything below requires authentication.
  if (!await isAuthed(req)) return json({ error: "Unauthorized" }, 401);

  if (path === "/api/me" && method === "GET") return json({ ok: true });

  // ---- Claude account auth (so spawned sessions are authenticated) ----
  // Whether the service user's Claude account is logged in, plus any in-flight
  // login flow's state. The web UI surfaces a banner + a login modal from this.
  if (path === "/api/claude-auth" && method === "GET") {
    return json({ status: await claudeAuthStatus(config), login: loginState() });
  }
  // Start (or rejoin) the interactive `claude auth login` flow; returns the login
  // state, including the OAuth URL once it has been captured.
  if (path === "/api/claude-auth/login" && method === "POST") {
    return json(await startClaudeLogin(config));
  }
  // Abort an in-flight login.
  if (path === "/api/claude-auth/login" && method === "DELETE") {
    cancelClaudeLogin();
    return json({ ok: true });
  }
  // Submit the authorization code the user pasted from the OAuth page.
  if (path === "/api/claude-auth/code" && method === "POST") {
    const body: Record<string, unknown> = await readJsonLimited(req).catch(() => ({}));
    if (typeof body.code !== "string") return json({ error: "Invalid code" }, 400);
    const res = await submitClaudeCode(config, body.code);
    return json(res, res.ok ? 200 : 400);
  }

  // The launch presets (from programs.vibe.presets). The UI lists them; each is a
  // name + its directories (first = working dir) + the per-preset commit settings.
  if (path === "/api/presets" && method === "GET") {
    return json({ presets: listPresets(config) });
  }

  if (path === "/api/sessions" && method === "GET") {
    // Enrich each session with its per-preset Commit & Push capabilities so the UI
    // can show/hide the button and name the branch. The server re-checks below.
    const sessions = listSessions().map((s) => {
      const p = s.preset ? resolvePreset(config, s.preset) : undefined;
      return {
        ...s,
        canCommit: p ? canCommit(config, p) : false,
        canPush: p ? canPush(config, p) : false,
        commitBranch: p ? p.branch : "",
      };
    });
    return json({ sessions });
  }

  if (path === "/api/sessions" && method === "POST") {
    const body: Record<string, unknown> = await readJsonLimited(req).catch(() => ({}));
    const presetName = body.preset;
    if (typeof presetName !== "string" || !isValidName(presetName)) return json({ error: "Invalid preset" }, 400);
    const preset = resolvePreset(config, presetName);
    if (!preset) return json({ error: "Unknown preset" }, 400);
    try {
      return json({ session: await spawnSession(config, preset) }, 201);
    } catch {
      return json({ error: "Could not start session" }, 400);
    }
  }

  const del = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/);
  if (del && method === "DELETE") {
    // External sessions belong to a user's terminal — never signal their pid from
    // here (it isn't ours; see killSession). The UI hides Kill for them anyway.
    const s = getSession(del[1]);
    if (s && s.info.external) return json({ error: "External sessions are managed from their own terminal" }, 409);
    const ok = killSession(del[1]);
    return json({ ok }, ok ? 200 : 404);
  }

  const logs = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/logs$/);
  if (logs && method === "GET") {
    const s = getSession(logs[1]);
    if (!s) return json({ error: "Not found" }, 404);
    // External sessions have no captured log — their output is in the user's terminal.
    if (s.info.external) return json({ error: "No captured log" }, 404);
    return streamLog(s.logPath);
  }

  const dl = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/logs\/download$/);
  if (dl && method === "GET") {
    const s = getSession(dl[1]);
    if (!s) return json({ error: "Not found" }, 404);
    if (s.info.external) return json({ error: "No captured log" }, 404);
    // The captured log is raw PTY output from a full-screen TUI. By default render
    // it to the readable screen it represents (term.ts); `?raw=1` serves the raw
    // bytes verbatim for debugging.
    const raw = url.searchParams.get("raw") === "1";
    try {
      if (raw) {
        // Raw bytes verbatim: control/escape codes and possibly chunk-split UTF-8,
        // so label it binary (not text/utf-8) — it's an attachment regardless.
        const data = await Deno.readFile(s.logPath);
        return new Response(data, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${s.info.name}.raw.log"`,
          },
        });
      }
      // Rendered screen. renderLog is fully synchronous (no awaits) and Deno is
      // single-threaded, so emulating a maxed-out (25 MiB) log would freeze the
      // event loop — stalling /healthz, SSE tails, kills. Bound it: a snapshot only
      // reflects the CURRENT screen, and earlier repaints are overwritten, so the
      // last RENDER_BUDGET bytes reproduce it. (Seeking mid-UTF-8 may clip one lead
      // byte; TermFilter's streaming decoder drops it — harmless for a tail render.)
      const RENDER_BUDGET = 1 << 20; // 1 MiB
      const file = await Deno.open(s.logPath, { read: true });
      try {
        const size = (await file.stat()).size;
        const start = size > RENDER_BUDGET ? size - RENDER_BUDGET : 0;
        const len = size - start;
        await file.seek(start, Deno.SeekMode.Start);
        const bytes = new Uint8Array(len);
        let off = 0;
        while (off < len) {
          const n = await file.read(bytes.subarray(off));
          if (n === null) break;
          off += n;
        }
        const body = new TextEncoder().encode(renderLog(bytes.subarray(0, off)) + "\n");
        return new Response(body, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": `attachment; filename="${s.info.name}.log"`,
          },
        });
      } finally {
        try {
          file.close();
        } catch { /* ignore */ }
      }
    } catch {
      return json({ error: "Not found" }, 404);
    }
  }

  const diff = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/diff$/);
  if (diff && method === "GET") {
    const s = getSession(diff[1]);
    if (!s) return json({ error: "Not found" }, 404);
    // For server-spawned sessions the paths are server-controlled (the preset);
    // defense-in-depth: only diff a still-defined preset, so a stale one is a clean
    // 409 rather than a stray git run. External sessions aren't preset-backed —
    // their single path came from a token-authenticated loopback registration; git
    // runs read-only + scrubbed, so diff it directly.
    const preset = s.info.external ? undefined : resolvePreset(config, s.info.preset ?? "");
    if (!s.info.external && !preset) {
      return json({ error: "Preset no longer defined" }, 409);
    }
    // Diff EVERY directory the session spans: a preset's full `directories` list
    // (first = working dir, rest = --add-dir'd), or the one registered dir for an
    // external session. gitDiffMulti never throws (gitDiff catches internally).
    const dirs = preset && preset.directories.length ? preset.directories : [s.info.path];
    return json(await gitDiffMulti(dirs));
  }

  // Stage + YubiKey-signed commit (+ optional push) of a session's working tree.
  // The ONE mutating git route — guarded hard: the session must be server-owned
  // (external → 409, like Kill — never mutate a tree managed from someone's own
  // terminal) and still preset-backed; the feature must be enabled and the preset
  // not commit-touch-gated (403). The UI gate is cosmetic; this is the gate.
  const cmt = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/commit-push$/);
  if (cmt && method === "POST") {
    const s = getSession(cmt[1]);
    if (!s) return json({ error: "Not found" }, 404);
    if (s.info.external) return json({ error: "External sessions are managed from their own terminal" }, 409);
    const preset = resolvePreset(config, s.info.preset ?? "");
    if (!preset) return json({ error: "Preset no longer defined" }, 409);
    if (!canCommit(config, preset)) return json({ error: "Commit & Push is disabled for this preset" }, 403);
    const body: Record<string, unknown> = await readJsonLimited(req).catch(() => ({}));
    const message = cleanMessage(body.message);
    if (!message) return json({ error: "A commit message is required" }, 400);
    const pin = cleanPin(body.pin);
    if (!pin) return json({ error: "A valid card PIN is required" }, 400);
    // Push only when the client asked AND the preset permits it (push touch-gate).
    const doPush = body.push === true && canPush(config, preset);
    const result = await commitAndPush(config, preset, s.info.path, message, pin, doPush);
    // 200 once a commit landed (even if a later push failed — the result carries
    // the details); 400 only when nothing was committed.
    return json(result, result.committed ? 200 : 400);
  }

  return json({ error: "Not found" }, 404);
}
