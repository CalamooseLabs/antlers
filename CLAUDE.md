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
