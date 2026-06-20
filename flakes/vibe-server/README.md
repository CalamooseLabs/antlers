# vibe-server

The Deno web service behind [`services.vibe`](../vibe/README.md) — a small
**lifecycle manager** for Claude Code sessions. A shared-password login gates a
single-page UI that lists predefined directories, spawns a `vibe` session in each
(in Claude Code **Remote Control** mode), lists/kills sessions, and streams each
session's captured output read-only. You actually *drive* a session from
[claude.ai/code](https://claude.ai/code) or the mobile app — the browser only
manages lifecycle.

Exposed by the root flake as `packages.<system>.vibe-server`; its `ExecStart` is
wired up by `nixosModules.vibe` (`../vibe/module.nix`).

## Running it (NixOS)

You don't run `vibe-server` directly — it's a `deno compile` binary (a generic
ELF) that the `nixosModules.vibe` systemd unit launches under **nix-ld**.
(`nix run …#vibe-server` on NixOS fails with a `stub-ld` error for that reason —
that's expected; use the service.) Configure everything through `services.vibe`;
the module renders `/etc/vibe/config.json` (`$VIBE_CONFIG`) and wires the unit:

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.vibe ];

  services.vibe = {
    enable = true;
    passwordFile = "/run/secrets/vibe-password";   # shared login password
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
  "maxLogBytes": 26214400
}
```

See the [`vibe` module README](../vibe/README.md#servicesvibe-options) for the
full option set and more examples (TLS reverse proxy, API-key billing,
per-session env). To smoke-test the app from source without the module, point
`$VIBE_CONFIG` at a hand-written config and run `deno run -A src/main.ts`.

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
| `sessions.ts` | spawn (env-allowlisted), kill, snapshot/recover, login-URL scan, reaper |
| `directories.ts` | runtime project dirs: create-from-template / register / unregister + persist |
| `diff.ts`     | read-only git working-tree diff (tracked + untracked) for the Diff modal |
| `sse.ts`      | read-only SSE tail of a session log                                  |
| `http.ts`     | JSON responses + size-capped JSON body reader                        |
| `html.ts`     | the inlined single-page UI                                           |
| `router.ts`   | route table (public login/health, then cookie-gated)                |
| `util.ts`     | base64url, `BufferSource` cast, structured `log`                     |

## Configuration

Read from `$VIBE_CONFIG` (default `/etc/vibe/config.json`), written by the NixOS
module: `port`, `hostname`, `stateDir`, `passwordFile`, `directories`
(`{name,path}` — `name` must match `[A-Za-z0-9_-]+`), `sessionCommand` (`@DIR@` /
`@NAME@` substituted), `extraEnv` (extra env-var names to propagate),
`projectsDir` (base dir for UI-created projects, null disables), and
`newProjectTemplate` (template scaffolded into new projects), `requireTLS`
(reject non-TLS), `sessionNamePrefix`, and `maxLogBytes` (per-session log cap).

## HTTP endpoints

| Method + path                         | Auth | Purpose                                   |
| ------------------------------------- | ---- | ----------------------------------------- |
| `GET /`                               | no   | the UI                                    |
| `GET /healthz`                        | no   | liveness probe (`{ok, sessions}`)         |
| `POST /api/login` / `POST /api/logout`| no   | shared-password login (rate-limited)      |
| `GET /api/me`                         | yes  | cookie check                              |
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
  Failed logins are throttled per client IP with exponential backoff.
- **Spawn** — each session runs under `setsid` (its own process group, so
  `kill(-pid)` reaps the tree). The spawn environment is **allowlisted**
  (`PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, … + `extraEnv`) so
  stray secrets don't leak into Claude Code or its browser-readable logs.
- **Login link** — if a session's early output contains a Claude/Anthropic OAuth
  URL, it's captured as `SessionInfo.loginUrl` and rendered as a clickable link
  in the UI (host-validated client- and server-side) so the user can
  authenticate.
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
