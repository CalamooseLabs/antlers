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

    # moosewire — dual-pane SSH/SCP file-mover TUI (Rust/ratatui). Left pane =
    # local, right pane = a remote host reached over ONE ssh ControlMaster
    # connection (one Yubikey touch); listings via `find`, copies via `scp`.
    # The repo's first Rust package (rustPlatform.buildRustPackage). The baked
    # host list is supplied downstream by cala-m-os's modules/moosewire.
    moosewire = pkgs.callPackage ./flakes/moosewire/package.nix {};

    # moosebroom — storage-space cleaner-upper TUI (Rust/ratatui). Scans for
    # reclaimable space in three categories (Nix generations/GC/store-optimise,
    # caches & junk, dev/container junk), each shown with an estimate; mark and
    # reclaim with a confirm. Plus an ncdu-style disk-usage scan mode to hunt
    # large dirs/files. Reclaims by shelling out to the host's own nix /
    # journalctl / docker (never a shell string built from a path). Second Rust
    # crate here; shares moosewire's ratatui-only lockfile shape.
    moosebroom = pkgs.callPackage ./flakes/moosebroom/package.nix {};

    # proton-secrets — headless Proton Pass CLI (`pass-cli`) wrapper, the fetch
    # engine behind it (`passthru.fetch`, proton-secrets-fetch) and an
    # agenix-shaped NixOS module (services.proton-secrets) that fetches secrets
    # into a ramfs at activation and from a retrying boot-time unit. The bundled
    # proton-pass-cli is UNFREE.
    proton-secrets = pkgs.callPackage ./flakes/proton-secrets/package.nix {};

    # legal — shared infra for The Company, Inc. legal documents: the ONE canonical
    # LaTeX style (thecompanyinc-style), the mkLegalDoc PDF builder, and the shared
    # create-doc/edit-doc wizard (docWizard). Consumed by every `thecompanyinc-*`
    # template and by the legal-folder PDF builders. Returns an attrset of these.
    legal = pkgs.callPackage ./flakes/legal/package.nix {};

    # calman-sony — seamless "near-native app" launcher (FreeRDP RemoteApp) for
    # Calman Home for Sony running in a BACKGROUND libvirt/QEMU Windows VM, plus
    # the NixOS module that declares that VM (USB colorimeter hostdev + bridged
    # NIC for Sony BRAVIA AutoCal) and a home-manager module for the launcher.
    # SCAFFOLD — see flakes/calman-sony/README.md. package.nix returns a FUNCTION
    # of config, like mkVibeWrapper / mkMoosefetch.
    mkCalmanSony = pkgs.callPackage ./flakes/calman-sony/package.nix {};
    calman-sony = mkCalmanSony {};
  in {
    # ---- Buildable packages: `nix build .#zed-editor`, `nix run .#zed-editor` ----
    packages.${system} =
      {
        inherit zed-editor plex-desktop antlers lanserver vibe vibe-server fadein moosefetch moosewire moosebroom proton-secrets calman-sony;
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
      # SSE/XSS-escape/sprite-mapping, the channel-point effect queue + its
      # loopback/token routing, the persistence-race regressions). Zero
      # external imports, so no network — and no --allow-env: tested code
      # must not read env vars.
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
      # regression fails `nix flake check` — forces the systemd unit (incl. the
      # LoadCredential list + credential env vars) + the generated
      # /etc/cobblemon-overlay/config.json (mirrors the unifi-protect-monitor
      # module check).
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
                # Exercise the LoadCredential token staging path — both tokens.
                tokenFile = "/run/secrets/cobblemon-overlay-token";
                effects.tokenFile = "/run/secrets/cobblemon-overlay-effects-token";
              };
            }
          ];
        };
        unit = sys.config.systemd.services.cobblemon-overlay.serviceConfig;
      in
        pkgs.runCommand "cobblemon-overlay-module-eval" {} ''
          echo "${builtins.toString unit.ExecStart}" > $out
          echo "${builtins.toString unit.LoadCredential}" >> $out
          echo "${builtins.toString unit.Environment}" >> $out
          cp ${sys.config.environment.etc."cobblemon-overlay/config.json".source} config.json
          cat config.json >> $out
          grep -q 'effects-token:/run/secrets/cobblemon-overlay-effects-token' $out
          grep -q 'COBBLEMON_OVERLAY_EFFECTS_TOKEN_FILE=%d/effects-token' $out
          grep -q '"effectsEnabled":true' $out
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

      # services.proton-secrets, offline and end to end. A small NixOS
      # configuration is evaluated with `cliPackage` = a stub pass-cli
      # (tests/pass-cli-stub.sh: the real one's session files, error texts and
      # exit codes, driven by control files), and the proton-secrets-fetch that
      # configuration BUILT is run through tests/scenarios.sh — unprivileged,
      # against a temp directory, via the manifest's test seams. It asserts on
      # the generation directories, the status JSON, exit codes and the stub's
      # call log: session state machine (network wait, PAT login through the
      # environment, the logout --force reset, an expired PAT), per-secret
      # failures and carry-forward, change-aware generations and consumer
      # restarts, failClosed on the activation path, the sealed cache round
      # trip, the lock, and the `proton-secrets` CLI on top. The rendered units
      # and activation snippets are checked too, for the activation-script and
      # the userborn (no activation scripts) variants, and so are the module's
      # assertions.
      proton-secrets-fetch = let
        t = ./flakes/proton-secrets/tests;
        stub = name: file:
          pkgs.writeShellApplication {
            inherit name;
            runtimeInputs = [pkgs.coreutils pkgs.gnugrep];
            text = builtins.readFile file;
          };
        passCli = stub "pass-cli" (t + "/pass-cli-stub.sh");
        systemctl = stub "systemctl" (t + "/systemctl-stub.sh");
        systemdCreds = stub "systemd-creds" (t + "/systemd-creds-stub.sh");
        sync = stub "sync" (t + "/sync-stub.sh");
        mkSys = extra:
          nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.proton-secrets
              {
                boot.isContainer = true;
                system.stateVersion = "24.11";
                users.users.hub = {
                  isNormalUser = true;
                  group = "users";
                };
                services.proton-secrets = {
                  enable = true;
                  cliPackage = passCli;
                  patFile = "/var/lib/proton-pass-cli/pat";
                  cache.enable = true;
                  restartUnits = ["any-change.service"];
                  secrets = let
                    item = itemTitle: {
                      vaultName = "Vault";
                      inherit itemTitle;
                      field = "secret";
                    };
                  in {
                    alpha = item "alpha" // {restartUnits = ["alpha-consumer.service"];};
                    beta = {
                      vaultName = "Vault";
                      itemTitle = "Stream Keys";
                      field = "YouTube Vertical";
                      owner = "hub";
                      mode = "0440";
                      restartUnits = ["beta-consumer.service" "shared.service"];
                    };
                    gamma = {
                      reference = "pass://SHARE/ITEM/password";
                      restartUnits = ["shared.service"];
                    };
                    delta = item "delta" // {optional = true;};
                    linked = item "linked" // {path = "/etc/app/linked-secret";};
                    plain =
                      item "plain"
                      // {
                        symlink = false;
                        path = "/var/lib/app/plain-secret";
                      };
                  };
                };
              }
              extra
            ];
          };
        sys = mkSys {};
        # systemd-sysusers/userborn hosts have no `users` activation snippet to
        # hook, so there the fetch unit is the only path.
        sysUserborn = mkSys {services.userborn.enable = true;};
        # A cache key that may involve the TPM.
        sysTpm = mkSys {services.proton-secrets.cache.withKey = "auto";};
        # One configuration that breaks each of the module's assertions.
        sysBroken = mkSys {
          services.userborn.enable = true;
          services.proton-secrets = {
            restartUnits = ["proton-secrets-fetch.service"];
            fetchService = {
              enable = false;
              restartSec = 900;
            };
            secrets = {
              nowhere = {};
              "sub/dir" = {reference = "pass://SHARE/ITEM/password";};
            };
          };
        };
        failedAssertions = s: map (a: a.message) (builtins.filter (a: !a.assertion) s.config.assertions);
        ps = sys.config.services.proton-secrets;
        unit = name: s: pkgs.writeText name s.config.systemd.units.${name}.text;
        activation = sys.config.system.activationScripts;
      in
        pkgs.runCommand "proton-secrets-fetch" {
          nativeBuildInputs = [pkgs.jq pkgs.util-linux pkgs.diffutils pkgs.findutils pkgs.gnugrep pkgs.gnused];
          FETCH = pkgs.lib.getExe ps.fetchPackage;
          WRAPPER = pkgs.lib.getExe ps.package;
          MANIFEST = ps.manifestFile;
          SYSTEMCTL_STUB = pkgs.lib.getExe systemctl;
          CREDS_STUB = pkgs.lib.getExe systemdCreds;
          SYNC_STUB = pkgs.lib.getExe sync;
          fetchUnit = unit "proton-secrets-fetch.service" sys;
          restoreUnit = unit "proton-secrets-restore.service" sys;
          restoreUnitTpm = unit "proton-secrets-restore.service" sysTpm;
          fetchUnitUserborn = unit "proton-secrets-fetch.service" sysUserborn;
          userbornAliases = builtins.concatStringsSep " " sysUserborn.config.systemd.units."proton-secrets-fetch.service".aliases;
          install = activation.protonSecretsInstall.text;
          newGeneration = activation.protonSecretsNewGeneration.text;
          chown = activation.protonSecretsChown.text;
          chownDeps = builtins.concatStringsSep " " activation.protonSecretsChown.deps;
          assertionsOk = builtins.toJSON (failedAssertions sys);
          assertionsBroken = builtins.toJSON (failedAssertions sysBroken);
          # The agenix-shaped snippet names consumers depend on.
          snippets = builtins.concatStringsSep " " (builtins.filter (n: pkgs.lib.hasPrefix "protonSecrets" n) (builtins.attrNames activation));
          usersDeps = builtins.concatStringsSep " " activation.users.deps;
          userbornSnippets = builtins.concatStringsSep " " (builtins.filter (n: pkgs.lib.hasPrefix "protonSecrets" n) (builtins.attrNames sysUserborn.config.system.activationScripts));
          etcManifest = sys.config.environment.etc."proton-secrets/manifest.json".source;
        } ''
          has() { grep -qF -- "$2" "$1" || { echo "missing in $1: $2"; cat "$1"; exit 1; }; }
          hasNot() { if grep -q -- "$2" "$1"; then echo "unexpected in $1: $2"; exit 1; fi; }

          # The manifest the module generated.
          jq -e '.version == 1 and (.secrets | length) == 6 and .cache.withKey == "host"
            and .unitName == "proton-secrets-fetch.service" and .failClosed
            and (.secrets[] | select(.name == "beta") | .owner == "hub" and .group == "users" and .mode == "0440")
            and (.secrets[] | select(.name == "delta") | .optional)
            and (has("seams") | not)' "$MANIFEST" >/dev/null
          cmp "$MANIFEST" "$etcManifest"

          # The boot-time fetch: retried with back-off until it works, stopped only
          # by the "a human must act" exit code, never by the start limit.
          has "$fetchUnit" "ExecStart=$FETCH --manifest $MANIFEST unit"
          has "$fetchUnit" "Type=oneshot"
          has "$fetchUnit" "RemainAfterExit=true"
          has "$fetchUnit" "Restart=on-failure"
          has "$fetchUnit" "RestartSec=15"
          has "$fetchUnit" "RestartSteps=8"
          has "$fetchUnit" "RestartMaxDelaySec=300"
          has "$fetchUnit" "RestartPreventExitStatus=78"
          has "$fetchUnit" "TimeoutStartSec=300"
          has "$fetchUnit" "StartLimitIntervalSec=0"
          has "$fetchUnit" "Wants=network-online.target"
          grep -q '^After=.*network-online.target' "$fetchUnit"
          grep -q '^After=.*proton-secrets-restore.service' "$fetchUnit"
          grep -q '^WantedBy=multi-user.target' "$fetchUnit"
          has "$fetchUnit" "RequiresMountsFor=/var/lib/proton-pass-cli"
          has "$fetchUnit" "RequiresMountsFor=/var/lib/proton-secrets-cache"
          hasNot "$fetchUnit" switch-to-configuration

          # The cache restore: before every normal service, no network.
          has "$restoreUnit" "ExecStart=$FETCH --manifest $MANIFEST restore"
          has "$restoreUnit" "DefaultDependencies=false"
          grep -q '^Before=.*sysinit.target' "$restoreUnit"
          grep -q '^After=.*local-fs.target' "$restoreUnit"
          # The owners must exist before the chown, and the host key must be there.
          grep -q '^After=.*systemd-sysusers.service userborn.service' "$restoreUnit"
          has "$restoreUnit" "RequiresMountsFor=/var/lib/proton-secrets-cache"
          has "$restoreUnit" "RequiresMountsFor=/var/lib/systemd"
          grep -q '^WantedBy=sysinit.target' "$restoreUnit"
          # A switch must not run it again.
          has "$restoreUnit" "X-RestartIfChanged=false"
          hasNot "$restoreUnit" network
          hasNot "$restoreUnit" tpm2
          # With a TPM key: after tpm2.target, never pulling it in — on a machine
          # without a TPM that holds sysinit.target for the device timeout.
          grep -q '^After=.*tpm2.target' "$restoreUnitTpm"
          hasNot "$restoreUnitTpm" '^Wants='
          hasNot "$restoreUnitTpm" '^Requires='

          # Activation: same names and order as before, the script behind them.
          test "$snippets" = "protonSecrets protonSecretsChown protonSecretsInstall protonSecretsNewGeneration"
          test "$usersDeps" = "protonSecretsInstall"
          grep -qF "$FETCH --manifest $MANIFEST activate || exit 1" <<<"$install"
          grep -qF 'IN_NIXOS_SYSTEMD_STAGE1' <<<"$install"
          grep -qF "$FETCH --manifest $MANIFEST mount || true" <<<"$newGeneration"
          grep -qF "$FETCH --manifest $MANIFEST chown || true" <<<"$chown"
          test "$chownDeps" = "users groups"

          # userborn: no activation snippets; the unit waits for the users and
          # still answers to the name the sysusers path used to have.
          test -z "$userbornSnippets"
          grep -q '^After=.*userborn.service' "$fetchUnitUserborn"
          test "$userbornAliases" = "proton-secrets-install.service"

          # The module's assertions: none fires for the configuration above, and
          # each one does for a configuration that breaks it.
          test "$assertionsOk" = "[]" || { echo "unexpected assertion: $assertionsOk"; exit 1; }
          for needle in '"nowhere\": set `reference`' '"sub/dir\": `name` must be a plain file name' \
            'restartMaxDelaySec must not be smaller' 'cannot be in restartUnits' 'fetchService.enable must stay on'; do
            grep -qF -- "$needle" <<<"$assertionsBroken" || { echo "assertion not raised: $needle"; echo "$assertionsBroken"; exit 1; }
          done
          test "$(jq length <<<"$assertionsBroken")" = 5

          bash ${t + "/scenarios.sh"}
          touch $out
        '';
    };

    # ---- Parameterized builders for downstream flakes that need custom config ----
    # e.g. inputs.antlers.lib.x86_64-linux.mkZedWrapper { ...zed settings... }
    #      inputs.antlers.lib.x86_64-linux.mkVibeWrapper { model = "opus"; ... }
    lib.${system} = {
      inherit mkZedWrapper mkVibeWrapper mkMoosefetch mkCalmanSony scripts;
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
        moosewire = final.callPackage ./flakes/moosewire/package.nix {};
        moosebroom = final.callPackage ./flakes/moosebroom/package.nix {};
        proton-secrets = final.callPackage ./flakes/proton-secrets/package.nix {};
        calman-sony = (final.callPackage ./flakes/calman-sony/package.nix {}) {};
        thecompanyinc-style = (final.callPackage ./flakes/legal/package.nix {}).thecompanyinc-style;
        thecompanyinc-doc-wizard = (final.callPackage ./flakes/legal/package.nix {}).docWizard;
      }
      # This spread decides the overlay's attribute NAMES, and those must not
      # depend on the consumer's package set: nixpkgs' `callPackages` (read from
      # `final` OR `prev` — both close over the consumer's fixpoint for their
      # auto-args) has to call package.nix to learn the names, which forces that
      # fixpoint while it is still being built: an infinite recursion inside any
      # set the overlay is applied to (nixpkgs.overlays). So the names come from
      # antlers' own `scripts` (an independent fixpoint), and only the VALUES are
      # built against `final`, lazily, one shared callPackages result.
      // (let
        s = final.callPackages ./flakes/scripts/package.nix {};
      in
        pkgs.lib.genAttrs (builtins.attrNames scripts) (name: s.${name}));

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
      # services.proton-secrets — secrets from Proton Pass into a ramfs: at
      # activation, from a retrying boot-time unit, optionally from a sealed cache.
      proton-secrets = import ./flakes/proton-secrets/module.nix self;
      # services.calman-sony — background Windows VM running Calman Home for Sony.
      calman-sony = import ./flakes/calman-sony/module.nix self;
    };

    # home-manager variants (install into home.packages).
    homeManagerModules = {
      antlers-scripts = import ./flakes/scripts/module.nix "home";
      moosefetch = import ./flakes/moosefetch/module.nix "home";
      # programs.unifi-protect-viewer — the Wayland viewer with baked-in server/cameras defaults.
      unifi-protect-viewer = import ./flakes/unifi-protect-monitor/viewer-module.nix self;
      # programs.calman-sony — the seamless RemoteApp launcher for Calman Home for Sony.
      calman-sony = import ./flakes/calman-sony/home-module.nix self;
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
        moosewire = {
          type = "app";
          program = "${moosewire}/bin/moosewire";
        };
        moosebroom = {
          type = "app";
          program = "${moosebroom}/bin/moosebroom";
        };
        calman-sony = {
          type = "app";
          program = "${calman-sony}/bin/calman-sony";
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
