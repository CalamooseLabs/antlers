# vibe

A configured **Claude Code** launcher plus a browser-based session manager,
exposed as one NixOS module (`nixosModules.vibe`) with two independently
`enable`-able halves:

- **`programs.vibe`** — installs a `vibe` command: Claude Code run against
  antlers-pinned settings, leaving your real `~/.claude` config untouched.
- **`services.vibe`** — runs the [`vibe-server`](../vibe-server/README.md) web UI
  that spawns/lists/kills `vibe` sessions in predefined directories, tails each
  session's log, and shows a per-session **git diff** in a modal. The browser
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

Example — install the `vibe` launcher system-wide, pinned to your plan's model:

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.vibe ];

  programs.vibe = {
    enable = true;                              # put `vibe` on PATH
    model = "opus[1m]";                         # latest Opus + 1M context
    effort = "high";
    remoteControl = { enable = true; name = "workstation"; };
    permissions.defaultMode = "acceptEdits";
  };
}
```

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

Sessions survive a service restart (re-adopted on boot); an unauthenticated
`/healthz` is exposed for liveness probes. See the
[`vibe-server` README](../vibe-server/README.md) for the service internals.

### Example: production behind a TLS reverse proxy

Bind to loopback, require TLS (so the app rejects any non-proxied plain-HTTP
request), and let nginx terminate TLS. `programs.vibe` pins flow to the web
sessions via the default `vibePackage`. `proxy_buffering off` keeps the live log
SSE stream flowing.

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.vibe ];

  programs.vibe = { model = "opus[1m]"; effort = "high"; };

  services.vibe = {
    enable = true;
    hostname = "127.0.0.1";                      # only the proxy reaches it
    requireTLS = true;                           # reject non-TLS (X-Forwarded-Proto)
    passwordFile = "/run/secrets/vibe-password";
    claudeConfigDir = "/var/lib/vibe/claude";
    sessionNamePrefix = "prod";                  # → session names like prod-antlers-a1b2
    extraEnv = [ "GITHUB_TOKEN" ];               # propagate this var into sessions
    directories = [
      { name = "antlers"; path = "/srv/projects/antlers"; }
      { name = "infra";   path = "/srv/projects/infra"; }
    ];
  };

  services.nginx = {
    enable = true;
    virtualHosts."vibe.example.com" = {
      forceSSL = true;
      enableACME = true;
      locations."/" = {
        proxyPass = "http://127.0.0.1:8420";
        extraConfig = ''
          proxy_buffering off;     # stream the SSE log tail
          proxy_read_timeout 1h;
        '';
      };
    };
  };
  security.acme = { acceptTerms = true; defaults.email = "admin@example.com"; };
}
```

### Example: API-key billing instead of a subscription

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.vibe ];

  programs.vibe.subscriptionAuth = false;        # keep ANTHROPIC_API_KEY (don't drop it)

  services.vibe = {
    enable = true;
    passwordFile = "/run/secrets/vibe-password";
    environmentFile = "/run/secrets/vibe-env";   # contains ANTHROPIC_API_KEY=…
    directories = [ { name = "work"; path = "/srv/work"; } ];
  };
}
```

### Quick-launch directories

`directories` is the heart of day-to-day use: a list of `{ name; path; }` entries
that the web UI turns into a **quick-launch list**. Each one is pre-registered —
pick it from the dropdown and click *Start session* to spin up a `vibe` session
(in Remote Control mode) in that directory, no typing required. Each session also
gets a per-session **Diff** button (a modal showing `git diff` of that working
tree) alongside its log.

```nix
services.vibe.directories = [
  { name = "antlers"; path = "/srv/projects/antlers"; }
  { name = "infra";   path = "/srv/projects/infra"; }
  { name = "notes";   path = "/home/me/notes"; }
];
```

`name` must match `[A-Za-z0-9_-]+` and `path` must be absolute (both enforced by
module assertions). These config-defined directories are **immutable** from the
UI. To let users add more at runtime, leave `projectsDir` set (the default) — the
UI's *Add directory* form then creates/registers directories under it (see
[below](#creating-projects-from-the-ui)). All a session needs to honour your
pinned model/effort is `vibePackage`, which defaults to the `programs.vibe`
launcher — so those pins flow to web sessions automatically.

### `services.vibe` options

| Option                    | Default                          | Notes                                                                       |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `enable`                  | `false`                          | run the web session manager                                                 |
| `port`                    | `8420`                           | port the web UI listens on                                                  |
| `hostname`                | `"0.0.0.0"`                      | bind address (use `"127.0.0.1"` behind a reverse proxy)                     |
| `passwordFile`            | — (required)                     | file holding the shared login password (read at runtime, never in the store) |
| `directories`             | `[]`                             | quick-launch `{ name; path; }` list (see above)                            |
| `vibePackage`             | the `programs.vibe` launcher     | the `vibe` package sessions are spawned with (carries the model/effort pins) |
| `package`                 | `vibe-server`                    | the server package to run                                                   |
| `sessionCommand`          | `vibe --remote-control @NAME@`   | command run per session; `@DIR@`/`@NAME@` substituted, cwd = chosen dir     |
| `remoteControl.enable`    | `true`                           | default `sessionCommand` launches in Remote Control mode (false → set a headless `sessionCommand`) |
| `extraEnv`                | `[]`                             | extra env-var **names** to propagate into sessions (values from the service env); everything else is dropped |
| `projectsDir`             | `"/var/lib/vibe/projects"`       | base dir the UI may create/register projects under; `null` disables UI directory management |
| `newProjectTemplate`      | the `vibe-shell` template        | template copied into a newly-created project (`null` → empty dir)           |
| `sessionNamePrefix`       | `""`                             | prefix for generated Remote Control session names (e.g. `"prod"`)          |
| `maxLogBytes`             | `26214400` (25 MiB)              | per-session captured-log size cap (`0` = unlimited; a cap, not rotation)    |
| `requireTLS`              | `false`                          | reject plain-HTTP requests (HTTP 426, except `/healthz`); set behind a TLS proxy |
| `claudeConfigDir`         | `null`                           | pre-seeded OAuth login dir (recommended subscription auth → `CLAUDE_CONFIG_DIR`) |
| `environmentFile`         | `null`                           | systemd `EnvironmentFile` (e.g. `ANTHROPIC_API_KEY=…` for API-key billing)  |
| `user` / `group`          | `"vibe"` / `"vibe"`              | service identity (only the default `vibe` user/group is auto-created)       |
| `openFirewall`            | `false`                          | open `port` in the firewall                                                 |
| `localNetworkOnly`        | `false`                          | when opening the firewall, restrict to LAN subnets only                     |
| `localNetworkSubnets`     | RFC1918 (`192.168/16`, `10/8`, `172.16/12`) | IPv4 subnets allowed when `localNetworkOnly`                     |
| `localNetworkSubnets6`    | ULA + link-local (`fc00::/7`, `fe80::/10`) | IPv6 subnets allowed when `localNetworkOnly`                      |
| `protectHome`             | `null` (auto)                    | systemd `ProtectHome`; auto `false` when a configured dir is under `/home`, else `"tmpfs"` |
| `enableNixLd`             | `true`                           | enable nix-ld so the compiled Deno binary can run                           |

All `programs.vibe` knobs (`model`, `effort`, `permissions`, `subscriptionAuth`,
`remoteControl.name`, `extraSettings`, `extraArgs`) shape the launcher that
`vibePackage` defaults to, so they apply to web sessions too.

### Creating projects from the UI

When `projectsDir` is set (the default), the
web UI's *Add directory* form creates `projectsDir/<name>` — scaffolding it from
the `vibe-shell` template (`newProjectTemplate`) and `git init`-ing it when it
doesn't exist, or just registering it when it does. User-added directories
persist across restarts (`stateDir/directories.json`) and can be unregistered
from the UI (files are kept on disk); config-defined `directories` are immutable.

> Note: `templates/vibe-shell/` is unrelated (a dev-shell template, no `vibe`
> command).
