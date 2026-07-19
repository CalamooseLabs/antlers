// HTTP + WebSocket routing. ZERO external imports.
//
//   GET  /healthz                    -> liveness (public)
//   GET  /                           -> the SPA
//   GET  /login  POST /api/login     -> shared-password login (when enabled)
//   POST /api/logout
//   GET  /api/cameras                -> camera list + UI defaults
//   GET  /snapshot/<id>              -> proxied JPEG (short cache)
//   WS   /ws/live/<id>/<quality>     -> fMP4 -> MSE live video (see stream.ts)
//   WS   /ws/events                  -> live event markers (see events.ts)

import { Config, Quality } from "./config.ts";
import { Camera, ProtectClient } from "./protect.ts";
import { StreamManager } from "./stream.ts";
import { EventHub } from "./events.ts";
import { AuthGate } from "./auth.ts";
import { clampClipWindow, ProtectInternalClient } from "./protect-internal.ts";
import { badRequest, errMsg, json, log, notFound, text, unauthorized } from "./util.ts";
import { INDEX_HTML, LOGIN_HTML } from "./html.ts";

export interface ServerContext {
  cfg: Config;
  client: ProtectClient;
  streams: StreamManager;
  events: EventHub;
  auth: AuthGate;
  getCameras: () => Promise<Camera[]>;
  // Internal-API client for recorded playback; null when recordings are disabled.
  internal: ProtectInternalClient | null;
}

const VALID_QUALITIES = ["high", "medium", "low", "package"];

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function isUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

// Requests from the local host itself are trusted (they can't cross the network), so the
// on-host kiosk works even when a passwordFile gates remote clients. See README.
function isLoopback(addr?: Deno.Addr): boolean {
  if (!addr || addr.transport !== "tcp") return false;
  const h = (addr as Deno.NetAddr).hostname;
  return h === "127.0.0.1" || h === "::1" || h === "::ffff:127.0.0.1";
}

export async function handle(req: Request, ctx: ServerContext, remoteAddr?: Deno.Addr): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path === "/healthz") return text("ok");

  // ---- auth gate (loopback — e.g. the on-host kiosk — is trusted) ----
  const authed = isLoopback(remoteAddr) || (await ctx.auth.isAuthed(req));
  const isPublic = path === "/login" || path === "/api/login";
  if (!authed && !isPublic) {
    if (path.startsWith("/api/") || path.startsWith("/ws/") || path.startsWith("/snapshot/")) {
      return unauthorized();
    }
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }

  // ---- pages / auth endpoints ----
  if (method === "GET" && path === "/") return html(INDEX_HTML);
  if (method === "GET" && path === "/login") return html(LOGIN_HTML);
  if (method === "POST" && path === "/api/login") return await ctx.auth.login(req);
  if (method === "POST" && path === "/api/logout") return ctx.auth.logout();

  // ---- camera list ----
  if (method === "GET" && path === "/api/cameras") {
    try {
      const cameras = await ctx.getCameras();
      return json({
        cameras,
        defaults: { defaultQuality: ctx.cfg.defaultQuality, focusQuality: ctx.cfg.focusQuality },
        auth: ctx.auth.enabled,
      });
    } catch (e) {
      return json({ error: errMsg(e), cameras: [] }, 502);
    }
  }

  // ---- snapshot proxy ----
  const snap = path.match(/^\/snapshot\/([^/]+)$/);
  if (method === "GET" && snap) {
    const id = decodeURIComponent(snap[1]);
    const highQuality = url.searchParams.get("highQuality") === "true";
    const channel = url.searchParams.get("channel") === "package" ? "package" : "main";
    try {
      const { bytes, contentType } = await ctx.client.getSnapshot(id, { channel, highQuality });
      return new Response(bytes, {
        headers: {
          "content-type": contentType,
          "cache-control": `max-age=${Math.max(1, Math.floor(ctx.cfg.snapshotCacheMs / 1000))}`,
        },
      });
    } catch (e) {
      return text(`snapshot error: ${errMsg(e)}`, 502);
    }
  }

  // ---- recorded playback (opt-in; 404 when recordings are disabled so the UI can
  // feature-detect). All three are under /api/, so the auth gate above already covers them. ----
  if (method === "GET" && path === "/api/recordings/coverage") {
    if (!ctx.internal) return notFound();
    try {
      const cov = await ctx.internal.getBootstrapCameras();
      const out: Record<string, unknown> = {};
      for (const [id, c] of cov) out[id] = c;
      return json({ coverage: out, channel: ctx.cfg.recordingChannel, maxClipMs: ctx.cfg.maxClipDurationMs });
    } catch (e) {
      // Keep upstream detail in the journal, not in the client body.
      log("warn", "recordings coverage failed", { err: errMsg(e) });
      return json({ error: "recordings upstream error", coverage: {} }, 502);
    }
  }

  // Scrubber hover thumbnail at an arbitrary recorded timestamp.
  const frame = path.match(/^\/api\/frame\/([^/]+)$/);
  if (method === "GET" && frame) {
    if (!ctx.internal) return notFound();
    const id = decodeURIComponent(frame[1]);
    const ts = Number(url.searchParams.get("ts"));
    if (!Number.isFinite(ts)) return badRequest("ts required");
    const wn = Number(url.searchParams.get("w"));
    const hn = Number(url.searchParams.get("h"));
    const w = Number.isFinite(wn) && wn > 0 ? Math.floor(wn) : undefined;
    const h = Number.isFinite(hn) && hn > 0 ? Math.floor(hn) : undefined;
    try {
      const { bytes, contentType } = await ctx.internal.recordingSnapshot(id, ts, w, h);
      return new Response(bytes, { headers: { "content-type": contentType, "cache-control": "max-age=30" } });
    } catch (e) {
      log("warn", "recordings frame failed", { err: errMsg(e) });
      return text("frame upstream error", 502);
    }
  }

  // Recorded clip for [start,end] — clamped to coverage and capped — streamed as MP4.
  const clip = path.match(/^\/api\/clip\/([^/]+)$/);
  if (method === "GET" && clip) {
    if (!ctx.internal) return notFound();
    const id = decodeURIComponent(clip[1]);
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    // Distinguish an omitted param (-> the configured channel) from an explicit channel=0.
    const chRaw = url.searchParams.get("channel");
    const chParam = chRaw === null || chRaw === "" ? NaN : Number(chRaw);
    const channel = [0, 1, 2].includes(chParam) ? chParam : ctx.cfg.recordingChannel;
    try {
      const coverage = (await ctx.internal.getBootstrapCameras()).get(id);
      const win = clampClipWindow(start, end, coverage, ctx.cfg.maxClipDurationMs);
      if (!win) return badRequest("invalid or out-of-coverage time window");
      // req.signal aborts the upstream fetch (establishment AND streaming) on client disconnect.
      const up = await ctx.internal.exportClip(id, win.start, win.end, channel, req.signal);
      if (!up.ok || !up.body) {
        await up.body?.cancel().catch(() => {});
        log("warn", "recordings export non-ok", { status: up.status });
        return text("clip upstream error", 502);
      }
      return new Response(up.body, {
        status: 200,
        headers: { "content-type": "video/mp4", "cache-control": "no-store", "accept-ranges": "none" },
      });
    } catch (e) {
      log("warn", "recordings clip failed", { err: errMsg(e) });
      return text("clip upstream error", 502);
    }
  }

  // ---- live video WS ----
  const live = path.match(/^\/ws\/live\/([^/]+)\/([^/]+)$/);
  if (live) {
    if (!isUpgrade(req)) return badRequest("expected websocket upgrade");
    const id = decodeURIComponent(live[1]);
    const quality = live[2];
    if (!VALID_QUALITIES.includes(quality)) return badRequest("bad quality");
    const { socket, response } = Deno.upgradeWebSocket(req);
    ctx.streams.serve(socket, id, quality as Quality);
    return response;
  }

  // ---- events WS ----
  if (path === "/ws/events") {
    if (!isUpgrade(req)) return badRequest("expected websocket upgrade");
    const { socket, response } = Deno.upgradeWebSocket(req);
    ctx.events.addSubscriber(socket);
    return response;
  }

  return notFound();
}
