# plex-desktop

A thin wrapper over nixpkgs' [`plex-desktop`](https://search.nixos.org/packages?show=plex-desktop)
that fixes how the Qt app renders under **Hyprland / Stylix**: a Stylix-set Qt
style (`QT_STYLE_OVERRIDE`) makes the Plex UI render with the wrong/broken
controls, and link-opening should go through the XDG desktop portal. The wrapper
clears the style override and routes `xdg-open` through the portal, leaving the
upstream package otherwise intact. The root flake exposes it as
`packages.x86_64-linux.plex-desktop` and via the overlay as
`overlays.default.plex-desktop-fixed` (note the **`-fixed`** suffix — the overlay
attr is `plex-desktop-fixed`, not `plex-desktop`). There is no `nixosModule` and
no `apps` entry. Repo: `github:CalamooseLabs/antlers`.

## What the wrapper changes

`package.nix` is a `symlinkJoin` (name `plex-desktop-fixed`) over the upstream
`plex-desktop`, then `wrapProgram $out/bin/plex-desktop` sets two environment
variables for the launched process:

| Env var                     | Set to | Why                                                                                          |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `QT_STYLE_OVERRIDE`         | `""`   | clears any Stylix/Qt style override so Plex's Qt UI uses its own (correct) style under Hyprland |
| `NIXOS_XDG_OPEN_USE_PORTAL` | `1`    | route `xdg-open` (e.g. "open in browser") through the XDG desktop portal                      |

Everything else — the binary, the `.desktop` file, icons — is symlinked through
unchanged from upstream; the wrapper does not touch scaling, Wayland backend
selection, or the desktop entry. Run it as `plex-desktop` (the wrapped
`$out/bin/plex-desktop`).

## Consuming it

Via the overlay (remember the `-fixed` attr name):

```nix
{ inputs, ... }:
{
  nixpkgs.overlays = [ inputs.antlers.overlays.default ];
  # pkgs.plex-desktop-fixed is the wrapped build
  environment.systemPackages = [ pkgs.plex-desktop-fixed ];
}
```

Or pull the package output directly into a profile:

```nix
{ inputs, pkgs, ... }:
{
  home.packages = [ inputs.antlers.packages.${pkgs.system}.plex-desktop ];
}
```

## Build

```sh
nix build github:CalamooseLabs/antlers#plex-desktop   # → ./result/bin/plex-desktop
```

Built by the root flake as `pkgs.callPackage ./flakes/plex-desktop/package.nix {}` —
a `symlinkJoin` of the upstream `plex-desktop` with a `makeWrapper`
`postBuild` hook, yielding a derivation named `plex-desktop-fixed`.
