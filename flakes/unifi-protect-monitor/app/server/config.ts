// Configuration loading. The NixOS module renders /etc/unifi-protect-monitor/config.json
// (pointed to by $UPM_CONFIG) with EXACTLY the keys below — parseConfig rejects unknown
// keys so a stray option surfaces at startup instead of being silently ignored. Every
// key also has an env override (UPM_*) for local `deno task dev`.

import { errMsg, log } from "./util.ts";

export type Quality = "high" | "medium" | "low" | "package";

export interface Config {
  port: number;
  hostname: string;
  stateDir: string;

  // ---- UniFi Protect Integration API ----
  // Base URL of the integration API, e.g.
  //   https://192.168.1.1/proxy/protect/integration           (local console)
  //   https://api.ui.com/v1/connector/consoles/<id>/proxy/protect/integration  (cloud)
  consoleUrl: string;
  // The X-API-KEY. Resolved from apiKeyFile (wins, runtime secret) or the inline apiKey.
  apiKey: string;
  apiKeyFile: string | null;

  // ---- streaming ----
  ffmpegPath: string;
  ffprobePath: string;
  // Qualities to ensure exist on the console (POST /rtsps-stream) when first requested.
  streamQualities: Quality[];
  // Quality used for grid tiles vs. the enlarged/focus single view.
  defaultQuality: Quality;
  focusQuality: Quality;

  // ---- web ----
  passwordFile: string | null;
  snapshotCacheMs: number;
  eventBufferPerCamera: number;

  // ---- recorded-video playback (OPT-IN; the INTERNAL Protect API, which needs a
  // local-admin session login — the X-API-KEY does NOT work there). All default off,
  // so an API-key-only deploy is unaffected. ----
  recordingsEnabled: boolean;
  recordingUsername: string;
  recordingPasswordFile: string | null;
  recordingChannel: number; // 0=high 1=medium 2=low
  maxClipDurationMs: number;
}

const DEFAULTS: Config = {
  port: 8460,
  hostname: "0.0.0.0",
  stateDir: "/var/lib/unifi-protect-monitor",
  consoleUrl: "https://192.168.1.1/proxy/protect/integration",
  apiKey: "",
  apiKeyFile: null,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  streamQualities: ["high", "medium", "low"],
  defaultQuality: "medium",
  focusQuality: "high",
  passwordFile: null,
  snapshotCacheMs: 2000,
  eventBufferPerCamera: 200,
  recordingsEnabled: false,
  recordingUsername: "",
  recordingPasswordFile: null,
  recordingChannel: 0,
  maxClipDurationMs: 120000,
};

const QUALITIES: Quality[] = ["high", "medium", "low", "package"];

function isQuality(x: unknown): x is Quality {
  return typeof x === "string" && (QUALITIES as string[]).includes(x);
}

// Validate + coerce a parsed JSON object into a Config. Rejects unknown keys.
export function parseConfig(raw: Record<string, unknown>): Config {
  const cfg: Config = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULTS)) {
      throw new Error(`unknown config key: ${k}`);
    }
    // deno-lint-ignore no-explicit-any
    (cfg as any)[k] = v;
  }
  // Normalise consoleUrl (no trailing slash — endpoints are joined as `${base}/v1/...`).
  cfg.consoleUrl = String(cfg.consoleUrl).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(cfg.consoleUrl)) {
    throw new Error(`consoleUrl must be an http(s) URL, got: ${cfg.consoleUrl}`);
  }
  if (!Array.isArray(cfg.streamQualities)) cfg.streamQualities = [...DEFAULTS.streamQualities];
  cfg.streamQualities = (cfg.streamQualities as unknown[]).filter(isQuality) as Quality[];
  if (cfg.streamQualities.length === 0) cfg.streamQualities = ["high", "medium", "low"];
  if (!isQuality(cfg.defaultQuality)) cfg.defaultQuality = "medium";
  if (!isQuality(cfg.focusQuality)) cfg.focusQuality = "high";
  cfg.port = Number(cfg.port) || DEFAULTS.port;
  cfg.snapshotCacheMs = Math.max(1, Math.floor(Number(cfg.snapshotCacheMs) || DEFAULTS.snapshotCacheMs));
  cfg.eventBufferPerCamera = Math.max(1, Math.floor(Number(cfg.eventBufferPerCamera) || DEFAULTS.eventBufferPerCamera));
  cfg.recordingsEnabled = cfg.recordingsEnabled === true;
  cfg.recordingChannel = [0, 1, 2].includes(Number(cfg.recordingChannel)) ? Number(cfg.recordingChannel) : 0;
  cfg.maxClipDurationMs = Math.max(1000, Math.floor(Number(cfg.maxClipDurationMs) || DEFAULTS.maxClipDurationMs));

  // Type-check the string/path fields so a wrong-typed hand-authored config.json surfaces
  // cleanly at startup instead of a confusing Deno.readTextFile/serve stack later.
  for (const k of ["hostname", "stateDir", "apiKey", "ffmpegPath", "ffprobePath", "recordingUsername"] as const) {
    if (typeof cfg[k] !== "string") throw new Error(`config ${k} must be a string`);
  }
  for (const k of ["apiKeyFile", "passwordFile", "recordingPasswordFile"] as const) {
    if (cfg[k] !== null && typeof cfg[k] !== "string") throw new Error(`config ${k} must be a string or null`);
  }
  return cfg;
}

// Normalise + validate the consoleUrl (trailing slash off, http(s) scheme). Shared so the
// env-override path gets the same guard the JSON path does.
function normalizeConsoleUrl(cfg: Config): void {
  cfg.consoleUrl = cfg.consoleUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(cfg.consoleUrl)) {
    throw new Error(`consoleUrl must be an http(s) URL, got: ${cfg.consoleUrl}`);
  }
}

function applyEnvOverrides(cfg: Config): Config {
  const env = (k: string) => Deno.env.get(k);
  const set = (v: string | undefined, f: (s: string) => void) => {
    if (v !== undefined && v !== "") f(v);
  };
  set(env("UPM_PORT"), (v) => (cfg.port = Number(v)));
  set(env("UPM_HOSTNAME"), (v) => (cfg.hostname = v));
  set(env("UPM_STATE_DIR"), (v) => (cfg.stateDir = v));
  set(env("UPM_CONSOLE_URL"), (v) => (cfg.consoleUrl = v.replace(/\/+$/, "")));
  set(env("UPM_API_KEY"), (v) => (cfg.apiKey = v));
  set(env("UPM_API_KEY_FILE"), (v) => (cfg.apiKeyFile = v));
  set(env("UPM_FFMPEG"), (v) => (cfg.ffmpegPath = v));
  set(env("UPM_FFPROBE"), (v) => (cfg.ffprobePath = v));
  set(env("UPM_PASSWORD_FILE"), (v) => (cfg.passwordFile = v));
  set(env("UPM_RECORDINGS_ENABLED"), (v) => (cfg.recordingsEnabled = v === "1" || v.toLowerCase() === "true"));
  set(env("UPM_RECORDING_USERNAME"), (v) => (cfg.recordingUsername = v));
  set(env("UPM_RECORDING_PASSWORD_FILE"), (v) => (cfg.recordingPasswordFile = v));
  set(env("UPM_RECORDING_CHANNEL"), (v) => (cfg.recordingChannel = Number(v)));
  return cfg;
}

// Load config from $UPM_CONFIG (JSON) if present, then apply env overrides.
export async function loadConfig(): Promise<Config> {
  const path = Deno.env.get("UPM_CONFIG") ?? "/etc/unifi-protect-monitor/config.json";
  let cfg: Config;
  try {
    const txt = await Deno.readTextFile(path);
    cfg = parseConfig(JSON.parse(txt) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      log("warn", "no config file — using defaults + env", { path });
      cfg = { ...DEFAULTS };
    } else {
      throw new Error(`failed to load config ${path}: ${errMsg(e)}`);
    }
  }
  const withEnv = applyEnvOverrides(cfg);
  normalizeConsoleUrl(withEnv); // re-validate so an env-sourced consoleUrl is checked too
  return withEnv;
}

// Resolve the effective API key: the file (a runtime secret, never in the Nix store)
// wins over an inline string. Read fresh so a rotated secret is picked up on restart.
export async function resolveApiKey(cfg: Config): Promise<string> {
  if (cfg.apiKeyFile) {
    try {
      return (await Deno.readTextFile(cfg.apiKeyFile)).trim();
    } catch (e) {
      throw new Error(`failed to read apiKeyFile ${cfg.apiKeyFile}: ${errMsg(e)}`);
    }
  }
  return cfg.apiKey.trim();
}

// Resolve the local-admin password for the internal recorded-video API. Read fresh so a
// rotated secret is honored on each (re)login. Empty when recordings aren't configured.
export async function resolveRecordingPassword(cfg: Config): Promise<string> {
  if (!cfg.recordingPasswordFile) return "";
  try {
    return (await Deno.readTextFile(cfg.recordingPasswordFile)).trim();
  } catch (e) {
    throw new Error(`failed to read recordingPasswordFile ${cfg.recordingPasswordFile}: ${errMsg(e)}`);
  }
}

// The console ROOT (e.g. https://10.10.10.251) derived from the integration consoleUrl —
// the internal API (/proxy/protect/api, /api/auth/login) lives directly under it.
export function consoleRoot(consoleUrl: string): string {
  return consoleUrl.replace(/\/proxy\/.*$/, "").replace(/\/+$/, "");
}
