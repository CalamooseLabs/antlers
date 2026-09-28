// Server configuration: types, defaults, and loading from
// /etc/cobblemon-overlay/config.json (override the path with
// COBBLEMON_OVERLAY_CONFIG). The auth tokens are NOT in the config file — they
// are file paths staged by systemd LoadCredential and pointed at via the
// COBBLEMON_OVERLAY_TOKEN_FILE (ingest) / COBBLEMON_OVERLAY_EFFECTS_TOKEN_FILE
// (multichat-facing effect routes) environment variables (see module.nix).

import { isError, log } from "./util.ts";

export interface OverlayConfig {
  port: number;
  hostname: string;
  // Where state.json lives ("" = persistence disabled — dev/test only). NOTE:
  // the compiled binary's --allow-write is scoped to /var/lib/cobblemon-overlay
  // at build time; a stateDir outside it only works under `deno run`.
  stateDir: string;
  // File whose (trimmed) contents are the shared ingest token; "" = no auth.
  // COBBLEMON_OVERLAY_TOKEN_FILE overrides (systemd LoadCredential path).
  tokenFile: string;
  // Seconds without an accepted ingest before the overlays fade to "stale".
  // Measured against SERVER receive time, never the mod's `t` field.
  staleAfterSec: number;
  // Rolling in-memory event ring size (the /status debug page's history).
  eventLogSize: number;
  // Max accepted POST /ingest body, bytes (larger → 413).
  maxBodyBytes: number;
  // Debounce for the atomic state.json persist (flushed on SIGTERM/SIGINT).
  persistDebounceMs: number;
  // Directory of <slug>.png box sprites (+ optional pokemon.json dex map);
  // "" = sprites disabled, overlay cards fall back to text.
  spriteDir: string;

  // ---- channel-point effect queue (effects.ts; persisted to stateDir/effects.json) ----
  // Master switch. false = POST /effects answers 503 "disabled" and nothing new
  // is leased to the mod (results/cancels/lookups still work, the sweeper still
  // expires what is left so multichat refunds it).
  effectsEnabled: boolean;
  // How long a claimed effect stays leased to the mod without an `accepted`
  // result before it returns to pending and is redelivered (the mod dedups by id).
  effectLeaseSec: number;
  // Default time-to-live of an enqueued effect when multichat sends no ttlSec
  // (a sent ttlSec is clamped to 30..3600).
  effectTtlSec: number;
  // POST /effects answers 503 "game_offline" unless the mod has polled
  // /effects/claim within this many seconds.
  effectAcceptWindowSec: number;
  // Max open (non-final) effects; more → POST /effects answers 429 "queue_full".
  maxOpenEffects: number;
  // File whose (trimmed) contents are the Bearer token multichat must present
  // on the loopback-only effect routes; "" = loopback alone is the gate.
  // COBBLEMON_OVERLAY_EFFECTS_TOKEN_FILE overrides (systemd LoadCredential path).
  effectsTokenFile: string;
}

export const DEFAULTS: OverlayConfig = {
  port: 8082,
  hostname: "0.0.0.0",
  stateDir: "/var/lib/cobblemon-overlay",
  tokenFile: "",
  staleAfterSec: 15,
  eventLogSize: 500,
  maxBodyBytes: 65536,
  persistDebounceMs: 2000,
  spriteDir: "",
  effectsEnabled: true,
  effectLeaseSec: 30,
  effectTtlSec: 600,
  effectAcceptWindowSec: 45,
  maxOpenEffects: 100,
  effectsTokenFile: "",
};

export async function loadConfig(): Promise<OverlayConfig> {
  const envPath = Deno.env.get("COBBLEMON_OVERLAY_CONFIG");
  const path = envPath ?? "/etc/cobblemon-overlay/config.json";
  let cfg: OverlayConfig = { ...DEFAULTS };
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    cfg = { ...cfg, ...parsed };
  } catch (e) {
    // An explicitly-pointed-at config that fails to load is fatal; the default
    // path merely missing falls back to defaults (handy for the dev loop).
    if (envPath) {
      log("error", "failed to load config", { path, err: isError(e) ? e.message : String(e) });
      Deno.exit(1);
    }
    log("warn", "no config file — using defaults", { path });
  }
  const tokenEnv = Deno.env.get("COBBLEMON_OVERLAY_TOKEN_FILE");
  if (tokenEnv) cfg.tokenFile = tokenEnv;
  const effectsTokenEnv = Deno.env.get("COBBLEMON_OVERLAY_EFFECTS_TOKEN_FILE");
  if (effectsTokenEnv) cfg.effectsTokenFile = effectsTokenEnv;
  return cfg;
}
