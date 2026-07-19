// Server configuration: types, defaults, and loading from
// /etc/cobblemon-overlay/config.json (override the path with
// COBBLEMON_OVERLAY_CONFIG). The ingest auth token is NOT in the config file —
// it is a file path staged by systemd LoadCredential and pointed at via the
// COBBLEMON_OVERLAY_TOKEN_FILE environment variable (see module.nix).

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
  return cfg;
}
