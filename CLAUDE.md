# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Antlers is a single-flake Nix monorepo of reusable packages and templates for Calamoose Labs / NKC. There is no application code. It targets `x86_64-linux` only (hardcoded). Layout:

- `flakes/` — package definitions as plain `callPackage`-able `package.nix` files (e.g. a wrapped `zed-editor`, a fixed `plex-desktop`, the `antlers` CLI). **Not** flakes themselves.
- `templates/` — `nix flake init`/`new` templates, registered in `templates/templates.nix`. Most are LaTeX/SC-IM document builders.
- `scripts/` — currently empty (placeholder).

**The root `flake.nix` is the single aggregator** — it exposes every package and template by attribute. Consumers grab one thing with `#<name>` (packages) or `-t #<name>` (templates). There is one branch (`master`); there are deliberately **no per-package branches** — with any `github:` ref Nix downloads the whole repo tarball regardless, so branches reduce nothing and only add merge maintenance. Everything assumes [direnv](https://direnv.net) + flakes: dirs with an `.envrc` (`use flake`) auto-load a dev shell (`direnv allow`).

## Common commands

```sh
# Work ON antlers
direnv allow              # or: nix develop   (root dev shell ships claude-code)
nix fmt                   # format with alejandra (the flake formatter)
nix flake check           # validate every output (run after edits)
nix flake show            # inspect the output tree

# Build / run a package
nix build .#zed-editor        # or .#plex-desktop ; output at ./result
nix run   .#zed-editor

# Scaffold from a template
nix flake init      -t .#<name>          # into cwd  (name ∈ templates/templates.nix)
nix flake new ./out -t .#<name>          # into a new dir

# Or use the `antlers` CLI (shorthand over all of the above — once it's on PATH)
antlers list                              # show every template + package (queried from the flake)
antlers new <name> [dir]                  # scaffold a template (dir defaults to ./<name>)
antlers init <name>                       # scaffold into the current directory
antlers build <package>                   # nix build .#<package>
antlers run <package>                     # nix run .#<package>
antlers shell                             # enter the antlers dev shell
# Targets github:CalamooseLabs/antlers by default; override with ANTLERS_REF.

# Build a document template's PDF (run inside the scaffolded/template dir)
nix build                                 # → ./result/main.pdf
```

There are no tests; `nix flake check` + `nix fmt` (alejandra) are the only gates.

**Gotcha:** new `.nix` files must be `git add`-ed (commit not required) or flake evaluation can't see them and reports a misleading "path does not exist".

## Architecture

### Flake topology (single root aggregator)

The root `flake.nix` is the only flake exposing packages/templates. It:
- `callPackage`s each `flakes/<name>/package.nix` and exposes concrete derivations under `packages.${system}.{zed-editor, plex-desktop, antlers, default}`.
- exposes the **parameterized** Zed builder under `lib.${system}.mkZedWrapper` (a function, which is *not* allowed under `packages` — flake `packages.<system>.<name>` must be derivations).
- exposes `overlays.default` (so NixOS/home-manager can consume), `apps.${system}` (for `nix run`), `templates = import ./templates/templates.nix`, the root `devShells.default`, and `formatter` (alejandra).

Packages live in `package.nix` files (not sub-flakes) so the root flake reads them in-tree via `callPackage` — no `github:`-self-reference, no extra lockfiles, local edits visible immediately. **Do not** reintroduce a `flakes/flake.nix` or per-dir flakes; add new packages as `flakes/<name>/package.nix` and wire them into the root flake.

**The zed-editor wrapper** (`flakes/zed-editor/package.nix`) is the key reusable abstraction: a function `settings: derivation`. The resulting `zeditor` launcher writes the settings into a throwaway `XDG_CONFIG_HOME`/`XDG_DATA_HOME`, deep-merges the user's real `~/.config/zed/settings.json` via `jq -s '.[0] * .[1]'` (**right operand wins → the project's pinned settings take precedence**), copies the user's extensions/themes, and cleans up on exit. Get a concrete editor with `packages.zed-editor` (default settings) or customize via `lib.${system}.mkZedWrapper { … }`.

### The `antlers` CLI

`flakes/antlers/` packages a `writeShellApplication` named `antlers` that is a thin shorthand over the `nix` invocations against this flake — it does **not** reimplement anything. `package.nix` bakes a `defaultRef` (`github:CalamooseLabs/antlers`) into `antlers.sh` via `replaceStrings`/`readFile`; the user overrides it per-invocation with `ANTLERS_REF`. Subcommands: `list` (queries `#templates` and `#packages.<system>` with `nix eval --apply` + `jq` so it auto-discovers — nothing to hardcode), `new`/`init` (→ `nix flake new`/`init -t`), `build`/`run` (→ `nix build`/`run`), `shell` (→ `nix develop`). Per-template commands like `create-lease` are **not** wrapped — they live in each scaffolded template's own dev shell.

It is exposed three ways so it can land on a system: `packages.<system>.antlers`, `apps.<system>.antlers` (`nix run`), and `overlays.default.antlers`. To put it on a NixOS system, add the overlay and `environment.systemPackages = [ pkgs.antlers ];`, or reference `inputs.antlers.packages.${system}.antlers` directly. Editing the script is editing `flakes/antlers/antlers.sh` (a plain bash body — no shebang; `writeShellApplication` adds the shebang, `set -euo pipefail`, and a build-time shellcheck gate). `git add` it after creating, per the flake/git gotcha above.

### `vibe` (Claude Code launcher + browser session manager)

`vibe` is two halves under one `nixosModules.vibe` (`import ./flakes/vibe/module.nix self`), each independently `enable`-able:

- **`programs.vibe`** installs a configured `vibe` command. `flakes/vibe/package.nix` follows the **zed-editor wrapper pattern** — a `callPackage`-able *function* `cfg → writeShellApplication "vibe"` (exposed as `lib.<system>.mkVibeWrapper`; default-config derivation as `packages.<system>.vibe`). `vibe` serialises the pinned `{ model, effortLevel, permissions, …extraSettings }` to a throwaway settings.json and runs `claude --settings …` (`VIBE_MODEL`/`VIBE_EFFORT` env-override via jq). `vibe --remote-control [name]` (or `VIBE_REMOTE_CONTROL=1`) adds the top-level `--remote-control [name]` **flag** to that same `claude --settings …` invocation so the session is driven from claude.ai / mobile. **Key distinction (verified against claude-code 2.1.170): use the `--remote-control` FLAG on the main `claude` command, not the `claude remote-control` SUBCOMMAND.** The flag runs the normal interactive command with Remote Control enabled, so `--settings` (and thus the pinned model/effort/permissions) is fully honoured; the subcommand only accepts `--name`/`--permission-mode`, which is why the older path could not deliver model/effort. So the `programs.vibe.model`/`effort`/`permissions` pins now reach **both** interactive `vibe` use **and** the web-service (`services.vibe`) sessions (the remote client at claude.ai / mobile can still switch model client-side, but `--settings` sets the session default). **Subscription-first defaults** (vibe targets Claude Code Max/Team/Pro plans): `model` defaults to `opus[1m]` (latest Opus + 1M context — included on Max/Team, Pro draws usage credits), and `subscriptionAuth` (default true) drops a stray `ANTHROPIC_API_KEY` so sessions use the plan's OAuth login instead of silently billing the API (opt out with `subscriptionAuth = false` / `VIBE_API_KEY_AUTH=1`).

- **`services.vibe`** runs `vibe-server`, a Deno web service following the **lanserver pattern** (`deno compile`, FOD deno-cache, denort zip, nix-ld). The app is split into focused modules under `flakes/vibe-server/app/src/` (`main`, `config`, `auth`, `sessions`, `directories`, `sse`, `http`, `html`, `router`, `util`); **zero *external* imports** keeps the deno-cache FOD empty so the build stays offline — local `./*.ts` relative imports are fine (they download nothing), but do **not** add `jsr:`/`npm:`/`https:`/`@std/*`. The web UI: shared-password login (per-IP brute-force rate-limit; size-capped request bodies) → HMAC-signed cookie (`Secure` set only behind TLS, detected via `x-forwarded-proto`); lists `services.vibe.directories`; spawns a `vibe` session per chosen dir (via the overridable `sessionCommand`, default `["${vibePackage}/bin/vibe" "--remote-control" "@NAME@"]`, `@DIR@`/`@NAME@` substituted, launched under `setsid` for clean process-group kill, output captured to `/var/lib/vibe/logs/`, spawn env **allowlisted** — `services.vibe.extraEnv` extends it so stray secrets don't reach Claude Code or its browser-readable logs); lists/kills sessions; SSE-streams each log read-only; and surfaces a **login hyperlink** when a session's output contains a Claude/Anthropic OAuth URL (`SessionInfo.loginUrl`). The UI can also **create or register project directories** under `services.vibe.projectsDir` (default `/var/lib/vibe/projects`; null disables) — a new name is scaffolded from `services.vibe.newProjectTemplate` (the `vibe-shell` template) and `git init`-ed, an existing one is just registered; user-added dirs persist to `stateDir/directories.json` and config-defined `directories` stay immutable (`DELETE` only unregisters, never deletes files). **Sessions survive a vibe-server restart**: the running set is snapshotted to `stateDir/sessions.json` and re-adopted on boot (these have no `ChildProcess` handle, so a reaper polls `/proc` to retire ones that exited) — Remote Control sessions therefore aren't orphaned. An unauthenticated `/healthz` is exposed for liveness probes. Other knobs: `requireTLS` (reject non-TLS requests with 426, except `/healthz`), `sessionNamePrefix`, `maxLogBytes` (per-session log size cap — appends stop past it, no rotation so the live SSE tail keeps working), and `localNetworkSubnets6` (IPv6 firewall rules); the UI adds copy-session-name, uptime, confirm-before-kill, a `terminating` state, and per-session log metadata + download (`/api/sessions/:id/logs/download`). The `vibe` launcher itself has `--help` / `--show-config` (print the pinned settings + `claude auth status`). The browser is a **lifecycle manager** — you actually interact with a session through Claude Code Remote Control.

Unlike lanserver's strict sandbox, the unit uses a static `User`/`Group`, `StateDirectory=vibe`, `ReadWritePaths = ["/var/lib/vibe"] ++ directories`, and **auto-relaxes `ProtectHome`** (→ `false`, with a `warnings` notice) when any configured dir is under `/home`; never set `MemoryDenyWriteExecute` (breaks V8's JIT). It also applies broad systemd hardening that is safe for V8 (`UMask=0077`, `ProtectProc=invisible`, `ProtectKernel*`, `RestrictNamespaces`, `LockPersonality`, `RestrictAddressFamilies=AF_INET/AF_INET6/AF_UNIX/AF_NETLINK`, …) but **no `SystemCallFilter`** (also breaks the JIT). Module `assertions` reject non-absolute directory paths and names outside `[A-Za-z0-9_-]+` (which the web UI rejects anyway). The service user must be authenticated to Claude — for subscription plans (Max/Team/Pro) the recommended path is a pre-seeded `claudeConfigDir` (→ `CLAUDE_CONFIG_DIR`) holding an OAuth `/login`; an `environmentFile` (`ANTHROPIC_API_KEY=…`) is the API-key alternative (and then requires `programs.vibe.subscriptionAuth = false`, since the wrapper otherwise drops the key to keep sessions on the plan). `passwordFile`/`environmentFile` are read at runtime, never copied to the store. Note `templates/vibe-shell/` is the dev-shell template new UI-created projects are scaffolded from — it takes antlers as an input and puts `vibe` (via `mkVibeWrapper`) in its dev shell.

### Templates consuming antlers

The dev-shell templates pull the shared Zed wrapper by taking antlers as a flake input and calling the builder:

```nix
# flake.nix
inputs.antlers = { url = "github:CalamooseLabs/antlers"; inputs.nixpkgs.follows = "nixpkgs"; };
# shell.nix
(inputs.antlers.lib.x86_64-linux.mkZedWrapper zedSettings)
```

A scaffolded template ends up in a *separate* repo, so it must reference antlers via `github:` (not a relative path). Pin to a tag/rev for reproducibility.

### LaTeX document templates

`tex-editor`, `nkc-report`, `nkc-farmland-lease`, `nkc-lease-amendment` share a structure:

- `flake.nix` → `devShells.default` (a configured Zed + `texlab`/`alejandra`/`nixd`/`nil`) and `packages.default = pkgs.callPackage ./build.nix {}`.
- `build.nix` is a `stdenv.mkDerivation` that runs `latexmk -interaction=nonstopmode -outdir=build -pdf ./src/main.tex` under `texliveFull` and installs `build/main.pdf` to `$out`. (Use `-outdir=build` and copy `build/main.pdf` — a bare `-auxdir` puts the PDF in the aux dir under pdflatex's emulation, which breaks `cp main.pdf`.) So `nix build` → `result/main.pdf`.
- `src/main.tex` `\input`/`\subimport`s `style(s)`, `variables`, and `content`.

**Modular document tree** (most developed in `nkc-farmland-lease`): a recursive tree of directories, each with three files:
- `variables.tex` — an inclusion boolean (e.g. `\newboolean{includeArticleI}`) plus that node's content vars.
- `main.tex` — `\subimport{.}{variables}` then `\ifthenelse{\boolean{includeX}}{ \section{…} \subimport{.}{content} }{ \section{\omitText} … }` — toggling the boolean includes or stubs out the whole subtree.
- `content.tex` — the prose, which itself `\subimport`s child nodes (`article_* → section_* → subsection_* → subsubsection_*`).

Add a node by scaffolding from the template's own nested registry (`templates/<doc-template>/templates/default.nix`):
```sh
cd templates/<doc-template>
nix flake new <path> -t .#article   # or .#section / .#subsection / .#subsubsection
```

`nkc-report` is the simpler variant — flat `src/content.tex` with `\newtoggle` flags (`confidential`, `showdraft`, `showcomments`) for watermarks/headers, and no nested `templates/` dir.

### spreadsheet-pdf template

A different pipeline: `build.nix` drives `sc-im` headlessly via an `expect` heredoc to export `src/main.sc` to Markdown, then `pandoc` renders `main.pdf`. (The heredoc terminator is column-0 *after* Nix `''` strips the common indent — leave it indented in-source.)

## Conventions

- Canonical nixpkgs: `github:NixOS/nixpkgs/nixos-unstable`. Owner casing: `NixOS` and `CalamooseLabs`.
- Format with `nix fmt` / `alejandra` before committing.
- New flake inputs should `inputs.nixpkgs.follows = "nixpkgs"` to avoid duplicate nixpkgs.
- Each template dir carries its own `.envrc` (`use flake`) and a `.gitignore` covering `.direnv/` and `result`.
