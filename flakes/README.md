# Packages

Reusable package definitions (wrappers / fixups) for NixOS.

Each subdirectory holds a plain, `callPackage`-able `package.nix` — **not** a
flake. They are aggregated and exposed by the repository's root `flake.nix`, so
there is a single source of truth and no per-package flakes to keep in sync.

| Directory      | Output                              | What it is                                        |
| -------------- | ----------------------------------- | ------------------------------------------------- |
| `zed-editor/`  | `lib.<system>.mkZedWrapper`         | builder: settings → a `zeditor` launcher that runs Zed against a throwaway, project-pinned config merged over the user's global Zed settings |
| `zed-editor/`  | `packages.<system>.zed-editor`      | the above called with default settings (ready to run) |
| `plex-desktop/`| `packages.<system>.plex-desktop`    | `plex-desktop` wrapped with Hyprland/Stylix fixes |

Consume from the root flake:

```sh
nix build github:CalamooseLabs/antlers#zed-editor
nix run   github:CalamooseLabs/antlers#plex-desktop
```

Or as a flake input (custom Zed settings):

```nix
inputs.antlers.url = "github:CalamooseLabs/antlers";
# ...
# inputs.antlers.lib.x86_64-linux.mkZedWrapper { /* zed settings */ }
# or add inputs.antlers.overlays.default to nixpkgs.overlays
```

## Add a new package

1. Create `flakes/<name>/package.nix` as a `{ <deps>, ... }: <derivation>` function.
2. Wire it into the root `flake.nix`: `packages.${system}.<name> = pkgs.callPackage ./flakes/<name>/package.nix {};` (add an `apps`/overlay entry if it is runnable).
3. `git add` the new file (untracked `.nix` files are invisible to flake evaluation), then `nix flake check`.
