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
// What it does: a shared-password login (signed cookie) gates a small web UI that
// lists directories (and can browse the host filesystem under browseRoot to
// create/register more), spawns `vibe` sessions in them, lists/kills those
// sessions, surfaces a login link if a session needs auth, and streams each
// session's captured output read-only over SSE. A `vibe` run by hand on the host
// also self-registers (loopback-gated POST /api/register, via the discovery file
// written below) so it shows up too. Server-spawned sessions survive a restart
// and are re-adopted on boot.

import { loadConfig, type ServerConfig } from "./config.ts";
import { getSecret, initKey } from "./auth.ts";
import { seedClaudeConfig } from "./claude.ts";
import { recoverSessions, saveSnapshot, setRegToken, startReaper } from "./sessions.ts";
import { loadUserDirs } from "./directories.ts";
import { handler } from "./router.ts";
import { b64url, isError, log } from "./util.ts";

// Drop a discovery file a locally-run `vibe` reads to find + authenticate to this
// server (POST /api/register, gated by this token + a loopback peer). systemd's
// RuntimeDirectory creates /run/vibe and wipes it on stop, so the file never goes
// stale; mode 0644 lets other local users (a hand-run `vibe`) read it. Best-effort
// — failure just means manual sessions won't appear in the UI.
async function writeEndpointFile(config: ServerConfig, token: string): Promise<void> {
  const dir = "/run/vibe";
  await Deno.mkdir(dir, { recursive: true }).catch(() => {});
  const file = `${dir}/endpoint.json`;
  await Deno.writeTextFile(file, JSON.stringify({ url: `http://127.0.0.1:${config.port}`, token }));
  await Deno.chmod(file, 0o644).catch(() => {});
}

async function main(): Promise<void> {
  const config = await loadConfig();
  await Deno.mkdir(config.stateDir, { recursive: true }).catch(() => {});
  await initKey(await getSecret(config.stateDir));

  // Per-process self-registration token + discovery file (see writeEndpointFile).
  const regToken = b64url(crypto.getRandomValues(new Uint8Array(24)));
  setRegToken(regToken);
  await writeEndpointFile(config, regToken).catch((e) =>
    log("warn", "could not write endpoint discovery file", { err: isError(e) ? e.message : String(e) })
  );

  // Seed onboarding-complete + theme + per-directory trust into the Claude config
  // dir so a fresh service user's sessions don't block on the theme picker /
  // workspace-trust dialog (no-op when seedClaudeOnboarding is false).
  await seedClaudeConfig(config);

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
      // peerIp is the real socket peer (used for the loopback-gated register
      // endpoint); ip prefers x-forwarded-for for logging / rate-limit keying.
      const peerIp = ra && "hostname" in ra ? ra.hostname : "";
      const ip = (fwd ? fwd.split(",")[0].trim() : "") || peerIp || "?";
      return handler(req, config, ip, peerIp).catch((e) => {
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
