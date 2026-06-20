// vibe-server — the web service behind `services.vibe`.
//
// ZERO external imports across the whole app — required for the offline FOD build
// (see ../../package.nix). Every module under ./ uses only `Deno.*` and Web
// platform globals (crypto.subtle, btoa/atob, TextEncoder/Decoder, fetch,
// Deno.serve). Adding any `jsr:` / `npm:` / `https:` / `@std/*` import makes the
// deno-cache FOD output non-empty and breaks the sandboxed build. Local relative
// imports (`./auth.ts`, …) are fine — they download nothing.
//
// Modules: config (load), auth (cookie/password/rate-limit), sessions
// (spawn/kill/snapshot/recover), sse (log tail), http (helpers), html (UI),
// router (routes). This file just wires them together and runs the server.
//
// What it does: a shared-password login (signed cookie) gates a small web UI
// that lists predefined directories, spawns `vibe` sessions in them (each in
// Claude Code Remote Control mode, driven from claude.ai / mobile), lists/kills
// those sessions, surfaces a login link if a session needs auth, and streams
// each session's captured output read-only over SSE. Sessions survive a
// vibe-server restart and are re-adopted on boot.

import { loadConfig } from "./config.ts";
import { getSecret, initKey } from "./auth.ts";
import { recoverSessions, saveSnapshot, startReaper } from "./sessions.ts";
import { loadUserDirs } from "./directories.ts";
import { handler } from "./router.ts";
import { isError, log } from "./util.ts";

async function main(): Promise<void> {
  const config = await loadConfig();
  await Deno.mkdir(config.stateDir, { recursive: true }).catch(() => {});
  await initKey(await getSecret(config.stateDir));

  await loadUserDirs(config.stateDir);
  const recovered = await recoverSessions(config.stateDir);
  startReaper(config.stateDir);

  const ac = new AbortController();
  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Persist the running set and stop accepting connections, but deliberately
    // do NOT kill sessions — Remote Control sessions should survive a restart;
    // recoverSessions() re-adopts them on the next boot.
    log("info", "shutting down (sessions left running for re-adoption)", { sig });
    saveSnapshot(config.stateDir).finally(() => ac.abort());
    setTimeout(() => Deno.exit(0), 500);
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    try {
      Deno.addSignalListener(sig, () => shutdown(sig));
    } catch { /* signal not available in this context */ }
  }

  log("info", "vibe-server listening", {
    hostname: config.hostname,
    port: config.port,
    directories: config.directories.map((d) => d.name),
    recovered,
  });

  await Deno.serve(
    { port: config.port, hostname: config.hostname, signal: ac.signal, onListen: () => {} },
    (req, info) => {
      const fwd = req.headers.get("x-forwarded-for");
      const ra = info.remoteAddr;
      const ip = (fwd ? fwd.split(",")[0].trim() : "") ||
        (ra && "hostname" in ra ? ra.hostname : "?");
      return handler(req, config, ip).catch((e) => {
        log("error", "request error", { err: isError(e) ? e.message : String(e) });
        return new Response(JSON.stringify({ error: "Internal error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      });
    },
  ).finished;
}

if (import.meta.main) main();
