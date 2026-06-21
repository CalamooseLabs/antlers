# vibe-server

The Deno web service behind **`services.vibe-server`** — a small **lifecycle manager**
for Claude Code sessions. An optional shared-password login (passwordless when no
`passwordFile` is set) gates a single-page UI that lists predefined directories,
spawns a `vibe` session in each (in Claude Code **Remote Control** mode),
lists/kills sessions, and streams each session's captured output read-only. You
actually *drive* a session from [claude.ai/code](https://claude.ai/code) or the
mobile app — the browser only manages lifecycle.

Exposed by the root flake as `packages.<system>.vibe-server`; its `ExecStart` is
wired up by `nixosModules.vibe-server` (`./module.nix`). Sessions are launched with
the `vibe` command from `services.vibe-server.vibePackage` (a default launcher
unless you override it — see the options below).

## Running it (NixOS)

You don't run `vibe-server` directly — it's a `deno compile` binary (a generic
ELF) that the `nixosModules.vibe-server` systemd unit launches under **nix-ld**.
(`nix run …#vibe-server` on NixOS fails with a `stub-ld` error for that reason —
that's expected; use the service.) Configure everything through `services.vibe-server`;
the module renders `/etc/vibe/config.json` (`$VIBE_CONFIG`) and wires the unit:

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.vibe-server ];

  services.vibe-server = {
    enable = true;
    passwordFile = "/run/secrets/vibe-password";   # shared login password (omit for passwordless)
    claudeConfigDir = "/var/lib/vibe/claude";       # pre-seeded OAuth login (subscription)
    directories = [
      { name = "antlers"; path = "/srv/projects/antlers"; }
    ];
    openFirewall = true;
    localNetworkOnly = true;                         # restrict to LAN subnets
  };
}
```

…which renders this `/etc/vibe/config.json` (defaults filled in by the module):

```json
{
  "port": 8420,
  "hostname": "0.0.0.0",
  "stateDir": "/var/lib/vibe",
  "passwordFile": "/run/secrets/vibe-password",
  "directories": [ { "name": "antlers", "path": "/srv/projects/antlers" } ],
  "sessionCommand": [ "/nix/store/…-vibe/bin/vibe", "--remote-control", "@NAME@" ],
  "projectsDir": "/var/lib/vibe/projects",
  "requireTLS": false,
  "sessionNamePrefix": "",
  "maxLogBytes": 26214400,
  "seedClaudeOnboarding": true,
  "claudeTheme": "dark"
}
```

To smoke-test the app from source without the module, point `$VIBE_CONFIG` at a
hand-written config and run `deno run -A src/main.ts`.

## Auth & billing

The service user must be authenticated to Claude before its sessions can do
anything. Three ways, in order of convenience:

1. **Log in from the web UI (subscription).** When the account isn't logged in,
   the UI shows a *"Log in to Claude"* banner. Click it and the server runs
   `claude auth login` for the service user: a modal gives you the Claude sign-in
   link, you authenticate and paste the code back, and the OAuth login is stored
   in the Claude config dir (`CLAUDE_CONFIG_DIR`, default `<stateDir>/.claude`).
   Every session spawned afterwards inherits it — you only do this once.
2. **Pre-seed `claudeConfigDir` (subscription).** Run `claude auth login` once as
   the service user, or copy an existing `~/.claude`, and point `claudeConfigDir`
   at it.
3. **API-key billing.** Set `environmentFile` to a file containing
   `ANTHROPIC_API_KEY=…` — and use a `vibePackage` launcher configured for API-key
   billing (the default launcher favours subscription OAuth and drops a stray
   `ANTHROPIC_API_KEY`).

**First-run prompts are handled for you.** A fresh Claude config otherwise blocks
every session on the first-run *theme picker* and the *workspace-trust* dialog.
The server seeds `<configDir>/.claude.json` (onboarding complete + `claudeTheme` +
trust for each configured/started directory) so sessions launch straight into
Remote Control. Disable with `seedClaudeOnboarding = false` if you manage the
config dir yourself. (The seed is written by the server process, whose write
scope is fixed at build time to `<stateDir>`, so it only applies when the config
dir is under `<stateDir>` — the default. A `claudeConfigDir` set elsewhere must be
pre-seeded; the module warns when that combination can't take effect.)

The web UI's own login is separate: a shared password (`passwordFile`) gates who
can reach the session manager. Leave `passwordFile` unset for a **passwordless**
UI (trusted host / loopback only) — see [Behavior notes](#behavior-notes). Note
the Claude-login flow is behind that gate, so anyone who can reach the UI can
authenticate the service user — keep the network restricted accordingly.

## Quick-launch directories

`directories` is the heart of day-to-day use: a list of `{ name; path; }` entries
that the web UI turns into a **quick-launch list**. Each one is pre-registered —
pick it from the dropdown and click *Start session* to spin up a `vibe` session
(in Remote Control mode) in that directory, no typing required. Each session also
gets a per-session **Diff** button (a modal showing `git diff` of that working
tree) alongside its log.

```nix
services.vibe-server.directories = [
  { name = "antlers"; path = "/srv/projects/antlers"; }
  { name = "infra";   path = "/srv/projects/infra"; }
  { name = "notes";   path = "/home/me/notes"; }
];
```

`name` must match `[A-Za-z0-9_-]+` and `path` must be absolute (both enforced by
module assertions). These config-defined directories are **immutable** from the
UI. To let users add more at runtime, leave `projectsDir` set (the default) — the
UI's *Add directory* form then creates/registers directories under it (see
[Directory management](#behavior-notes)).

## `services.vibe-server` options

| Option                    | Default                          | Notes                                                                       |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `enable`                  | `false`                          | run the web session manager                                                 |
| `port`                    | `8420`                           | port the web UI listens on                                                  |
| `hostname`                | `"0.0.0.0"`                      | bind address (use `"127.0.0.1"` behind a reverse proxy)                     |
| `passwordFile`            | `null` (passwordless)            | file holding the shared login password (read at runtime, never in the store). Null = passwordless: anyone who can reach the UI signs in automatically — set it (or restrict the network) when exposing beyond a trusted host |
| `directories`             | `[]`                             | quick-launch `{ name; path; }` list (see above)                            |
| `vibePackage`             | a default `vibe` launcher        | the `vibe` launcher package sessions are spawned with; override to pin model/effort/permissions/auth |
| `package`                 | `vibe-server`                    | the server package to run                                                   |
| `sessionCommand`          | `vibe --remote-control @NAME@`   | command run per session; `@DIR@`/`@NAME@` substituted, cwd = chosen dir     |
| `remoteControl.enable`    | `true`                           | default `sessionCommand` launches in Remote Control mode (false → set a headless `sessionCommand`) |
| `extraEnv`                | `[]`                             | extra env-var **names** to propagate into sessions (values from the service env); everything else is dropped |
| `projectsDir`             | `"/var/lib/vibe/projects"`       | base dir the UI may create/register projects under; `null` disables UI directory management |
| `newProjectTemplate`      | the `vibe-shell` template        | template copied into a newly-created project (`null` → empty dir)           |
| `sessionNamePrefix`       | `""`                             | prefix for generated Remote Control session names (e.g. `"prod"`)          |
| `maxLogBytes`             | `26214400` (25 MiB)              | per-session captured-log size cap (`0` = unlimited; a cap, not rotation)    |
| `requireTLS`              | `false`                          | reject plain-HTTP requests (HTTP 426, except `/healthz`); set behind a TLS proxy |
| `seedClaudeOnboarding`    | `true`                           | seed `.claude.json` (onboarding complete + theme + per-dir trust) so sessions don't block on Claude's first-run theme picker / trust dialog |
| `claudeTheme`             | `"dark"`                         | theme written into the seeded config (`dark`, `light`, `dark-daltonized`, …); only used when `seedClaudeOnboarding` |
| `claudeConfigDir`         | `null` → `<stateDir>/.claude`    | Claude config dir (`CLAUDE_CONFIG_DIR`) holding the OAuth login; log in from the UI, pre-seed it, or point at an existing login (recommended subscription auth) |
| `environmentFile`         | `null`                           | systemd `EnvironmentFile` (e.g. `ANTHROPIC_API_KEY=…` for API-key billing)  |
| `user` / `group`          | `"vibe"` / `"vibe"`              | service identity (only the default `vibe` user/group is auto-created)       |
| `runAsRoot`               | `false`                          | run the service + spawned sessions as root (ignores `user`/`group`); handy for accessing dirs owned by assorted users, at the cost of privilege separation |
| `openFirewall`            | `false`                          | open `port` in the firewall                                                 |
| `localNetworkOnly`        | `false`                          | when opening the firewall, restrict to LAN subnets only                     |
| `localNetworkSubnets`     | RFC1918 (`192.168/16`, `10/8`, `172.16/12`) | IPv4 subnets allowed when `localNetworkOnly`                     |
| `localNetworkSubnets6`    | ULA + link-local (`fc00::/7`, `fe80::/10`) | IPv6 subnets allowed when `localNetworkOnly`                      |
| `protectHome`             | `null` (auto)                    | systemd `ProtectHome`; auto `false` when a configured dir is under `/home`, else `"tmpfs"` |
| `enableNixLd`             | `true`                           | enable nix-ld so the compiled Deno binary can run                           |
| `pty`                     | `true`                           | allocate a PTY per session (via `script`) so interactive `claude --remote-control` doesn't fall into headless `--print` mode; disable only for a non-interactive `sessionCommand` |

### Example: production behind a TLS reverse proxy

Bind to loopback, require TLS (so the app rejects any non-proxied plain-HTTP
request), and let nginx terminate TLS. `proxy_buffering off` keeps the live log
SSE stream flowing.

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.vibe-server ];

  services.vibe-server = {
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
  imports = [ inputs.antlers.nixosModules.vibe-server ];

  services.vibe-server = {
    enable = true;
    passwordFile = "/run/secrets/vibe-password";
    environmentFile = "/run/secrets/vibe-env";   # contains ANTHROPIC_API_KEY=…
    # vibePackage = <a vibe launcher built for API-key billing>;
    directories = [ { name = "work"; path = "/srv/work"; } ];
  };
}
```

## Zero external imports (build constraint)

`app/src/` uses **only** `Deno.*` and Web platform globals (`crypto.subtle`,
`btoa`/`atob`, `TextEncoder`/`TextDecoder`, `fetch`, `Deno.serve`,
`Deno.Command`). It must stay that way:

- The build pre-resolves the Deno module graph as a **fixed-output derivation**
  (`denoCache`). With no remote deps the output is empty and the hash is stable.
- Local relative imports (`./auth.ts`, …) download nothing, so splitting the app
  into modules is free — the FOD stays empty.
- Adding any `jsr:` / `npm:` / `https:` / `@std/*` import makes the deno-cache
  output non-empty and **breaks the sandboxed offline build**. If you ever must
  add one, update `denoCache.outputHash` in `package.nix` (build once to get the
  `got:` hash, then paste it).

## Module layout (`app/src/`)

| File          | Responsibility                                                        |
| ------------- | -------------------------------------------------------------------- |
| `main.ts`     | wiring: load config, recover sessions, serve, signal/shutdown        |
| `config.ts`   | `ServerConfig` types, defaults, load from `/etc/vibe/config.json`     |
| `auth.ts`     | HMAC-signed cookie, constant-time password check, per-IP login throttle |
| `claude.ts`   | the `claude` CLI + config dir: spawn-env allowlist, `.claude.json` onboarding/theme/trust seeding, `auth status`, the interactive `auth login` flow |
| `sessions.ts` | spawn, kill, snapshot/recover, login-URL scan, reaper                  |
| `directories.ts` | runtime project dirs: create-from-template / register / unregister + persist |
| `diff.ts`     | read-only git working-tree diff (tracked + untracked) for the Diff modal |
| `sse.ts`      | read-only SSE tail of a session log                                  |
| `http.ts`     | JSON responses + size-capped JSON body reader                        |
| `html.ts`     | the inlined single-page UI                                           |
| `router.ts`   | route table (public login/health, then cookie-gated)                |
| `util.ts`     | base64url, `BufferSource` cast, structured `log`                     |

## Tests (`app/test/`)

Offline `deno test` units + integration, wired into `nix flake check` as
`checks.<system>.vibe-server-unit` (no network — git backs the diff tests):

| File              | Covers                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `assert.ts`       | tiny zero-import assert helpers (keep tests import-free, see below)     |
| `util_test.ts`    | `b64url` round-trip, `isValidName`, `isError`                          |
| `auth_test.ts`    | cookie HMAC sign/verify + tamper/key-rotation, `passwordRequired`, `checkPassword`, login rate-limit |
| `claude_test.ts`  | `extractLoginUrl` (OAuth URL out of OSC-8 escapes), `parseAuthStatus`, `mergeOnboarding`, `extractLoginError` |
| `sessions_test.ts`| `shQuote` (shell-injection safety), `substitute` (`@DIR@`/`@NAME@`)    |
| `diff_test.ts`    | `gitDiff` against a temp repo: not-a-repo / clean / tracked change / untracked file / `.gitignore` exclusion |

Run locally: `cd app && deno test --allow-read --allow-write --allow-run --allow-env --no-lock test/`.
Tests **must stay import-free** (use `./assert.ts`, never `jsr:`/`npm:`/`@std`) so
they run offline and don't perturb the build's empty deno-cache FOD.

## Configuration

Read from `$VIBE_CONFIG` (default `/etc/vibe/config.json`), written by the NixOS
module: `port`, `hostname`, `stateDir`, `passwordFile`, `directories`
(`{name,path}` — `name` must match `[A-Za-z0-9_-]+`), `sessionCommand` (`@DIR@` /
`@NAME@` substituted), `extraEnv` (extra env-var names to propagate),
`projectsDir` (base dir for UI-created projects, null disables), and
`newProjectTemplate` (template scaffolded into new projects), `requireTLS`
(reject non-TLS), `sessionNamePrefix`, `maxLogBytes` (per-session log cap),
`seedClaudeOnboarding` (seed `.claude.json` onboarding/trust), and `claudeTheme`
(the seeded theme). The Claude config dir itself is selected by the module via
`CLAUDE_CONFIG_DIR` (default `<stateDir>/.claude`), not this file.

## HTTP endpoints

| Method + path                         | Auth | Purpose                                   |
| ------------------------------------- | ---- | ----------------------------------------- |
| `GET /`                               | no   | the UI                                    |
| `GET /healthz`                        | no   | liveness probe (`{ok, sessions}`)         |
| `GET /api/auth-mode`                  | no   | `{passwordRequired}` — drives the login page |
| `POST /api/login` / `POST /api/logout`| no   | shared-password login (rate-limited; passwordless when unset) |
| `GET /api/me`                         | yes  | cookie check                              |
| `GET /api/claude-auth`                | yes  | Claude account auth status + in-flight login state |
| `POST /api/claude-auth/login`         | yes  | start (or rejoin) `claude auth login`; returns the OAuth URL |
| `DELETE /api/claude-auth/login`       | yes  | abort an in-flight login                  |
| `POST /api/claude-auth/code`          | yes  | submit the pasted authorization code (`{code}`) |
| `GET /api/directories`                | yes  | list directories (config + user-added) + `canManage` |
| `POST /api/directories`               | yes  | create-from-template or register (`{name}`) |
| `DELETE /api/directories/:name`       | yes  | unregister a user-added directory (files kept) |
| `GET /api/sessions`                   | yes  | list sessions                             |
| `POST /api/sessions`                  | yes  | spawn a session (`{dir}`)                 |
| `DELETE /api/sessions/:id`            | yes  | kill a session                            |
| `GET /api/sessions/:id/logs`          | yes  | SSE stream of the captured log            |
| `GET /api/sessions/:id/logs/download` | yes  | download the captured log (attachment)    |
| `GET /api/sessions/:id/diff`          | yes  | git diff of the session's working dir (JSON) |

## Behavior notes

- **Auth** — login compares SHA-256 digests in constant time; success sets an
  HMAC-signed cookie (7-day TTL). `Secure` is added only when the request arrived
  over TLS (`x-forwarded-proto: https`), so plain-HTTP LAN use still works.
  Failed logins are throttled per client IP with exponential backoff. With no
  `passwordFile` configured the service is **passwordless**: `/api/login` issues a
  cookie to anyone (no check, no throttle) and the UI signs in automatically —
  intended for a trusted host / loopback bind; gate the network otherwise.
- **Spawn** — each session runs under `setsid` (its own process group, so
  `kill(-pid)` reaps the tree). The spawn environment is **allowlisted**
  (`PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, … + `extraEnv`) so
  stray secrets don't leak into Claude Code or its browser-readable logs.
- **Claude account login** — the UI shows the service user's `claude auth status`
  as a banner; when not logged in, *"Log in to Claude"* drives the interactive
  `claude auth login` flow. The server spawns it under a PTY (util-linux `script`)
  with piped stdin, scans the output for the `claude.com` OAuth URL (surfaced as a
  link), and writes the pasted authorization code back into the PTY. Only one
  login runs at a time (auto-killed after 10 min if abandoned); on success the
  login is stored in the shared config dir so every subsequent session is
  authenticated. The whole flow is cookie-gated (see Auth & billing).
- **Onboarding seed** — when `seedClaudeOnboarding` is set (default), the server
  merges `hasCompletedOnboarding` + `claudeTheme` + per-directory
  `hasTrustDialogAccepted` into `<configDir>/.claude.json` (at startup for the
  configured dirs, and before each spawn for that session's dir), preserving any
  existing keys. Without it a fresh service user's sessions hang on Claude Code's
  first-run theme picker / workspace-trust dialog.
- **Login link** — if a session's early output contains a Claude/Anthropic OAuth
  URL (including the `claude.com` login host), it's captured as
  `SessionInfo.loginUrl` and rendered as a clickable link in the UI (host-validated
  client- and server-side). With the account-level login above this is rarely
  needed, but it still surfaces a per-session prompt if one appears.
- **Diff viewer** — `GET /api/sessions/:id/diff` returns a JSON `DiffResult`
  (`{ isRepo, branch?, empty, diff, truncated, error? }`) for the session's
  working directory, rendered by the UI's per-session **Diff** modal (responsive,
  collapsible per-file cards, +/- stats, colored lines). git runs **read-only**
  (never mutates the index/repo) via `Deno.Command` with a fixed argv, a scrubbed
  env (`GIT_OPTIONAL_LOCKS=0` so it never waits on `index.lock` while Claude
  writes; `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL=/dev/null`/`HOME=/var/empty` so
  a repo's `.git/config` aliases/hooks can't run; `--no-ext-diff`/`--no-textconv`
  on **both** diff invocations so no attacker-controlled external-diff/textconv
  program is exec'd; `core.bigFileThreshold` so one giant blob diffs as "binary"
  rather than emitting gigabytes), a `--` terminator on every argv (a file named
  `-x` is a path, not a flag), a 10s per-call timeout plus a 30s aggregate
  deadline, and byte/file caps (`truncated: true` when hit — note the tracked
  byte cap is applied after buffering, so it is `bigFileThreshold` + the timeouts
  that bound peak memory). It covers tracked changes/staged/deletions/renames
  (`git diff HEAD`, or `git diff --cached` on a not-yet-committed repo so freshly
  scaffolded projects still show their staged files) plus untracked,
  **non-ignored** files (per-file `git diff --no-index`; `.gitignore`'d files are
  never read or shown; binary files are shown as a labeled binary card without
  their raw content; untracked files larger than 256 KiB are skipped). Not-a-repo
  and a clean tree are normal 200 states
  (`isRepo: false` / `empty: true`), not errors. The diff body is rendered via
  `textContent` only, so a hostile filename/content cannot inject HTML.
  **Note:** like the log viewer, this is auth-gated and shows whatever is in the
  working tree — including the contents of *tracked-and-modified* secret files
  (e.g. a committed `.env`); anyone with the shared password can see them.
- **Directory management** — when `projectsDir` is configured, `POST
  /api/directories` creates `projectsDir/<name>` (scaffolded from
  `newProjectTemplate` + `git init`) or registers an existing one; user-added
  dirs persist to `stateDir/directories.json` and merge with the immutable
  config `directories`. `DELETE` only unregisters (files are kept). Names are
  validated `[A-Za-z0-9_-]+`, so created paths can't traverse out of `projectsDir`.
- **Restart survival** — the running set is snapshotted to
  `stateDir/sessions.json` (serialized writes) and re-adopted on boot. Re-adopted
  sessions have no `ChildProcess` handle, so a 30s reaper polls `/proc` to retire
  ones that have exited. Shutdown (SIGTERM/SIGINT) persists the snapshot and stops
  serving but **does not kill** sessions — Remote Control sessions should outlive
  a service restart.
- **Caps** — request bodies are size-capped (anti-OOM on the public login);
  retained sessions are capped (oldest terminated evicted, with their logs); each
  session's log is size-capped (`maxLogBytes`, default 25 MiB — appends stop past
  it with a truncation notice; a cap, not rotation, so the live SSE tail keeps
  working). `requireTLS` rejects plain-HTTP requests (426) except `/healthz`.
- **Kill lifecycle** — `DELETE` marks a running session `terminating`
  (SIGTERM, then SIGKILL after 5s); owned sessions flip to `exited`/`failed` via
  the child handle, re-adopted ones via the `/proc` reaper.

## Build

`package.nix` runs `deno compile` against `src/main.ts` (which pulls in the rest
of `app/src/`) for the host triple, using the FOD `denoCache` and the matching
`denort` runtime zip (both pinned by hash). The compiled ELF is left
unpatched/unstripped (`dontAutoPatchELF` / `dontStrip`); it runs at service time
via `nix-ld`. Targets `x86_64-linux` and `aarch64-linux`.

```sh
nix build .#vibe-server      # → ./result/bin/vibe-server
```
