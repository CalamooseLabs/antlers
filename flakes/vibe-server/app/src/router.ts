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
import {
  addDirectory,
  browse,
  canManageDirectories,
  listDirectories,
  removeDirectory,
  resolveDir,
} from "./directories.ts";
import {
  cancelClaudeLogin,
  claudeAuthStatus,
  loginState,
  startClaudeLogin,
  submitClaudeCode,
} from "./claude.ts";
import { streamLog } from "./sse.ts";
import { gitDiff } from "./diff.ts";
import { json, readJsonLimited } from "./http.ts";
import { INDEX_HTML } from "./html.ts";
import { isError, isLoopbackIp, isValidName } from "./util.ts";

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

  if (path === "/api/directories" && method === "GET") {
    return json({ directories: listDirectories(config), canManage: canManageDirectories(config) });
  }

  // Browse the server's filesystem (subdirectories only), bounded to browseRoot,
  // so the UI can pick where to create/register a project.
  if (path === "/api/browse" && method === "GET") {
    if (!canManageDirectories(config)) return json({ error: "Browsing disabled" }, 403);
    return json(await browse(config, url.searchParams.get("path") ?? undefined));
  }

  // Create a new project (`{path, name}` → scaffold `<path>/<name>`) or register
  // an existing folder (`{path}` → register it as-is). `path` is the folder the
  // user browsed to; addDirectory bounds it to browseRoot.
  if (path === "/api/directories" && method === "POST") {
    if (!canManageDirectories(config)) return json({ error: "Directory management disabled" }, 403);
    const body: Record<string, unknown> = await readJsonLimited(req).catch(() => ({}));
    const dirPath = body.path;
    if (typeof dirPath !== "string" || !dirPath.startsWith("/")) return json({ error: "Invalid path" }, 400);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    if (name !== undefined && !isValidName(name)) return json({ error: "Invalid name" }, 400);
    try {
      return json({ directory: await addDirectory(config, { path: dirPath, name }) }, 201);
    } catch (e) {
      return json({ error: isError(e) ? e.message : "Could not add directory" }, 400);
    }
  }

  const dirDel = path.match(/^\/api\/directories\/([A-Za-z0-9_-]+)$/);
  if (dirDel && method === "DELETE") {
    const ok = await removeDirectory(config, dirDel[1]); // unregisters only; files are kept
    return json({ ok }, ok ? 200 : 404);
  }

  if (path === "/api/sessions" && method === "GET") {
    return json({ sessions: listSessions() });
  }

  if (path === "/api/sessions" && method === "POST") {
    const body: Record<string, unknown> = await readJsonLimited(req).catch(() => ({}));
    const dirName = body.dir;
    if (typeof dirName !== "string" || !isValidName(dirName)) return json({ error: "Invalid directory" }, 400);
    const dir = resolveDir(config, dirName);
    if (!dir) return json({ error: "Unknown directory" }, 400);
    try {
      return json({ session: await spawnSession(config, dir) }, 201);
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
    try {
      const data = await Deno.readFile(s.logPath);
      return new Response(data, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${s.info.name}.log"`,
        },
      });
    } catch {
      return json({ error: "Not found" }, 404);
    }
  }

  const diff = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/diff$/);
  if (diff && method === "GET") {
    const s = getSession(diff[1]);
    if (!s) return json({ error: "Not found" }, 404);
    // For server-spawned sessions the path is server-controlled (config /
    // browseRoot); defense-in-depth: only diff a still-registered directory, so a
    // stale/unregistered dir is a clean 409 rather than a stray git run. External
    // sessions aren't in the registry — their path came from a token-authenticated
    // loopback registration; git runs read-only + scrubbed, so diff it directly.
    if (!s.info.external && !resolveDir(config, s.info.dir)) {
      return json({ error: "Directory no longer registered" }, 409);
    }
    return json(await gitDiff(s.info.path)); // gitDiff never throws (catches internally)
  }

  return json({ error: "Not found" }, 404);
}
