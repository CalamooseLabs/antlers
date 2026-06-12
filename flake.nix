{
  description = "antlers — reusable NixOS packages, flakes, and templates";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    system = "x86_64-linux";

    pkgs = import nixpkgs {
      inherit system;
      config.allowUnfree = true;
    };

    # Parameterized builder: settings -> wrapped `zeditor` derivation.
    mkZedWrapper = pkgs.callPackage ./flakes/zed-editor/package.nix {};

    # Concrete, ready-to-run derivations.
    zed-editor = mkZedWrapper {};
    plex-desktop = pkgs.callPackage ./flakes/plex-desktop/package.nix {};
  in {
    # ---- Buildable packages: `nix build .#zed-editor`, `nix run .#zed-editor` ----
    packages.${system} = {
      inherit zed-editor plex-desktop;
      default = zed-editor;
    };

    # ---- Parameterized builders for downstream flakes that need custom config ----
    # e.g. inputs.antlers.lib.x86_64-linux.mkZedWrapper { ...zed settings... }
    lib.${system} = {
      inherit mkZedWrapper;
    };

    # ---- Overlay so NixOS / home-manager configs can consume directly ----
    overlays.default = final: _prev: {
      antlers-zed-editor = (final.callPackage ./flakes/zed-editor/package.nix {}) {};
      plex-desktop-fixed = final.callPackage ./flakes/plex-desktop/package.nix {};
    };

    # ---- Explicit `nix run` targets ----
    apps.${system} = {
      zed-editor = {
        type = "app";
        program = "${zed-editor}/bin/zeditor";
      };
      default = self.apps.${system}.zed-editor;
    };

    # ---- Template registry: `nix flake init -t .#<name>` ----
    templates = import ./templates/templates.nix;

    # ---- Dev shell for working ON antlers itself ----
    devShells.${system}.default = import ./shell.nix {inherit pkgs;};

    # ---- Formatter: `nix fmt` ----
    formatter.${system} = pkgs.alejandra;
  };
}
