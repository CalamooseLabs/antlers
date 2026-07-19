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
    # manager (services.vibe-server, backed by the vibe-server Deno web service).
    mkVibeWrapper = pkgs.callPackage ./flakes/vibe/package.nix {};
    vibe = mkVibeWrapper {};
    vibe-server = pkgs.callPackage ./flakes/vibe-server/package.nix {};

    # unifi-protect-monitor — UniFi Protect camera-wall web service (services.unifi-protect-monitor,
    # a deno-compiled binary run under nix-ld) + the Wayland kiosk viewer (unifi-protect-viewer).
    unifi-protect-monitor = pkgs.callPackage ./flakes/unifi-protect-monitor/package.nix {};
    unifi-protect-viewer = pkgs.callPackage ./flakes/unifi-protect-monitor/viewer.nix {};

    # cobblemon-overlay — OBS stream-overlay web service for The Cobblemon
    # Initiative (services.cobblemon-overlay): ingests the mod's streamsync
    # pushes and serves transparent SSE-live overlay pages, with bundled
    # pokesprite box icons fetched at build time.
    cobblemon-overlay = pkgs.callPackage ./flakes/cobblemon-overlay/package.nix {};

    # Reusable shell-script collection (rebuild-config, edit-config, *-restore,
    # …). package.nix returns an attrset of writeShellApplication derivations,
    # one per command in ./scripts; see flakes/scripts. The companion
    # programs.antlers-scripts module bakes per-host overrides into them.
    # callPackages (not callPackage): the file returns a SET of derivations.
    scripts = pkgs.callPackages ./flakes/scripts/package.nix {};

    # Fade In screenwriting app (vendored, unfree), relocated from cala-m-os.
    fadein = pkgs.callPackage ./flakes/fadein/package.nix {};

    # moosefetch — a Cala-M-OS flavored fastfetch wrapper (programs.moosefetch).
    # The readout is driven by a keyword list (reads like a module-import list,
    # "" => a blank line) and the logo is a brand mark rendered to truecolor ANSI
    # art at build time. package.nix returns a FUNCTION of config, like mkVibeWrapper.
    mkMoosefetch = pkgs.callPackage ./flakes/moosefetch/package.nix {};
    moosefetch = mkMoosefetch {};

    # proton-secrets — headless Proton Pass CLI (`pass-cli`) wrapper + an
    # agenix-shaped, activation-time secret-decryption NixOS module
    # (services.proton-secrets). The bundled proton-pass-cli is UNFREE.
    proton-secrets = pkgs.callPackage ./flakes/proton-secrets/package.nix {};

    # legal — shared infra for The Company, Inc. legal documents: the ONE canonical
    # LaTeX style (thecompanyinc-style), the mkLegalDoc PDF builder, and the shared
    # create-doc/edit-doc wizard (docWizard). Consumed by every `thecompanyinc-*`
    # template and by the legal-folder PDF builders. Returns an attrset of these.
    legal = pkgs.callPackage ./flakes/legal/package.nix {};
  in {
    # ---- Buildable packages: `nix build .#zed-editor`, `nix run .#zed-editor` ----
    packages.${system} =
      {
        inherit zed-editor plex-desktop antlers lanserver vibe vibe-server fadein moosefetch proton-secrets;
        inherit unifi-protect-monitor unifi-protect-viewer;
        inherit cobblemon-overlay;
        # Re-export the raw Proton Pass CLI (binary `pass-cli`) for `nix run .#proton-pass-cli`.
        proton-pass-cli = pkgs.proton-pass-cli;
        # Legal-doc shared infra: the canonical style + the create-doc/edit-doc wizard.
        thecompanyinc-style = legal.thecompanyinc-style;
        thecompanyinc-doc-wizard = legal.docWizard;
        default = zed-editor;
      }
      // scripts;

    # ---- Checks: `nix flake check` runs these alongside building every output ----
    # Offline Deno unit/integration tests for vibe-server. The app has ZERO
    # external imports, so the tests need no network and run in the build sandbox;
    # git backs the gitDiff integration tests. (No `deno fmt` — the TS is
    # hand-formatted; type-checking happens here via `deno test` and at compile.)
    checks.${system} = {
      vibe-server-unit =
        pkgs.runCommand "vibe-server-unit" {
          nativeBuildInputs = [pkgs.deno pkgs.git];
        } ''
          cp -r ${./flakes/vibe-server/app} app
          chmod -R u+w app
          export DENO_DIR="$TMPDIR/deno" HOME="$TMPDIR/home"
          mkdir -p "$DENO_DIR" "$HOME"
          cd app
          deno test --allow-read --allow-write --allow-run --allow-env --no-lock test/
          touch $out
        '';

      # Offline Deno unit/integration tests for unifi-protect-monitor. Zero external
      # imports, so no network; loopback (the ws.ts integration test) works in the sandbox.
      unifi-protect-monitor-unit =
        pkgs.runCommand "unifi-protect-monitor-unit" {
          nativeBuildInputs = [pkgs.deno];
        } ''
          cp -r ${./flakes/unifi-protect-monitor/app} app
          chmod -R u+w app
          export DENO_DIR="$TMPDIR/deno" HOME="$TMPDIR/home"
          mkdir -p "$DENO_DIR" "$HOME"
          cd app
          deno test --allow-read --allow-write --allow-net --allow-run --allow-env --no-lock test/
          touch $out
        '';

      # Offline Deno unit tests for cobblemon-overlay (protocol/ingest/state/
      # SSE/XSS-escape/sprite-mapping). Zero external imports, so no network.
      cobblemon-overlay-unit =
        pkgs.runCommand "cobblemon-overlay-unit" {
          nativeBuildInputs = [pkgs.deno];
        } ''
          cp -r ${./flakes/cobblemon-overlay/app} app
          chmod -R u+w app
          export DENO_DIR="$TMPDIR/deno" HOME="$TMPDIR/home"
          mkdir -p "$DENO_DIR" "$HOME"
          cd app
          deno test --allow-read --allow-write --allow-net --no-lock test/
          touch $out
        '';

      # Evaluate services.cobblemon-overlay in a container NixOS so a module
      # regression fails `nix flake check` — forces the systemd unit + the
      # generated /etc/cobblemon-overlay/config.json (mirrors the
      # unifi-protect-monitor module check).
      cobblemon-overlay-module = let
        sys = nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            self.nixosModules.cobblemon-overlay
            {
              boot.isContainer = true;
              system.stateVersion = "24.11";
              services.cobblemon-overlay = {
                enable = true;
                openFirewall = true;
                localNetworkOnly = true;
                localNetworkSubnets = ["10.10.10.30/32"];
                # Exercise the LoadCredential token staging path.
                tokenFile = "/run/secrets/cobblemon-overlay-token";
              };
            }
          ];
        };
      in
        pkgs.runCommand "cobblemon-overlay-module-eval" {} ''
          echo "${builtins.toString sys.config.systemd.services.cobblemon-overlay.serviceConfig.ExecStart}" > $out
          cp ${sys.config.environment.etc."cobblemon-overlay/config.json".source} config.json
          cat config.json >> $out
        '';

      # Evaluate services.unifi-protect-monitor in a container NixOS so a module
      # regression fails `nix flake check` — forces the systemd unit + the generated
      # /etc/unifi-protect-monitor/config.json (mirrors robomoose's module check).
      unifi-protect-monitor-module = let
        sys = nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            self.nixosModules.unifi-protect-monitor
            {
              boot.isContainer = true;
              system.stateVersion = "24.11";
              services.unifi-protect-monitor = {
                enable = true;
                consoleIP = "192.168.1.1";
                apiKeyFile = "/run/secrets/protect-api-key";
                openFirewall = true;
                localNetworkOnly = true;
                # Exercise the opt-in recorded-playback path (assertion + secret handling).
                recordings = {
                  enable = true;
                  username = "protect-monitor";
                  passwordFile = "/run/secrets/protect-local-admin";
                };
              };
            }
          ];
        };
      in
        pkgs.runCommand "unifi-protect-monitor-module-eval" {} ''
          echo "${builtins.toString sys.config.systemd.services.unifi-protect-monitor.serviceConfig.ExecStart}" > $out
          cp ${sys.config.environment.etc."unifi-protect-monitor/config.json".source} config.json
          cat config.json >> $out
        '';
    };

    # ---- Parameterized builders for downstream flakes that need custom config ----
    # e.g. inputs.antlers.lib.x86_64-linux.mkZedWrapper { ...zed settings... }
    #      inputs.antlers.lib.x86_64-linux.mkVibeWrapper { model = "opus"; ... }
    lib.${system} = {
      inherit mkZedWrapper mkVibeWrapper mkMoosefetch scripts;
      # Legal-doc builders: mkLegalDoc { src; } -> PDF derivation; docWizard -> create-doc/edit-doc;
      # thecompanyinc-style -> the canonical style derivation (its $out/tex on TEXINPUTS).
      inherit (legal) mkLegalDoc docWizard thecompanyinc-style;
    };

    # ---- Overlay so NixOS / home-manager configs can consume directly ----
    overlays.default = final: _prev:
      {
        antlers = final.callPackage ./flakes/antlers/package.nix {};
        antlers-zed-editor = (final.callPackage ./flakes/zed-editor/package.nix {}) {};
        plex-desktop-fixed = final.callPackage ./flakes/plex-desktop/package.nix {};
        lanserver = final.callPackage ./flakes/lanserver/package.nix {};
        vibe = (final.callPackage ./flakes/vibe/package.nix {}) {};
        vibe-server = final.callPackage ./flakes/vibe-server/package.nix {};
        unifi-protect-monitor = final.callPackage ./flakes/unifi-protect-monitor/package.nix {};
        unifi-protect-viewer = final.callPackage ./flakes/unifi-protect-monitor/viewer.nix {};
        cobblemon-overlay = final.callPackage ./flakes/cobblemon-overlay/package.nix {};
        fadein = final.callPackage ./flakes/fadein/package.nix {};
        moosefetch = (final.callPackage ./flakes/moosefetch/package.nix {}) {};
        proton-secrets = final.callPackage ./flakes/proton-secrets/package.nix {};
        thecompanyinc-style = (final.callPackage ./flakes/legal/package.nix {}).thecompanyinc-style;
        thecompanyinc-doc-wizard = (final.callPackage ./flakes/legal/package.nix {}).docWizard;
      }
      // (final.callPackages ./flakes/scripts/package.nix {});

    # ---- NixOS modules ----
    # inputs.antlers.nixosModules.{lanserver,vibe,vibe-server}
    #   vibe        → programs.vibe  (the `vibe` Claude Code launcher)
    #   vibe-server → services.vibe-server  (the browser session-manager web service)
    # Import both to run the service with sessions launched by the configured
    # `vibe`; each is independently usable.
    nixosModules = {
      lanserver = import ./flakes/lanserver/module.nix self;
      vibe = import ./flakes/vibe/module.nix self;
      vibe-server = import ./flakes/vibe-server/module.nix self;
      unifi-protect-monitor = import ./flakes/unifi-protect-monitor/module.nix self;
      # services.cobblemon-overlay — OBS stream overlays for The Cobblemon Initiative.
      cobblemon-overlay = import ./flakes/cobblemon-overlay/module.nix self;
      antlers-scripts = import ./flakes/scripts/module.nix "system";
      moosefetch = import ./flakes/moosefetch/module.nix "system";
      # services.proton-secrets — activation-time secret decryption from Proton Pass.
      proton-secrets = import ./flakes/proton-secrets/module.nix self;
    };

    # home-manager variants (install into home.packages).
    homeManagerModules = {
      antlers-scripts = import ./flakes/scripts/module.nix "home";
      moosefetch = import ./flakes/moosefetch/module.nix "home";
      # programs.unifi-protect-viewer — the Wayland viewer with baked-in server/cameras defaults.
      unifi-protect-viewer = import ./flakes/unifi-protect-monitor/viewer-module.nix self;
    };

    # ---- Explicit `nix run` targets ----
    apps.${system} =
      {
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
        moosefetch = {
          type = "app";
          program = "${moosefetch}/bin/moosefetch";
        };
        unifi-protect-viewer = {
          type = "app";
          program = "${unifi-protect-viewer}/bin/unifi-protect-viewer";
        };
        proton-secrets = {
          type = "app";
          program = "${proton-secrets}/bin/proton-secrets";
        };
        default = self.apps.${system}.zed-editor;
      }
      # one `nix run .#<name>` / `antlers run <name>` target per script
      // (pkgs.lib.mapAttrs (name: pkg: {
          type = "app";
          program = "${pkg}/bin/${name}";
        })
        scripts);

    # ---- Template registry: `nix flake init -t .#<name>` ----
    templates = import ./templates/templates.nix;

    # ---- Dev shell for working ON antlers itself ----
    devShells.${system}.default = import ./shell.nix {inherit pkgs;};

    # ---- Formatter: `nix fmt` ----
    formatter.${system} = pkgs.alejandra;
  };
}
