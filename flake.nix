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

    # Shorthand CLI over the flake's templates/packages (`antlers new …`, `antlers build …`).
    antlers = pkgs.callPackage ./flakes/antlers/package.nix {};

    # LanServer (vendored from CalamooseLabs/LanServer) — Deno LAN command server.
    lanserver = pkgs.callPackage ./flakes/lanserver/package.nix {};

    # Vibe — configured Claude Code launcher (programs.vibe) + browser session
    # manager (services.vibe, backed by the vibe-server Deno web service).
    mkVibeWrapper = pkgs.callPackage ./flakes/vibe/package.nix {};
    vibe = mkVibeWrapper {};
    vibe-server = pkgs.callPackage ./flakes/vibe-server/package.nix {};
  in {
    # ---- Buildable packages: `nix build .#zed-editor`, `nix run .#zed-editor` ----
    packages.${system} = {
      inherit zed-editor plex-desktop antlers lanserver vibe vibe-server;
      default = zed-editor;
    };

    # ---- Parameterized builders for downstream flakes that need custom config ----
    # e.g. inputs.antlers.lib.x86_64-linux.mkZedWrapper { ...zed settings... }
    #      inputs.antlers.lib.x86_64-linux.mkVibeWrapper { model = "opus"; ... }
    lib.${system} = {
      inherit mkZedWrapper mkVibeWrapper;
    };

    # ---- Overlay so NixOS / home-manager configs can consume directly ----
    overlays.default = final: _prev: {
      antlers = final.callPackage ./flakes/antlers/package.nix {};
      antlers-zed-editor = (final.callPackage ./flakes/zed-editor/package.nix {}) {};
      plex-desktop-fixed = final.callPackage ./flakes/plex-desktop/package.nix {};
      lanserver = final.callPackage ./flakes/lanserver/package.nix {};
      vibe = (final.callPackage ./flakes/vibe/package.nix {}) {};
      vibe-server = final.callPackage ./flakes/vibe-server/package.nix {};
    };

    # ---- NixOS modules ----
    # inputs.antlers.nixosModules.{lanserver,vibe,vibe-server}
    #   vibe        → programs.vibe  (the `vibe` Claude Code launcher)
    #   vibe-server → services.vibe  (the browser session-manager web service)
    # Import both to run the service with sessions launched by the configured
    # `vibe`; each is independently usable.
    nixosModules = {
      lanserver = import ./flakes/lanserver/module.nix self;
      vibe = import ./flakes/vibe/module.nix self;
      vibe-server = import ./flakes/vibe-server/module.nix self;
    };

    # ---- Explicit `nix run` targets ----
    apps.${system} = {
      zed-editor = {
        type = "app";
        program = "${zed-editor}/bin/zeditor";
      };
      antlers = {
        type = "app";
        program = "${antlers}/bin/antlers";
      };
      vibe = {
        type = "app";
        program = "${vibe}/bin/vibe";
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
