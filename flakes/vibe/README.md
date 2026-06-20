# vibe

A configured **Claude Code** launcher plus a browser-based session manager,
exposed as one NixOS module (`nixosModules.vibe`) with two independently
`enable`-able halves:

- **`programs.vibe`** — installs a `vibe` command: Claude Code run against
  antlers-pinned settings, leaving your real `~/.claude` config untouched.
- **`services.vibe`** — runs the [`vibe-server`](../vibe-server/README.md) web UI
  that spawns/lists/kills `vibe` sessions in predefined directories. The browser
  is a **lifecycle manager** — you actually drive each session from
  [claude.ai/code](https://claude.ai/code) or the mobile app via Claude Code
  **Remote Control**.

Subscription-first: vibe targets Claude Code **Max / Team / Pro** plans (OAuth
login), not API pay-as-you-go. See [`assume-subscription-plans`](#auth--billing).

## Outputs

| Output                          | What it is                                                                 |
| ------------------------------- | ------------------------------------------------------------------------- |
| `lib.<system>.mkVibeWrapper`    | builder: `cfg → writeShellApplication "vibe"` (the zed-editor wrapper pattern) |
| `packages.<system>.vibe`        | the above with default config (ready to run)                              |
| `nixosModules.vibe`             | `programs.vibe` (launcher) + `services.vibe` (web session manager)         |

## The `vibe` command

```sh
vibe                       # interactive Claude Code with the pinned settings
vibe --remote-control [name]   # same, with Remote Control enabled (drive from claude.ai / mobile)
vibe --help                # usage + the pinned settings + `claude auth status`
vibe --show-config         # print the pinned settings.json and exit
```

Both modes run `claude --settings <generated>`; remote control just adds the
top-level **`--remote-control` flag** (not the `claude remote-control`
subcommand, which can't take `--settings`), so the pinned model/effort/permissions
apply to remote-control sessions too.

Runtime env overrides (no rebuild):

| Env var               | Effect                                                            |
| --------------------- | ---------------------------------------------------------------- |
| `VIBE_MODEL`          | override the pinned model for this run                            |
| `VIBE_EFFORT`         | override the pinned effort for this run                           |
| `VIBE_REMOTE_CONTROL` | force remote-control mode                                         |
| `VIBE_NAME`           | set the Remote Control session name                              |
| `VIBE_API_KEY_AUTH`   | keep a stray `ANTHROPIC_API_KEY` (opt out of subscription auth)   |

## Auth & billing

vibe assumes a **subscription** plan. `subscriptionAuth` (default `true`) makes
the wrapper drop a stray `ANTHROPIC_API_KEY` so a session uses the plan's OAuth
login (from `~/.claude` / `CLAUDE_CONFIG_DIR`) rather than silently billing the
API. For genuine API-key billing, set `programs.vibe.subscriptionAuth = false`
(or `VIBE_API_KEY_AUTH=1`).

1M Opus context (`opus[1m]`, the default `model`) is included on Max/Team; on Pro
it draws usage credits. Use `model = "opus"` for the standard 200K window.

## `programs.vibe` options

| Option                      | Default      | Notes                                                              |
| --------------------------- | ------------ | ----------------------------------------------------------------- |
| `enable`                    | `false`      | put `vibe` on `PATH`                                              |
| `package`                   | `null`       | override the built launcher (else built from the options below)   |
| `model`                     | `"opus[1m]"` | settings.json `model`; `"opus"` for 200K, `null` to leave unpinned |
| `effort`                    | `null`       | `low`/`medium`/`high`/`xhigh`/`max`                               |
| `permissions`               | `{}`         | Claude Code `permissions` object (delivered via `--settings`)     |
| `subscriptionAuth`          | `true`       | drop a stray `ANTHROPIC_API_KEY` (subscription billing)           |
| `remoteControl.enable`/`.name` | `false`/`null` | default to Remote Control mode + a display name             |
| `extraSettings`             | `{}`         | merged into the generated settings.json                          |
| `extraArgs`                 | `[]`         | appended to every `claude` invocation                            |

Use `lib.<system>.mkVibeWrapper { … }` to build a launcher outside the module.

## `services.vibe` (web session manager)

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.vibe ];

  services.vibe = {
    enable = true;
    passwordFile = "/run/secrets/vibe-password";     # shared login password
    claudeConfigDir = "/var/lib/vibe/claude";        # pre-seeded OAuth login (recommended)
    directories = [
      { name = "antlers"; path = "/srv/projects/antlers"; }
    ];
    openFirewall = true;
    localNetworkOnly = true;                          # restrict to LAN subnets
  };
}
```

Auth: for subscription plans, pre-seed `claudeConfigDir` with an OAuth `/login`
(run `claude` once as the service user, or copy its `~/.claude`). Only use
`environmentFile` with `ANTHROPIC_API_KEY=…` for API-key billing — and then also
set `programs.vibe.subscriptionAuth = false`, or the wrapper drops the key.

Key options beyond the above: `port` (8420), `hostname`, `directories`,
`vibePackage` (the launcher sessions are spawned with — defaults to the
`programs.vibe` build, so model/effort pins flow to web sessions),
`sessionCommand`, `extraEnv` (extra env-var names to propagate into sessions),
`projectsDir` (base dir for UI-created projects; default `/var/lib/vibe/projects`,
null disables), `newProjectTemplate` (template to scaffold from; default the
vibe-shell template),
`openFirewall`/`localNetworkOnly`/`localNetworkSubnets`/`localNetworkSubnets6`,
`requireTLS` (reject non-TLS, 426), `sessionNamePrefix`, `maxLogBytes`
(per-session log size cap), `protectHome`, `enableNixLd`. Sessions survive a service restart (re-adopted on boot); an
unauthenticated `/healthz` is exposed for liveness probes. See the
[`vibe-server` README](../vibe-server/README.md) for the service internals.

**Creating projects from the UI:** when `projectsDir` is set (the default), the
web UI's *Add directory* form creates `projectsDir/<name>` — scaffolding it from
the `vibe-shell` template (`newProjectTemplate`) and `git init`-ing it when it
doesn't exist, or just registering it when it does. User-added directories
persist across restarts (`stateDir/directories.json`) and can be unregistered
from the UI (files are kept on disk); config-defined `directories` are immutable.

> Note: `templates/vibe-shell/` is unrelated (a dev-shell template, no `vibe`
> command).
