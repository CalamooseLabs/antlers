// Server configuration: types, defaults, and loading from /etc/vibe/config.json.

import { isError, log } from "./util.ts";

export interface DirConfig {
  name: string;
  path: string;
}

export interface ServerConfig {
  port: number;
  hostname: string;
  stateDir: string;
  // Path to the shared-password file. Empty = passwordless login.
  passwordFile: string;
  directories: DirConfig[];
  sessionCommand: string[];
  // Extra environment-variable NAMES to propagate into spawned sessions, on top
  // of the built-in allowlist (see sessions.ts). Everything else is dropped.
  extraEnv: string[];
  // Base dir under which the web UI may create/register projects (null disables).
  projectsDir: string | null;
  // Template dir copied into a newly-created project (null = create an empty dir).
  newProjectTemplate: string | null;
  // Reject plain-HTTP requests (all but /healthz) — set when a TLS reverse proxy
  // fronts the service (it forwards x-forwarded-proto: https).
  requireTLS: boolean;
  // Prefix prepended to generated session names (tag prod/ci/etc.); "" = none.
  sessionNamePrefix: string;
  // Cap each session's captured log in bytes; 0 = unlimited. Appends stop past it.
  maxLogBytes: number;
  // Allocate a PTY for each session (via `script`) so interactive `claude
  // --remote-control` doesn't fall into headless `--print` mode. Disable only for
  // a genuinely non-interactive sessionCommand.
  pty: boolean;
}

export const DEFAULTS: ServerConfig = {
  port: 8420,
  hostname: "0.0.0.0",
  stateDir: "/var/lib/vibe",
  passwordFile: "",
  directories: [],
  sessionCommand: ["vibe", "--remote-control", "@NAME@"],
  extraEnv: [],
  projectsDir: null,
  newProjectTemplate: null,
  requireTLS: false,
  sessionNamePrefix: "",
  maxLogBytes: 26214400, // 25 MiB
  pty: true,
};

export async function loadConfig(): Promise<ServerConfig> {
  const path = Deno.env.get("VIBE_CONFIG") ?? "/etc/vibe/config.json";
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    log("error", "failed to load config", { path, err: isError(e) ? e.message : String(e) });
    Deno.exit(1);
  }
}
