// HTTP routing. ZERO external imports.
//
// Overlay/HTML/state responses are Cache-Control: no-store (OBS must always see
// the live page); sprites are the one cacheable asset (immutable per build).

import type { OverlayConfig } from "./config.ts";
import type { OverlayState } from "./state.ts";
import type { SseHub } from "./sse.ts";
import type { SpriteStore } from "./sprites.ts";
import { handleIngest } from "./ingest.ts";
import { BADGES_HTML, CEMETERY_HTML, INDEX_HTML, PARTY_HTML, renderStatusPage, TOASTS_HTML } from "./html.ts";
import { json } from "./util.ts";

export interface Deps {
  config: OverlayConfig;
  state: OverlayState;
  hub: SseHub;
  sprites: SpriteStore;
  token: string;
}

function htmlPage(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // The mod-facing ingest endpoint (the only non-GET route).
  if (path === "/ingest") {
    return await handleIngest(req, {
      state: deps.state,
      hub: deps.hub,
      token: deps.token,
      maxBodyBytes: deps.config.maxBodyBytes,
    });
  }

  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  // Unauthenticated liveness probe (also handy from battlestation to verify
  // routed reachability + the /32 firewall rule).
  if (path === "/healthz") {
    const v = deps.state.view(Date.now());
    return json({ ok: true, live: v.live, lastIngestAt: v.lastIngestAt });
  }

  if (path === "/") return htmlPage(INDEX_HTML);

  if (path === "/events") return deps.hub.connect();

  if (path === "/api/state.json") {
    return json(deps.state.view(Date.now()), 200, { "cache-control": "no-store" });
  }

  if (path === "/overlay/party") return htmlPage(PARTY_HTML);
  if (path === "/overlay/cemetery") return htmlPage(CEMETERY_HTML);
  if (path === "/overlay/badges") return htmlPage(BADGES_HTML);
  if (path === "/overlay/toasts") return htmlPage(TOASTS_HTML);

  if (path === "/status") {
    return htmlPage(renderStatusPage(deps.state.view(Date.now()), {
      events: deps.state.recentEvents(),
      spriteCount: deps.sprites.count,
      tokenConfigured: deps.token !== "",
      staleAfterSec: deps.config.staleAfterSec,
    }));
  }

  if (path.startsWith("/sprites/")) {
    const name = path.slice("/sprites/".length);
    // No nested paths: the slug sanitizer strips "/" anyway, but reject early.
    if (name.includes("/")) return json({ error: "not found" }, 404);
    return await deps.sprites.serve(name, url.searchParams.get("dex"));
  }

  return json({ error: "not found" }, 404);
}
