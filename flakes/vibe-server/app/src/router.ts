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
} from "./auth.ts";
import {
  getSession,
  killSession,
  listSessions,
  sessionCount,
  spawnSession,
} from "./sessions.ts";
import {
  addDirectory,
  canManageDirectories,
  listDirectories,
  removeDirectory,
  resolveDir,
} from "./directories.ts";
import { streamLog } from "./sse.ts";
import { json, readJsonLimited } from "./http.ts";
import { INDEX_HTML } from "./html.ts";
import { isError, isValidName } from "./util.ts";

export async function handler(req: Request, config: ServerConfig, clientIp: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  // Mark the cookie Secure only when the request actually arrived over TLS
  // (directly or via a reverse proxy), so plain-HTTP LAN use still works.
  const secure = req.headers.get("x-forwarded-proto") === "https" || url.protocol === "https:";

  // When TLS is required, refuse plain-HTTP requests (except the liveness probe).
  if (config.requireTLS && !secure && path !== "/healthz") {
    return json({ error: "HTTPS required" }, 426);
  }

  if (path === "/" && method === "GET") {
    return new Response(INDEX_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // Unauthenticated liveness probe for monitoring / readiness checks.
  if (path === "/healthz" && method === "GET") {
    return json({ ok: true, sessions: sessionCount() });
  }

  if (path === "/api/login" && method === "POST") {
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

  // Everything below requires authentication.
  if (!await isAuthed(req)) return json({ error: "Unauthorized" }, 401);

  if (path === "/api/me" && method === "GET") return json({ ok: true });

  if (path === "/api/directories" && method === "GET") {
    return json({ directories: listDirectories(config), canManage: canManageDirectories(config) });
  }

  // Create (scaffold from the template if missing) or register a directory.
  if (path === "/api/directories" && method === "POST") {
    const body: Record<string, unknown> = await readJsonLimited(req).catch(() => ({}));
    const name = body.name;
    if (typeof name !== "string" || !isValidName(name)) return json({ error: "Invalid name" }, 400);
    try {
      return json({ directory: await addDirectory(config, name) }, 201);
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
    const ok = killSession(del[1]);
    return json({ ok }, ok ? 200 : 404);
  }

  const logs = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/logs$/);
  if (logs && method === "GET") {
    const s = getSession(logs[1]);
    if (!s) return json({ error: "Not found" }, 404);
    return streamLog(s.logPath);
  }

  const dl = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/logs\/download$/);
  if (dl && method === "GET") {
    const s = getSession(dl[1]);
    if (!s) return json({ error: "Not found" }, 404);
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

  return json({ error: "Not found" }, 404);
}
