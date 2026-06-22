# fadein

A NixOS wrapper for **[Fade In](https://www.fadeinpro.com)**, the professional
screenwriting desktop app. The upstream Linux build ships as a prebuilt
`x86_64` tarball; this derivation **vendors that tarball** (`fadein-linux-x64.tar.gz`,
checked in alongside `package.nix`), unpacks it, and `autoPatchelf`'s the binary
so it runs on NixOS — it is **not** built from source. The root flake exposes it as
`packages.x86_64-linux.fadein` (and via `overlays.default.fadein`); there is no
NixOS module and no `apps` entry. The repo is `github:CalamooseLabs/antlers`.

> **Unfree.** `meta.license = licenses.unfree`, so consuming it needs
> `nixpkgs.config.allowUnfree = true` (or `allowUnfreePredicate` matching
> `fadein`). It is `platforms = ["x86_64-linux"]` only.

## What the wrapper does

It takes the vendored `fadein-linux-x86_64-<version>` tree and installs it into a
Nix derivation:

- Copies `usr/share/fadein/*` to `$out/share/fadein/`, marks the `fadein` binary
  executable, and symlinks it to `$out/bin/fadein` (`meta.mainProgram = "fadein"`).
- `autoPatchelfHook` rewrites the ELF interpreter / RPATH to the Nix `buildInputs`
  (`gtk3`, `webkitgtk_4_1`, `gdk-pixbuf`, `pango`, `cairo`, `glib`, `fontconfig`,
  `curl`, `libxkbcommon`, `wayland`, `util-linux`, `libx11`/`libsm`/`libice`, and
  `stdenv.cc.cc.lib`) so the prebuilt binary finds its shared libraries on NixOS.
- `wrapGAppsHook3` (with `dontWrapGApps = false`) wraps the binary so GTK/GLib
  schemas, themes, and `GIO`/pixbuf modules resolve.
- Generates a desktop entry at `$out/share/applications/fadein.desktop`
  (`Exec=…/bin/fadein %F`, `Icon=fadein`, categories `Office;WordProcessor;`,
  `MimeType=application/x-fadein;`), copying any upstream `applications/` and
  `icons/` assets if present.

Run it as `fadein` (or launch "Fade In" from the desktop menu) once it's on `PATH`.

## Use it

Install into a NixOS / home-manager profile straight from the package output. It's
unfree, so enable that first:

```nix
{ inputs, pkgs, ... }:
{
  nixpkgs.config.allowUnfree = true;            # fadein is licenses.unfree

  environment.systemPackages = [
    inputs.antlers.packages.${pkgs.system}.fadein
  ];
}
```

Or pull it in through the overlay (then refer to `pkgs.fadein`):

```nix
nixpkgs.overlays = [ inputs.antlers.overlays.default ];
environment.systemPackages = [ pkgs.fadein ];   # overlays.default.fadein
```

This is exactly how the `cala-m-os` config consumes it —
`inputs.antlers.packages.${pkgs.system}.fadein` in `environment.systemPackages`.

## Build

```sh
nix build github:CalamooseLabs/antlers#fadein   # → ./result/bin/fadein
```

Built by `callPackage`'ing `package.nix` → a `stdenv.mkDerivation` (version
`5.0.11`) with `dontConfigure`/`dontBuild` set: it only unpacks the **vendored
`fadein-linux-x64.tar.gz`** (`src = ./fadein-linux-x64.tar.gz`) and runs the
install phase above. Pin a new upstream release by replacing the tarball and
bumping `version`.
