# antlers

A small CLI that shorthands the antlers flake's **templates** and **packages**, so
you don't have to type `nix flake … -t github:CalamooseLabs/antlers#…` by hand.
At runtime it is a thin wrapper that calls `nix flake new`/`nix flake init -t`,
`nix build`, `nix run`, and `nix develop` against a fixed flake reference
(`defaultRef`, baked at build time, overridable per-invocation with the
`ANTLERS_REF` env var). The root flake exposes it as
`packages.<system>.antlers` (the CLI binary), `apps.<system>.antlers` (so
`nix run github:CalamooseLabs/antlers#antlers`), and `overlays.default.antlers`
(so `pkgs.antlers` once the overlay is added) — there is **no** NixOS module.
The package also ships a bash-completion script (see [Completion](#completion)).

## The `antlers` command

```sh
antlers list                      # list available templates (with descriptions) and packages
antlers new <template> [dir]      # scaffold a template into <dir> (default ./<template>)
antlers init <template>           # scaffold a template into the current directory
antlers build <package> [args]    # build a package -> ./result (args passed to nix build)
antlers run <package> [args]      # run a package (args after -- to the program)
antlers shell                     # enter the antlers dev shell
antlers help                      # usage (also -h / --help, and the default with no args)
```

What each subcommand maps to (all against `$REF`, the resolved flake reference):

| Subcommand            | Underlying command                                         | Notes |
| --------------------- | ---------------------------------------------------------- | ----- |
| `list` (alias `ls`)   | `nix eval "$REF#templates"` + `nix eval "$REF#packages.$SYSTEM"` | prints templates with their `.description` (columnated), then package names; queries the flake live, so the list auto-discovers |
| `new <template> [dir]`| `nix flake new "$dir" -t "$REF#<template>"`                | `dir` defaults to `<template>`; errors if `<template>` is omitted |
| `init <template>`     | `nix flake init -t "$REF#<template>"`                      | scaffolds into the **current** directory; errors if `<template>` is omitted |
| `build <package> [args]` | `nix build "$REF#<package>" [args]`                     | `<package>` defaults to `default`; trailing `[args]` go straight to `nix build` |
| `run <package> [args]`| `nix run "$REF#<package>" -- [args]`                       | `<package>` defaults to `default`; trailing `[args]` are forwarded to the program (after `--`) |
| `shell` (alias `develop`) | `nix develop "$REF" [args]`                            | enters the antlers dev shell |
| `help` (`-h`/`--help`)| prints usage                                               | also the fallback for no command; an **unknown** command prints `unknown command` + usage to stderr and exits `1` |

`new`/`init`/`build`/`run`/`shell` `exec` into the underlying `nix` command (so
the process is replaced — exit code and signals pass straight through). `list`
targets `packages.x86_64-linux` (the script pins `SYSTEM="x86_64-linux"`).

### `ANTLERS_REF` override

The flake reference is resolved once as `REF="${ANTLERS_REF:-<defaultRef>}"`,
where `<defaultRef>` is baked at build time (default
`github:CalamooseLabs/antlers`). Every subcommand — and the completion cache —
is keyed off it, so you can point the whole CLI at a tag, branch, fork, or local
checkout for a single invocation:

```sh
# scaffold from a tagged release
ANTLERS_REF=github:CalamooseLabs/antlers/v1.0 antlers new nkc-master-lease

# work against a local checkout
ANTLERS_REF=/home/me/antlers antlers list
```

The current `REF` is echoed in `antlers help` output (the usage banner reads
`ref: $REF`) so you can confirm which flake you're hitting.

## Completion

The package installs a bash-completion script to
`share/bash-completion/completions/antlers.bash`, so a host with bash-completion
enabled (the NixOS default) lazy-loads it the first time you type
`antlers <TAB>`:

- **Subcommand** (first word) — completes the static set
  `list new init build run shell help`.
- **`new <TAB>` / `init <TAB>`** — completes **live template names**; for
  `new <template> <TAB>` (the directory arg) it falls back to bash directory
  completion (`compopt -o dirnames`).
- **`build <TAB>` / `run <TAB>`** — completes **live package names**.

Dynamic candidates come from a **hidden** `antlers completions
<templates|packages|commands>` helper that emits bare, newline-separated names
straight from the flake (the same `nix eval` queries `list` uses) — so the lists
never go stale against a hardcoded copy. The helper is undocumented in `usage`
and intended only for the completion script.

To keep `<TAB>` from ever blocking on a slow/remote `nix eval`, results are
**cached** under `${XDG_CACHE_HOME:-~/.cache}/antlers`, keyed by the (sanitized)
flake ref. The cache is always served immediately; a refresh runs only in the
**background**, and only when the cache is missing/empty or older than a day
(`mmin +1440`). A single-flight `mkdir` lock (cleared if orphaned >1 min) keeps
repeated TABs from spawning duplicate `nix eval` processes, and the background
fetch is `timeout 12`-bounded. The trade-off: the very first completion before
any cache exists yields no dynamic names; the next one (a moment later) has them.

## Build

Built by `pkgs.callPackage ./flakes/antlers/package.nix {}` from the root flake.
`package.nix` builds the CLI with `writeShellApplication` (which supplies the
shebang, `set -euo pipefail`, and a build-time `shellcheck` gate; runtime inputs
are `nix jq util-linux coreutils`), renders the completion with `writeText`, then
combines both under one `runCommandLocal "antlers"` derivation — shellchecking
the completion and using `installShellFiles` to place it. The binary is
**copied** (not symlinked) so it and its completion share one store prefix, which
is what lets bash-completion's lazy loader resolve the command's real path and
find the adjacent completion file. `defaultRef` is substituted into both the
script and the completion at build time (the `__DEFAULT_REF__` placeholder),
overridable per-invocation via `ANTLERS_REF`.

```sh
nix build .#antlers            # → ./result/bin/antlers
nix run   .#antlers -- list    # run without installing
nix run github:CalamooseLabs/antlers#antlers -- list
```

Consume it from the root flake — via the overlay or as a direct package input:

```nix
{ inputs, pkgs, ... }:
{
  # Option A: add the overlay, then use pkgs.antlers
  nixpkgs.overlays = [ inputs.antlers.overlays.default ];
  environment.systemPackages = [ pkgs.antlers ];

  # Option B: reference the package output directly
  # environment.systemPackages = [ inputs.antlers.packages.${pkgs.system}.antlers ];
}
```

Pass a different `defaultRef` to bake a fork/tag into the binary itself:

```nix
inputs.antlers.packages.x86_64-linux.antlers.override {
  defaultRef = "github:CalamooseLabs/antlers/v1.0";
}
```

See the sibling [vibe](../vibe) and [vibe-server](../vibe-server) READMEs, and the
[packages index](../README.md) for the full output table.
