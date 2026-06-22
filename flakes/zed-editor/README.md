# zed-editor

A wrapped **Zed** launcher: `mkZedWrapper` is a builder that takes a Zed
`settings` attrset and produces a `zeditor` command which runs Zed against a
**throwaway, project-pinned config** — written into a temporary
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`, with your real `~/.config/zed/settings.json`
deep-merged underneath it, and torn down on exit. The point is that a project's
pinned editor settings never clobber your global Zed config. The root flake
exposes the builder as `lib.<system>.mkZedWrapper`, the builder-with-default-settings
(`mkZedWrapper {}`) as `packages.<system>.zed-editor`, and that package is also
the flake's **default** (`packages.<system>.default` / `apps.<system>.default`).
The repo is `github:CalamooseLabs/antlers`.

## Outputs

| Output                          | What it is                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `lib.<system>.mkZedWrapper`     | builder: `settings → writeShellScriptBin "zeditor"` (the wrapper, for downstream custom settings) |
| `packages.<system>.zed-editor`  | the builder called with default settings (`mkZedWrapper {}`) — ready to run                 |
| `packages.<system>.default`     | the same `zed-editor` package (flake default)                                               |
| `apps.<system>.zed-editor`      | `program = "${zed-editor}/bin/zeditor"` (and `apps.<system>.default`)                        |
| `overlays.default.antlers-zed-editor` | the overlay attr — `mkZedWrapper {}` (note: the attr is **`antlers-zed-editor`**, not `zed-editor`) |

## What the wrapper does

`mkZedWrapper` returns a `zeditor` shell launcher (it wraps upstream
`pkgs.zed-editor`, whose binary is also `zeditor`). It changes nothing about Zed
itself — it changes the config Zed sees, per invocation:

1. **Throwaway config dir.** It `mktemp -d`s a fresh directory and points both
   `XDG_CONFIG_HOME` and `XDG_DATA_HOME` at it for this session only, so Zed
   reads/writes config there instead of your real `~/.config/zed` /
   `~/.local/share/zed`.
2. **Pinned settings as the base.** The `settings` attrset you passed the builder
   is serialized (`builtins.toJSON`) into `<temp>/zed/settings.json`.
3. **Your global config merged underneath.** If `~/.config/zed/settings.json`
   exists, it is deep-merged with the pinned settings via
   `jq -s '.[0] * .[1]'` — operand `.[0]` is your global config, `.[1]` is the
   pinned settings, and jq's `*` deep-merge lets the **right operand win**. So the
   **pinned settings take precedence** over your global config key-by-key, while
   any keys you set only globally still come through.
4. **Extensions and themes carried over.** Your existing
   `~/.local/share/zed/extensions` and `~/.config/zed/themes` are copied into the
   temp dir so the session keeps your installed extensions/themes.
5. **Clean teardown.** A `trap … EXIT` removes the temp dir when Zed exits — the
   pinned config leaves nothing behind, and your real Zed config is never touched.

Finally it `exec`s `zeditor "$@"`, so any arguments (paths to open, flags) pass
straight through to Zed.

```sh
zeditor                 # open Zed with the pinned settings merged over your global config
zeditor .               # …in the current directory
zeditor path/to/file    # …opening a specific file
```

## The `settings` argument

The builder's single argument is a Zed **settings attrset** — i.e. whatever you'd
put in Zed's `settings.json`, expressed as Nix. It is passed verbatim through
`builtins.toJSON`, so there is no fixed schema and no validation here: any keys
Zed understands (`theme`, `ui_font_size`, `buffer_font_family`, `vim_mode`,
`languages`, …) are accepted as-is. `mkZedWrapper {}` (an empty attrset) is the
default package — it pins nothing, so Zed runs purely on your global config (still
in a throwaway dir).

## Consuming it

Build the wrapper with your own pinned settings outside the module — this is how
it is used in `cala-m-os`:

```nix
{ inputs, pkgs, ... }:
let
  zed = inputs.antlers.lib.${pkgs.system}.mkZedWrapper {
    theme = "Ayu Dark";
    vim_mode = true;
    ui_font_size = 16;
    buffer_font_family = "JetBrainsMono Nerd Font";
    # …any Zed settings.json keys…
  };
in
{
  home.packages = [ zed ];   # puts the `zeditor` launcher on PATH
}
```

Or take the ready-to-run package straight from the flake:

```nix
inputs.antlers.url = "github:CalamooseLabs/antlers";
# …
home.packages = [ inputs.antlers.packages.${pkgs.system}.zed-editor ];
```

Or via the overlay (remember the attr is `antlers-zed-editor`):

```nix
nixpkgs.overlays = [ inputs.antlers.overlays.default ];
# …then pkgs.antlers-zed-editor  (== mkZedWrapper {})
```

## Build

```sh
nix build github:CalamooseLabs/antlers#zed-editor   # → ./result/bin/zeditor
nix run   github:CalamooseLabs/antlers#zed-editor   # build + launch
```

`package.nix` is a plain `callPackage`-able builder (a curried function:
`{ writeShellScriptBin, writeTextFile, jq, zed-editor }: settings: <derivation>`).
The root flake wires it as `mkZedWrapper = pkgs.callPackage ./flakes/zed-editor/package.nix {}`,
then `zed-editor = mkZedWrapper {}`; the result is a `writeShellScriptBin "zeditor"`
wrapping upstream `pkgs.zed-editor` and shelling out to `jq` for the config merge.

See the sibling [vibe](../vibe) wrapper for the same builder-plus-default-package
pattern applied to Claude Code.
