// HTTP routing. ZERO external imports.
//
// Overlay/HTML/state responses are Cache-Control: no-store (OBS must always see
// the live page); sprites are the one cacheable asset (immutable per build).

import type { OverlayConfig } from "./config.ts";
import type { OverlayState } from "./state.ts";
import type { SseHub } from "./sse.ts";
import type { SpriteStore } from "./sprites.ts";
import { handleControl } from "./control.ts";
import { type EffectQueue, handleEffects } from "./effects.ts";
import { handleIngest } from "./ingest.ts";
import {
  BADGES_HTML,
  CEMETERY_HTML,
  INDEX_HTML,
  PARTY_HTML,
  REDEEMS_HTML,
  renderGraveyardPage,
  renderStatusPage,
  TOASTS_HTML,
} from "./html.ts";
import { json } from "./util.ts";

export interface Deps {
  config: OverlayConfig;
  state: OverlayState;
  hub: Pick<SseHub, "connect" | "broadcastState" | "broadcastGame">;
  sprites: SpriteStore;
  effects: EffectQueue;
  token: string; // ingest token ("" = open): /ingest, /control, the mod-facing effect routes
  effectsToken: string; // multichat's Bearer on the loopback-only effect routes ("" = loopback alone)
}

function htmlPage(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// `peerIp` is the RAW socket peer (Deno.serve's info.remoteAddr, threaded in by
// main.ts) — it confines the multichat-facing effect routes to loopback. ""
// (unknown) is treated as NOT loopback.
export async function handler(req: Request, deps: Deps, peerIp = ""): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // The mod-facing ingest endpoint (wire protocol v1 — see protocol.ts).
  if (path === "/ingest") {
    return await handleIngest(req, {
      state: deps.state,
      hub: deps.hub,
      token: deps.token,
      maxBodyBytes: deps.config.maxBodyBytes,
    });
  }

  // The operator-facing control endpoint (sync attempt + reset campaign).
  // Shares the ingest token gate (it is destructive).
  if (path === "/control") {
    return await handleControl(req, {
      state: deps.state,
      hub: deps.hub,
      token: deps.token,
      maxBodyBytes: deps.config.maxBodyBytes,
    });
  }

  // Channel-point effects (effects.ts owns the sub-routes, methods, and both
  // auth rules): multichat enqueues/looks up/cancels/checks health over
  // loopback; the mod claims + reports results with the ingest token.
  if (path === "/effects" || path.startsWith("/effects/")) {
    return await handleEffects(req, url, {
      queue: deps.effects,
      hub: deps.hub,
      token: deps.token,
      effectsToken: deps.effectsToken,
      maxBodyBytes: deps.config.maxBodyBytes,
      peerIp,
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
  if (path === "/overlay/redeems") return htmlPage(REDEEMS_HTML);

  // Server-rendered scene (initial stones baked in; SSE appends the rest).
  if (path === "/overlay/graveyard") {
    const maxRaw = url.searchParams.get("max") ?? "";
    return htmlPage(renderGraveyardPage(deps.state.view(Date.now()), {
      tooltips: url.searchParams.get("tooltips") === "1",
      max: /^[0-9]+$/.test(maxRaw) ? parseInt(maxRaw, 10) : 0,
    }));
  }

  if (path === "/status") {
    const now = Date.now();
    return htmlPage(renderStatusPage(deps.state.view(now), {
      events: deps.state.recentEvents(),
      spriteCount: deps.sprites.count,
      tokenConfigured: deps.token !== "",
      staleAfterSec: deps.config.staleAfterSec,
      effects: {
        now,
        health: deps.effects.health(now),
        records: deps.effects.list(),
        modVersion: deps.effects.modVersion,
        tokenConfigured: deps.effectsToken !== "",
      },
    }));
  }

  if (path.startsWith("/sprites/")) {
    const name = path.slice("/sprites/".length);
    // No nested paths: the slug sanitizer strips "/" anyway, but reject early.
    if (name.includes("/")) return json({ error: "not found" }, 404);
    return await deps.sprites.serve(name, url.searchParams.get("dex"), {
      shiny: url.searchParams.get("shiny") === "1",
      aspects: (url.searchParams.get("form") ?? "").split(",").filter(Boolean),
    });
  }

  return json({ error: "not found" }, 404);
}
