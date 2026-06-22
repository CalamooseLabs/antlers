// Server configuration: types, defaults, and loading from /etc/vibe/config.json.

import { isError, log } from "./util.ts";

// A launch preset (sourced from programs.vibe.presets via the NixOS module — they
// SUPERSEDE the old `directories`). The FIRST directory is the session's working
// dir; the rest are reachable via the launcher's `claude --add-dir`. The launcher
// (`vibe @<name>`) applies the model/effort/etc. pins; the fields below are what
// vibe-server itself needs — directory wiring + the per-preset Commit & Push
// settings (a `*RequiresTouch` declares the card needs a physical touch for that
// op, which a browser can't supply, so the action is withheld).
export interface PresetConfig {
  name: string;
  directories: string[];
  branch: string; // "" = use whatever branch the dir is currently on (don't switch)
  pushRemote: string; // "" = the branch's configured upstream / origin
  commitRequiresTouch: boolean;
  pushRequiresTouch: boolean;
  // The launcher pins this preset resolves to (from programs.vibe.presets, with
  // nulls inherited from the globals). Informational only — vibe-server shows them
  // in the session Details view; the actual pinning happens in the launcher binary.
  // "" = unpinned / unknown.
  model: string;
  effort: string;
  ultracode: boolean;
  permissionMode: string;
}

// Global wiring for the "Commit & Push" feature (off by default). The per-preset
// branch / pushRemote / touch flags live on each PresetConfig; these are the
// service-wide bits: the master switch + the signing subprocess's env.
export interface CommitPushConfig {
  enable: boolean;
  // Absolute path to the gpg wrapper that injects loopback pinentry + the staged
  // PIN file (built by the NixOS module). "" = feature off / no PIN feeding.
  gpgProgram: string;
  // HOME for the commit/push subprocess (the signing user's home) so git reads
  // their ~/.gitconfig identity/signingkey and gpg their ~/.gnupg. "" = inherit.
  home: string;
  // GNUPGHOME for the signing subprocess (the card's config dir). "" = inherit.
  gnupgHome: string;
  // When the commit modal opens with no GIT_COMMIT_MSG scratchpad present, draft a
  // suggested message from the diff via a one-shot `claude -p` (reusing the
  // service's Claude auth). false = only the scratchpad is offered (no model call,
  // no token spend). The scratchpad is always read regardless of this flag.
  generateMessage: boolean;
}

export interface ServerConfig {
  port: number;
  hostname: string;
  stateDir: string;
  // Path to the shared-password file. Empty = passwordless login.
  passwordFile: string;
  // Launch presets (from programs.vibe.presets). The UI lists these; starting one
  // spawns `vibe @<name>` in its first directory.
  presets: PresetConfig[];
  sessionCommand: string[];
  // Extra environment-variable NAMES to propagate into spawned sessions, on top
  // of the built-in allowlist (see sessions.ts). Everything else is dropped.
  extraEnv: string[];
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
  // Seed the Claude config dir's .claude.json (hasCompletedOnboarding + theme +
  // per-directory trust) so a fresh service user's sessions don't block on the
  // first-run theme picker / workspace-trust dialog. See claude.ts.
  seedClaudeOnboarding: boolean;
  // Theme written into the seeded .claude.json (and settings.json) so Claude Code
  // doesn't prompt to pick one. One of Claude Code's theme names, e.g. "dark",
  // "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi".
  claudeTheme: string;
  // YubiKey-signed "Commit & Push" feature (off by default). See above.
  commitPush: CommitPushConfig;
}

export const DEFAULTS: ServerConfig = {
  port: 8420,
  hostname: "0.0.0.0",
  stateDir: "/var/lib/vibe",
  passwordFile: "",
  presets: [],
  sessionCommand: ["vibe", "@PRESET@", "--remote-control", "@NAME@"],
  extraEnv: [],
  requireTLS: false,
  sessionNamePrefix: "",
  maxLogBytes: 26214400, // 25 MiB
  pty: true,
  seedClaudeOnboarding: true,
  claudeTheme: "dark",
  commitPush: {
    enable: false,
    gpgProgram: "",
    home: "",
    gnupgHome: "",
    generateMessage: true,
  },
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
