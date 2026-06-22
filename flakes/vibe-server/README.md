# vibe-server

The Deno web service behind **`services.vibe-server`** — a small **lifecycle manager**
for Claude Code sessions. An optional shared-password login (passwordless when no
`passwordFile` is set) gates a single-page UI that lists **presets** (defined on
`programs.vibe.presets`; see [Presets](#presets)), spawns a `vibe @<preset>` session
per chosen preset, lists/kills sessions, and streams each session's captured output
read-only. A `vibe` you run **by hand** on the server self-registers and shows up
here too (see [Manual sessions](#manual-sessions)). You actually *drive* a session from
[claude.ai/code](https://claude.ai/code) or the mobile app — the browser only
manages lifecycle.

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
  imports = [
    inputs.antlers.nixosModules.vibe         # programs.vibe — defines the presets
    inputs.antlers.nixosModules.vibe-server
  ];

  # Launch targets are presets defined on the launcher (they supersede the old
  # `services.vibe-server.directories`); vibe-server reads them.
  programs.vibe.enable = true;
  programs.vibe.presets.antlers = {
    directories = [ "/srv/projects/antlers" ];     # first = cwd; more → claude --add-dir
  };

  services.vibe-server = {
    enable = true;
    passwordFile = "/run/secrets/vibe-password";   # shared login password (omit for passwordless)
    claudeConfigDir = "/var/lib/vibe/claude";       # pre-seeded OAuth login (subscription)
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
  "presets": [ { "name": "antlers", "directories": [ "/srv/projects/antlers" ], "branch": "", "pushRemote": "", "commitRequiresTouch": false, "pushRequiresTouch": false } ],
  "sessionCommand": [ "/nix/store/…-vibe/bin/vibe", "@PRESET@", "--remote-control", "@NAME@" ],
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

## Presets

Launch targets are **presets**, defined on the launcher (`programs.vibe.presets`)
and **shared** with vibe-server — they supersede the old per-server `directories`
(import `nixosModules.vibe` alongside `nixosModules.vibe-server`). Each preset is a
named bundle of one-or-more directories plus optional branch / launcher pins /
Commit & Push settings; the UI turns them into a quick-launch dropdown — pick one,
click *Start session*, and vibe-server spawns `vibe @<preset>` (Remote Control) in
the preset's **first** directory, with the rest added via `claude --add-dir`. Each
session gets a per-session **Diff** button (a `git diff` modal) alongside its log.

```nix
programs.vibe.presets = {
  antlers = {
    directories = [ "/srv/projects/antlers" "/srv/projects/shared-lib" ]; # cwd, then --add-dir
    branch = "vibe";            # commits/pushes land here (see Commit & Push)
    effort = "xhigh";           # per-preset launcher pin (null fields inherit programs.vibe.*)
  };
  notes = { directories = [ "/home/me/notes" ]; };
};
```

vibe-server reads `config.programs.vibe.presets` and makes **every** preset
directory writable (added to the systemd `ReadWritePaths`; otherwise
`ProtectSystem = strict` would make them read-only). Preset names must match
`[A-Za-z0-9_-]+` and directories must be absolute (module assertions). Presets are
**config-defined** — there is no runtime "add directory" browser (it was removed
when presets superseded `directories`); add a preset and rebuild. `vibe @<preset>`
also works directly in a terminal — see the [vibe README](../vibe#presets).

## Manual sessions

A `vibe` you run **by hand** on the same host shows up in the session list too:
when vibe-server is running it drops a discovery file at `/run/vibe/endpoint.json`
(URL + token, mode 0644) and the `vibe` launcher reads it and self-registers
(`POST /api/register`, gated by a **loopback peer + the token**), heartbeats while
it runs, and deregisters on exit. Such a session is listed with its directory,
status and a **Diff** button, but has **no captured-log tail** (its output is in
your terminal / claude.ai) and **no Kill button** (manage it from its own
terminal). Server-spawned sessions set `VIBE_MANAGED=1` and skip self-registration;
opt out per-run with `VIBE_NO_REGISTER=1`. Manual sessions are *not* persisted
across a vibe-server restart (they keep running; they just re-register on rerun),
and the reaper retires them ~90s after their heartbeats stop.

## Session status & activity

Each session row carries two independent signals plus a token count:

- **A colored dot (far left) — the process lifecycle.** 🟢 green = running · 🟡
  yellow = booting (the startup window between spawn and first output) or
  terminating · 🔴 red = failed · ⚪ gray outline = exited.
- **A status pill — the AI interaction state** while running: **ready** (waiting for
  your input), **thinking** (the model is working), or **completed** (a turn just
  finished). For a non-running session the pill shows the process status instead.
- **A live token count** (`↑ N tokens`) when one is known, and a per-row **Details**
  button — a modal listing preset, status, state, tokens, model, effort,
  directories, branch, created-at, pid, and the launch command.

The interaction state comes from two sources (hooks preferred):

1. **Claude Code hooks (authoritative).** The launcher bakes `UserPromptSubmit` →
   thinking, `Stop` → completed, and `Notification` (idle) → ready hooks into the
   session's `settings.json`. They fire **locally even for `--remote-control`
   sessions**, and POST to a loopback callback (`POST /api/session-state`, gated by
   the same loopback-peer + discovery-token as `/api/register`). vibe-server injects
   `VIBE_STATE_URL` / `VIBE_STATE_TOKEN` / `VIBE_SESSION_ID` into each spawned
   session's env so the hook — a bundled, curl-only `vibe-report-state` script — can
   reach it. It no-ops for interactive / hand-run `vibe` (no env injected), so those
   sessions are unaffected.
2. **Output scrape (fallback).** Until a hook reports, vibe-server infers
   thinking-vs-ready from the captured terminal (the TUI's `esc to interrupt` /
   `✻ …` spinner vs an idle `❯` prompt) and reads the `↑ N tokens` count. This is a
   best-effort heuristic over Claude Code's undocumented TUI, so hooks override it;
   it can't tell **completed** from **ready** (only the `Stop` hook can).

Both update on the table's ~3s poll. Re-adopted sessions (after a service restart)
keep their last-known state until a hook fires again — there's no live PTY to scrape.

## Commit & Push

> **Off by default** (`commitPush.enable = false`). This is the **only** feature
> that lets vibe-server *mutate* a repo — everything else (the diff view) is
> strictly read-only. Turning it on is a deliberate security trade-off; read this
> whole section first.

When enabled, each running **server-spawned** session grows a **Commit & Push**
button. It opens a modal with a commit-message box (pre-filled with a suggested
message — see below), a **YubiKey PIN** field, a
*Push after committing* toggle, and — for a preset that spans more than one
directory — an *Apply to all directories* toggle. On submit the server runs, in
each selected directory, `git add -A`, then `git commit -S` (a real OpenPGP
signature by *your* key — no AI/“Co-Authored-By” trailer), then optionally
`git push`. It's a remote analogue of the `gcommit` flow: the human still
authorizes each commit by entering the card PIN.

**How the PIN reaches the card.** The PIN you type is written to a `0600` file on
**tmpfs** (`/run/vibe`, never persistent disk), and git is run with
`-c gpg.program=<vibe-gpg>` + `VIBE_PIN_FILE=<that file>`; the bundled `vibe-gpg`
wrapper feeds it to gpg via `--pinentry-mode loopback --passphrase-file` for **one
signing attempt** (never retried — a wrong PIN counts toward the card's 3-strike
lockout), and the file is deleted immediately after. The PIN never touches argv,
the captured log, or disk.

**All directories in a preset.** A preset can span several directories (the first
is the session's working dir; the rest are the launcher's `claude --add-dir`'d
repos). With *Apply to all directories* checked — the default for a multi-dir
preset — the commit + push runs in **every** directory the preset lists, each an
independent repo, with the same message and PIN; uncheck it to act only on the
session's working dir. Directories are committed in order and the run **stops at
the first signing failure**: a wrong PIN is one strike toward the card's 3-strike
lockout, so vibe-server never feeds it to a second card. A directory that is
clean (or isn't a git repo) is skipped, not treated as an error; a per-directory
push failure is reported but doesn't stop the rest. The modal reports how many
directories committed. (Every preset directory is already in the unit's
`ReadWritePaths`, so no extra wiring is needed.)

**Suggested commit message.** When the modal opens it pre-fills the message box
(without ever clobbering text you've already typed). Two sources, in order: (1)
the **`GIT_COMMIT_MSG`** scratchpad at the session's working-dir root — the same
file the `gcommit` CLI reads and signs `-F` — if the in-session Claude wrote one
(for a multi-dir preset, the first directory that has one wins); (2) otherwise,
when `commitPush.generateMessage` is on (the default), a one-shot `claude -p`
**drafts** a message from the combined diff, reusing the service's Claude login.
Both are only *suggestions* — review and edit before committing. The draft path
costs tokens, so set `commitPush.generateMessage = false` to offer **only** the
scratchpad (no model call); the scratchpad is always offered regardless. Served
read-only by `GET /api/sessions/:id/suggest-message` (`{message, source}`).

**Target branch (per preset).** Each preset's `branch` (default `null`) decides where
its commits land: `null` commits on whatever branch the session is on — never
switches. Set `programs.vibe.presets.<name>.branch = "vibe"` and every web commit
for that preset is made on `vibe`: it's checked out before committing (created from
the current HEAD if it doesn't exist), and the push targets it explicitly with
tracking (remote = the preset's `pushRemote`, defaulting to `origin`). Note this
checks out the branch in the session's **live** working dir, so the running Claude
session sees the switch.

**Touch is the hard gate (per preset).** A physical touch can't be supplied from a
browser, so if your card's policy requires one, declare it on the preset and the
feature withholds that action: `commitRequiresTouch = true` hides the button
entirely; `pushRequiresTouch = true` keeps commit but drops the push step. The UI
gate is cosmetic — the server re-checks both (403) against the session's preset and
refuses external (hand-run) sessions and sessions whose preset is gone. (The global
`commitPush.enable` is the master switch; branch/push/touch are per-preset.)

**Host prerequisites** (the feature signs *server-side*, so the card must be
reachable by the service):

1. **Run as your login user.** The YubiKey, `~/.gnupg`, and `~/.gitconfig`
   (identity + `user.signingkey` + `commit.gpgsign`) belong to a login user, not
   the default `vibe` service user. Set `services.vibe-server.user = "you"` (keep
   `runAsRoot = false`). The module auto-derives `commitPush.home`/`gnupgHome` from
   that user, adds `~/.gnupg` to `ReadWritePaths`, and **relaxes `ProtectHome`** when
   `commitPush` is enabled — gpg-agent's socket lives under `/run/user/<uid>` (modern
   GnuPG), which `ProtectHome=tmpfs` would otherwise blank, so signing would fail.
2. **Allow non-interactive PIN entry.** Add `allow-loopback-pinentry` to that
   user's `~/.gnupg/gpg-agent.conf` and reload (`gpgconf --reload gpg-agent`).
3. **Keep the agent/card reachable** from a system service: `pcscd` running, and
   typically `loginctl enable-linger <user>` so the gpg-agent/card stay available.
4. **Push credentials must be non-interactive** (a stored token / credential
   helper, or pre-unlocked key) — a missing one fails fast (`GIT_TERMINAL_PROMPT=0`)
   rather than hanging the service. If push needs a YubiKey touch (e.g. an SSH key
   with a touch policy), set `pushRequiresTouch = true`.

```nix
programs.vibe.enable = true;
programs.vibe.presets.antlers = {
  directories = [ "/home/alice/antlers" ];
  branch = "vibe";                       # web commits land on this branch
  # pushRequiresTouch = true;            # if this preset's push key needs a touch
};
services.vibe-server = {
  enable = true;
  user = "alice";                        # the login user that owns the YubiKey
  commitPush.enable = true;              # master switch (per-preset branch/push/touch above)
};
```

> `git add -A` stages **all** non-ignored changes in the working tree (it won't add
> `.gitignore`'d files, but it stages more than the diff modal's capped preview
> shows). Review with the **Diff** button first.

## `services.vibe-server` options

| Option                    | Default                          | Notes                                                                       |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `enable`                  | `false`                          | run the web session manager                                                 |
| `port`                    | `8420`                           | port the web UI listens on                                                  |
| `hostname`                | `"0.0.0.0"`                      | bind address (use `"127.0.0.1"` behind a reverse proxy)                     |
| `passwordFile`            | `null` (passwordless)            | file holding the shared login password (read at runtime, never in the store). Null = passwordless: anyone who can reach the UI signs in automatically — set it (or restrict the network) when exposing beyond a trusted host |
| (launch targets)          | `programs.vibe.presets`          | **presets supersede `directories`** — define them on the vibe module (see [Presets](#presets)); vibe-server lists them + makes their dirs writable |
| `vibePackage`             | a default `vibe` launcher        | the `vibe` launcher package sessions are spawned with (preset-aware); override to pin model/effort/permissions/auth |
| `package`                 | `vibe-server`                    | the server package to run                                                   |
| `sessionCommand`          | `vibe @PRESET@ --remote-control @NAME@` | command run per session; `@PRESET@` (→ `@<name>`) / `@DIR@` / `@NAME@` substituted, cwd = the preset's first dir |
| `remoteControl.enable`    | `true`                           | default `sessionCommand` launches in Remote Control mode (false → set a headless `sessionCommand`) |
| `extraEnv`                | `[]`                             | extra env-var **names** to propagate into sessions (values from the service env); everything else is dropped |
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
| `commitPush.enable`       | `false`                          | master switch for the web **Commit & Push** button (see [Commit & Push](#commit--push)). Off by default; the one feature that lets the UI *mutate* repos. The per-preset `branch` / `pushRemote` / `commitRequiresTouch` / `pushRequiresTouch` live on `programs.vibe.presets.<name>` |
| `commitPush.gnupgHome`    | `null` → `<signing home>/.gnupg` | `GNUPGHOME` for the signing subprocess (card config); added to `ReadWritePaths` when enabled |
| `commitPush.home`         | `""` → derived from `user`       | `HOME` for the commit subprocess so git reads that user's `~/.gitconfig` (identity, signingkey) |
| `commitPush.generateMessage` | `true`                        | when the commit modal opens with no `GIT_COMMIT_MSG` scratchpad, draft a suggested message from the diff via a one-shot `claude -p` (reuses the service's Claude login). `false` = offer only the scratchpad (no model call / token spend); the scratchpad is always offered |

### Example: production behind a TLS reverse proxy

Bind to loopback, require TLS (so the app rejects any non-proxied plain-HTTP
request), and let nginx terminate TLS. `proxy_buffering off` keeps the live log
SSE stream flowing.

```nix
{ inputs, ... }:
{
  imports = [
    inputs.antlers.nixosModules.vibe
    inputs.antlers.nixosModules.vibe-server
  ];

  programs.vibe.enable = true;
  programs.vibe.presets = {
    antlers = { directories = [ "/srv/projects/antlers" ]; };
    infra = { directories = [ "/srv/projects/infra" ]; };
  };

  services.vibe-server = {
    enable = true;
    hostname = "127.0.0.1";                      # only the proxy reaches it
    requireTLS = true;                           # reject non-TLS (X-Forwarded-Proto)
    passwordFile = "/run/secrets/vibe-password";
    claudeConfigDir = "/var/lib/vibe/claude";
    sessionNamePrefix = "prod";                  # → session names like prod-antlers-a1b2
    extraEnv = [ "GITHUB_TOKEN" ];               # propagate this var into sessions
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
  imports = [ inputs.antlers.nixosModules.vibe inputs.antlers.nixosModules.vibe-server ];

  programs.vibe.enable = true;
  programs.vibe.presets.work = { directories = [ "/srv/work" ]; };

  services.vibe-server = {
    enable = true;
    passwordFile = "/run/secrets/vibe-password";
    environmentFile = "/run/secrets/vibe-env";   # contains ANTHROPIC_API_KEY=…
    # vibePackage = <a vibe launcher built for API-key billing>;
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
| `sessions.ts` | spawn, kill, snapshot/recover, login-URL scan, reaper; external (manually-run `vibe`) session register/heartbeat/deregister + the discovery token |
| `presets.ts`  | the launch presets (from programs.vibe.presets): `listPresets` + `resolvePreset` (config-defined; no runtime add/remove) |
| `diff.ts`     | read-only git working-tree diff (tracked + untracked) for the Diff modal |
| `commit.ts`   | the **only** mutating git path: stage + YubiKey-signed commit (+ push) per directory, multi-dir orchestration (`commitAndPushAll`, aborts on the first signing failure), capability predicates, PIN-via-tmpfs loopback signing (off unless `commitPush.enable`) |
| `suggest.ts`  | commit-message suggestion for the modal: read the `GIT_COMMIT_MSG` scratchpad, else draft one from the diff via `claude -p` (gated by `commitPush.generateMessage`) |
| `activity.ts` | heuristic interaction-state + token scraper over the captured TUI (`classifyScreen`/`parseTokens`): thinking vs ready + `↑ N tokens`. Best-effort fallback; hooks override it |
| `sse.ts`      | read-only SSE tail of a session log                                  |
| `http.ts`     | JSON responses + size-capped JSON body reader                        |
| `html.ts`     | the inlined single-page UI                                           |
| `router.ts`   | route table (public login/health + loopback register, then cookie-gated) |
| `util.ts`     | base64url, `BufferSource` cast, structured `log`, `isLoopbackIp`, pure path/name helpers (`normalizeAbs`/`withinRoot`/`sanitizeName`/`uniqueName`/`basenameOf`) |

## Tests (`app/test/`)

Offline `deno test` units + integration, wired into `nix flake check` as
`checks.<system>.vibe-server-unit` (no network — git backs the diff tests):

| File              | Covers                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `assert.ts`       | tiny zero-import assert helpers (keep tests import-free, see below)     |
| `util_test.ts`    | `b64url` round-trip, `isValidName`, `isError`                          |
| `auth_test.ts`    | cookie HMAC sign/verify + tamper/key-rotation, `passwordRequired`, `checkPassword`, login rate-limit |
| `claude_test.ts`  | `extractLoginUrl` (OAuth URL out of OSC-8 escapes), `parseAuthStatus`, `mergeOnboarding`, `extractLoginError`; `commitMessagePrompt` (no AI trailers) + `cleanGeneratedMessage` (strip fences/trailers) |
| `sessions_test.ts`| `shQuote` (shell-injection safety), `substitute` (`@DIR@`/`@NAME@`)    |
| `paths_test.ts`   | `normalizeAbs`/`withinRoot` (browse-root bounding, no `..` escape), `sanitizeName`, `uniqueName`, `basenameOf`, `isLoopbackIp` |
| `diff_test.ts`    | `gitDiff` against a temp repo: not-a-repo / clean / tracked change / untracked file / `.gitignore` exclusion |
| `commit_test.ts`  | `cleanMessage`/`cleanPin` validation, `commitArgs`/`pushArgs` (no injection), `canCommit`/`canPush` per-operation touch gating; `uniqueDirs` + `aggregateCommit` (multi-dir verdict: clean-skip, signing-abort, push-fail) |
| `suggest_test.ts` | `cleanSuggestion` (CRLF/trim) + `joinDiffsForPrompt` (only-changed-repos, labeled by path) |
| `activity_test.ts`| `parseTokens` (k/M scaling) + `classifyScreen` (thinking via `esc to interrupt`, ready via prompt/auto-mode, token scrape) |

Run locally: `cd app && deno test --allow-read --allow-write --allow-run --allow-env --no-lock test/`.
Tests **must stay import-free** (use `./assert.ts`, never `jsr:`/`npm:`/`@std`) so
they run offline and don't perturb the build's empty deno-cache FOD.

## Configuration

Read from `$VIBE_CONFIG` (default `/etc/vibe/config.json`), written by the NixOS
module: `port`, `hostname`, `stateDir`, `passwordFile`, `presets` (from
`programs.vibe.presets` — each `{name, directories, branch, pushRemote,
commitRequiresTouch, pushRequiresTouch}` plus the resolved launcher pins
`{model, effort, ultracode, permissionMode}` shown in the Details view),
`sessionCommand` (`@PRESET@` / `@DIR@` /
`@NAME@` substituted), `extraEnv` (extra env-var names to propagate), `requireTLS`
(reject non-TLS), `sessionNamePrefix`, `maxLogBytes` (per-session log cap),
`seedClaudeOnboarding` (seed `.claude.json` onboarding/trust), `claudeTheme`
(the seeded theme), and `commitPush` (global `{enable, gpgProgram, home,
gnupgHome, generateMessage}`). The Claude config dir itself is selected by the module via
`CLAUDE_CONFIG_DIR` (default `<stateDir>/.claude`), not this file.

## HTTP endpoints

| Method + path                         | Auth | Purpose                                   |
| ------------------------------------- | ---- | ----------------------------------------- |
| `GET /`                               | no   | the UI                                    |
| `GET /healthz`                        | no   | liveness probe (`{ok, sessions}`)         |
| `GET /api/auth-mode`                  | no   | `{passwordRequired}` — drives the login page |
| `POST /api/login` / `POST /api/logout`| no   | shared-password login (rate-limited; passwordless when unset) |
| `POST /api/register`                  | token | a local `vibe` self-registers (`{token,name,dir,pid}` → `{id,token}`); loopback peer only |
| `PUT /api/register`                   | token | external-session heartbeat (`{id,token}`); loopback only |
| `DELETE /api/register`                | token | external-session deregister (`{id,token}`); loopback only |
| `POST /api/session-state`             | token | a session's Claude Code hook reports its interaction state (`{id,token,state,tokens?}`, state ∈ ready/thinking/completed); loopback peer + discovery token only |
| `GET /api/me`                         | yes  | cookie check                              |
| `GET /api/claude-auth`                | yes  | Claude account auth status + in-flight login state |
| `POST /api/claude-auth/login`         | yes  | start (or rejoin) `claude auth login`; returns the OAuth URL |
| `DELETE /api/claude-auth/login`       | yes  | abort an in-flight login                  |
| `POST /api/claude-auth/code`          | yes  | submit the pasted authorization code (`{code}`) |
| `GET /api/presets`                    | yes  | the launch presets (from programs.vibe.presets) |
| `GET /api/sessions`                   | yes  | list sessions, each enriched with per-preset `canCommit` / `canPush` / `commitBranch` |
| `POST /api/sessions`                  | yes  | spawn a session for a preset (`{preset}`) |
| `GET /api/sessions/:id/suggest-message` | yes | a suggested commit message to pre-fill the modal — `{message, source}`, `source` ∈ `scratchpad` (`GIT_COMMIT_MSG`) / `generated` (`claude -p`) / `none`. Empty when commit isn't available for the preset |
| `POST /api/sessions/:id/commit-push`  | yes  | stage + YubiKey-signed commit (+ optional push) of the session's tree(s) (`{message,pin,push,applyAll}`; `applyAll` commits every preset directory, aborting on the first signing failure); returns per-directory `results[]`; 403 if disabled/touch-gated, 409 for external / preset-gone (see [Commit & Push](#commit--push)) |
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
- **Presets** — launch targets are config-defined presets (`programs.vibe.presets`,
  shared with the launcher); `GET /api/presets` lists them and `POST /api/sessions
  {preset}` spawns `vibe @<preset>` in the preset's first directory. There is no
  runtime directory browser / project creation (presets replaced the old
  `directories` + file browser); add a preset and rebuild.
- **Manual (external) sessions** — a `vibe` run by hand on the host self-registers
  via `POST /api/register` (gated by the loopback peer + the discovery-file token
  at `/run/vibe/endpoint.json`) and heartbeats; the server lists it with diff but
  no log tail / no Kill. Server-spawned sessions carry `VIBE_MANAGED=1` and skip
  this. The reaper retires an external session ~90s after its heartbeats stop
  (cross-user `/proc` is hidden by `ProtectProc=invisible`, so liveness rides on
  the heartbeat, not `pidAlive`).
- **Restart survival** — the running set of *server-spawned* sessions is
  snapshotted to `stateDir/sessions.json` (serialized writes) and re-adopted on
  boot. Re-adopted sessions have no `ChildProcess` handle, so a 30s reaper polls
  `/proc` to retire ones that have exited. Shutdown (SIGTERM/SIGINT) persists the
  snapshot and stops serving but **does not kill** sessions — Remote Control
  sessions should outlive a service restart. External (manually-registered)
  sessions are deliberately *not* snapshotted: they belong to a user's terminal
  and re-register themselves on rerun.
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
