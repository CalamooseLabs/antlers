// cobblemon-overlay — the Deno web service behind `services.cobblemon-overlay`.
//
// ZERO external imports across the whole app — required for the offline FOD
// build (see ../../package.nix). Every module under ./ uses only `Deno.*` and
// Web platform globals. Adding any `jsr:` / `npm:` / `https:` / `@std/*` import
// makes the deno-cache FOD output non-empty and breaks the sandboxed build.
// Local relative imports (`./state.ts`, …) are fine — they download nothing.
//
// What it does: ingests game-state pushes from The Cobblemon Initiative's
// streamsync subsystem (POST /ingest, wire protocol v1 — see protocol.ts),
// tracks hardcore attempts + the campaign memorial across save resets, persists
// to stateDir/state.json (debounced + atomic, flushed on SIGTERM/SIGINT), and
// serves transparent OBS browser-source overlay pages that follow the state
// live over SSE. Staleness is judged by SERVER receive time, never the mod's
// clock. Modules: config, protocol (the wire contract), ingest, state, sse,
// sprites, html, router, util — this file just wires them together.

import { loadConfig } from "./config.ts";
import { OverlayState } from "./state.ts";
import { SseHub, Watchdog } from "./sse.ts";
import { SpriteStore } from "./sprites.ts";
import { type Deps, handler } from "./router.ts";
import { isError, log } from "./util.ts";

async function main(): Promise<void> {
  const config = await loadConfig();

  // Ingest token (staged by systemd LoadCredential; see module.nix). A
  // configured-but-unreadable/empty token file is fatal — silently coming up
  // unauthenticated would defeat the point.
  let token = "";
  if (config.tokenFile) {
    try {
      token = (await Deno.readTextFile(config.tokenFile)).trim();
    } catch (e) {
      log("error", "cannot read tokenFile", {
        path: config.tokenFile,
        err: isError(e) ? e.message : String(e),
      });
      Deno.exit(1);
    }
    if (!token) {
      log("error", "tokenFile is empty", { path: config.tokenFile });
      Deno.exit(1);
    }
  }

  if (config.stateDir) {
    await Deno.mkdir(config.stateDir, { recursive: true }).catch(() => {});
  }

  const state = new OverlayState({
    stateDir: config.stateDir,
    eventLogSize: config.eventLogSize,
    staleAfterSec: config.staleAfterSec,
    persistDebounceMs: config.persistDebounceMs,
  });
  await state.load(); // restores as STALE (lastIngestAt = 0) until the mod pushes

  const sprites = new SpriteStore(config.spriteDir);
  await sprites.init();

  const watchdog = new Watchdog(config.staleAfterSec * 1000, () => state.lastIngestAt);
  const hub = new SseHub(() => state.view(Date.now()), watchdog);
  hub.startTimers();

  const ac = new AbortController();
  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down — flushing state", { sig });
    hub.stopTimers();
    state.flush()
      .catch((e) => log("error", "final flush failed", { err: isError(e) ? e.message : String(e) }))
      .finally(() => {
        ac.abort();
        setTimeout(() => Deno.exit(0), 200);
      });
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    try {
      Deno.addSignalListener(sig, () => shutdown(sig));
    } catch { /* signal not available in this context */ }
  }

  log("info", "cobblemon-overlay listening", {
    hostname: config.hostname,
    port: config.port,
    sprites: sprites.count,
    auth: token ? "token" : "open",
    stateDir: config.stateDir || "(persistence disabled)",
  });

  const deps: Deps = { config, state, hub, sprites, token };
  await Deno.serve(
    { port: config.port, hostname: config.hostname, signal: ac.signal, onListen: () => {} },
    (req) =>
      handler(req, deps).catch((e) => {
        log("error", "request error", { err: isError(e) ? e.message : String(e) });
        return new Response(JSON.stringify({ error: "Internal error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }),
  ).finished;
}

if (import.meta.main) {
  main();
}
