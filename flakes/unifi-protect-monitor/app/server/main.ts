// unifi-protect-monitor — the Deno web service behind `services.unifi-protect-monitor`.
//
// ZERO external imports across the whole app (only Deno.* + Web globals), so `deno
// compile` resolves a purely-local graph and the Nix build runs offline with
// --no-remote (no dep-vendoring FOD) — same discipline as antlers' vibe-server /
// robomoose. ffmpeg/ffprobe are subprocesses (a Nix runtime dep), not imports.
//
// It talks to the UniFi Protect Integration API (protect.ts), keeps live event state
// (events.ts), bridges RTSPS -> fMP4 -> the browser's MSE (stream.ts), and serves a
// dark, camera-first SPA (html.ts) via the router (router.ts).

import { consoleRoot, loadConfig, resolveApiKey, resolveRecordingPassword } from "./config.ts";
import { ProtectClient, type Camera } from "./protect.ts";
import { ProtectInternalClient } from "./protect-internal.ts";
import { StreamManager } from "./stream.ts";
import { EventHub } from "./events.ts";
import { AuthGate } from "./auth.ts";
import { handle, type ServerContext } from "./router.ts";
import { errMsg, log } from "./util.ts";

async function main(): Promise<void> {
  const cfg = await loadConfig();
  await Deno.mkdir(cfg.stateDir, { recursive: true }).catch(() => {});

  const apiKey = await resolveApiKey(cfg);
  if (!apiKey) {
    log("warn", "no API key configured (apiKey/apiKeyFile) — Protect calls will fail until one is set");
  }

  const client = new ProtectClient(cfg.consoleUrl, apiKey);

  // Best-effort startup health check — logs the Protect version or a clear reason so a
  // bad URL / key / cert shows up in the journal immediately (never fatal).
  client.metaInfo()
    .then((info) => log("info", "connected to Protect", { consoleUrl: cfg.consoleUrl, version: info.applicationVersion }))
    .catch((e) => log("warn", "Protect health check failed", { consoleUrl: cfg.consoleUrl, err: errMsg(e) }));

  const auth = new AuthGate();
  await auth.init(cfg);

  const streams = new StreamManager(cfg, client);
  const events = new EventHub(cfg, client);

  // Recorded playback (opt-in): a SEPARATE session-auth client for the internal API
  // (the X-API-KEY doesn't work there). Disabled unless a username + passwordFile are set.
  let internal: ProtectInternalClient | null = null;
  if (cfg.recordingsEnabled) {
    if (cfg.recordingUsername && cfg.recordingPasswordFile) {
      internal = new ProtectInternalClient(consoleRoot(cfg.consoleUrl), cfg.recordingUsername, () => resolveRecordingPassword(cfg));
      internal.healthCheck();
    } else {
      log("warn", "recordings enabled but recordingUsername/recordingPasswordFile missing — recorded playback disabled");
    }
  }

  // Shut the upstream subscriptions down cleanly on SIGTERM/SIGINT.
  const ac = new AbortController();
  const stop = () => ac.abort();
  try {
    Deno.addSignalListener("SIGTERM", stop);
    Deno.addSignalListener("SIGINT", stop);
  } catch { /* signals unavailable in some sandboxes */ }
  events.start(ac.signal);

  // 10s camera-list cache: cheap page loads, and it serves the last good list if the
  // API blips (so the wall doesn't go blank on a transient error).
  let camCache: { cams: Camera[]; exp: number } | null = null;
  const getCameras = async (): Promise<Camera[]> => {
    const now = Date.now();
    if (camCache && camCache.exp > now) return camCache.cams;
    try {
      const cams = await client.listCameras();
      camCache = { cams, exp: now + 10_000 };
      return cams;
    } catch (e) {
      if (camCache) return camCache.cams;
      throw e;
    }
  };

  const ctx: ServerContext = { cfg, client, streams, events, auth, getCameras, internal };

  Deno.serve(
    {
      port: cfg.port,
      hostname: cfg.hostname,
      signal: ac.signal,
      onListen: ({ hostname, port }) => log("info", "listening", { hostname, port, auth: auth.enabled }),
    },
    (req, info) => handle(req, ctx, info.remoteAddr),
  );
}

if (import.meta.main) {
  main().catch((e) => {
    log("error", "fatal", { err: errMsg(e) });
    Deno.exit(1);
  });
}
