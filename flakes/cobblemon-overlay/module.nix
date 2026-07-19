# NixOS module for cobblemon-overlay (the OBS stream-overlay Deno web service
# for The Cobblemon Initiative).
#
# Wired into the antlers root flake.nix as
#   nixosModules.cobblemon-overlay = import ./flakes/cobblemon-overlay/module.nix self
# Exposes `services.cobblemon-overlay`. Patterned on unifi-protect-monitor's
# module: renders /etc/cobblemon-overlay/config.json, runs the compiled Deno
# binary under nix-ld in a hardened systemd unit. The optional ingest token is
# staged via systemd LoadCredential (never in the store/config file) and pointed
# at with COBBLEMON_OVERLAY_TOKEN_FILE.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  system = pkgs.stdenv.hostPlatform.system;
  cfg = config.services.cobblemon-overlay;
  serverPkg = flake.packages.${system}.cobblemon-overlay;

  quotePath = p: ''"${p}"'';

  # Keys the app's config.ts loader merges over its DEFAULTS. The token file is
  # deliberately NOT here — it arrives via the LoadCredential env var.
  configFile = pkgs.writeText "cobblemon-overlay-config.json" (builtins.toJSON {
    inherit (cfg) port hostname stateDir staleAfterSec eventLogSize spriteDir;
  });
in {
  options.services.cobblemon-overlay = {
    enable = mkEnableOption "the cobblemon-overlay OBS stream-overlay web service";

    package = mkOption {
      type = types.package;
      default = serverPkg;
      defaultText = literalExpression "antlers.packages.\${system}.cobblemon-overlay";
      description = "The cobblemon-overlay package to run (also the default sprite source).";
    };

    port = mkOption {
      type = types.port;
      default = 8082;
      description = "Port the service listens on (mod ingest + OBS browser-source pages).";
    };

    hostname = mkOption {
      type = types.str;
      default = "0.0.0.0";
      description = "Address to bind. Keep 0.0.0.0 so the mod host can push /ingest over the LAN while OBS reads the overlays via 127.0.0.1.";
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/cobblemon-overlay";
      description = "Where state.json (campaign counters, attempt number, the cemetery memorial) persists. NOTE: the compiled binary's --allow-write is fixed at build time to /var/lib/cobblemon-overlay, so keep this at (or under) the default.";
    };

    tokenFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/cobblemon-overlay-token";
      description = "File whose contents are the shared ingest token the mod must present (Authorization: Bearer …, read at runtime via systemd LoadCredential — never copied to the store). null = unauthenticated ingest; then restrict the network (localNetworkOnly + a tight subnet list) instead.";
    };

    staleAfterSec = mkOption {
      type = types.ints.positive;
      default = 15;
      description = "Seconds without an accepted ingest before the overlays fade to stale. Measured against the server's receive clock, never the mod's timestamps.";
    };

    eventLogSize = mkOption {
      type = types.ints.unsigned;
      default = 500;
      description = "How many recent game events to keep in the in-memory ring (the /status debug page's history — never replayed to overlay clients).";
    };

    spriteDir = mkOption {
      type = types.str;
      default = "${cfg.package}/share/cobblemon-overlay/sprites";
      defaultText = literalExpression ''"''${package}/share/cobblemon-overlay/sprites"'';
      description = "Directory of <slug>.png box sprites (+ pokemon.json dex map) served at /sprites/. Defaults to the pokesprite gen-8 icons bundled in the package, so sprites work offline out of the box. \"\" disables sprites (overlay cards fall back to text).";
    };

    user = mkOption {
      type = types.str;
      default = "cobblemon-overlay";
      description = "User the service runs as (auto-created only for the default name).";
    };

    group = mkOption {
      type = types.str;
      default = "cobblemon-overlay";
      description = "Group the service runs as (auto-created only for the default name).";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the service port in the firewall (needed for the mod host to push; OBS on this host reaches 127.0.0.1 regardless).";
    };

    localNetworkOnly = mkOption {
      type = types.bool;
      default = false;
      description = "When opening the firewall, restrict access to local-network subnets only. With tokenless ingest, set this and pin localNetworkSubnets to the mod host (e.g. its /32).";
    };

    localNetworkSubnets = mkOption {
      type = types.listOf types.str;
      default = ["192.168.0.0/16" "10.0.0.0/8" "172.16.0.0/12"];
      example = ["10.10.10.30/32"];
      description = "IPv4 subnets allowed when localNetworkOnly is set.";
    };

    localNetworkSubnets6 = mkOption {
      type = types.listOf types.str;
      default = ["fc00::/7" "fe80::/10"];
      description = "IPv6 subnets allowed when localNetworkOnly is set (ULA + link-local).";
    };

    enableNixLd = mkOption {
      type = types.bool;
      default = true;
      description = "Enable nix-ld so the compiled Deno binary (a generic ELF) can run.";
    };
  };

  config = mkIf cfg.enable {
    warnings =
      # The whole point of the overlay is trusting what it shows on stream —
      # unauthenticated ingest open beyond a pinned subnet means anyone who can
      # reach the port can spoof deaths/party/toasts (and grief the broadcast).
      optional (cfg.tokenFile
        == null
        && cfg.openFirewall
        && !cfg.localNetworkOnly
        && cfg.hostname != "127.0.0.1"
        && cfg.hostname != "::1")
      "services.cobblemon-overlay: ingest is UNAUTHENTICATED (no tokenFile) and the port is open beyond restricted subnets — anyone who can reach it can spoof overlay state onto the stream. Set services.cobblemon-overlay.tokenFile, or set localNetworkOnly = true with localNetworkSubnets pinned to the mod host.";

    assertions = [
      {
        assertion = hasPrefix "/" cfg.stateDir;
        message = "services.cobblemon-overlay: stateDir must be an absolute path.";
      }
    ];

    programs.nix-ld = mkIf cfg.enableNixLd {
      enable = true;
      libraries = with pkgs; [stdenv.cc.cc.lib glibc zlib openssl];
    };

    environment.etc."cobblemon-overlay/config.json".source = configFile;

    systemd.services.cobblemon-overlay = {
      description = "cobblemon-overlay OBS stream-overlay web service";
      after = ["network.target"];
      wantedBy = ["multi-user.target"];

      serviceConfig =
        {
          Type = "exec";
          User = cfg.user;
          Group = cfg.group;
          ExecStart = "${cfg.package}/bin/cobblemon-overlay";
          Restart = "always";
          RestartSec = "5";

          StateDirectory = "cobblemon-overlay";
          StateDirectoryMode = "0750";

          Environment =
            [
              "HOME=${cfg.stateDir}"
              "COBBLEMON_OVERLAY_CONFIG=/etc/cobblemon-overlay/config.json"
            ]
            # The token is staged by LoadCredential into the per-unit credentials
            # dir (%d), so the service never needs read access to the secret's
            # real location and the path works under the sandbox below.
            ++ optional (cfg.tokenFile != null) "COBBLEMON_OVERLAY_TOKEN_FILE=%d/token";

          # Filesystem confinement is the real sandbox (the Deno binary is built
          # with broad --allow-read). NEVER set MemoryDenyWriteExecute or
          # SystemCallFilter — both break V8's JIT.
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ProtectHome = "tmpfs";
          ReadWritePaths = map quotePath [cfg.stateDir];

          UMask = "0077";
          ProtectProc = "invisible";
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectControlGroups = true;
          ProtectHostname = true;
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          RestrictNamespaces = true;
          LockPersonality = true;
          SystemCallArchitectures = "native";
          RestrictAddressFamilies = ["AF_INET" "AF_INET6" "AF_UNIX"];
        }
        // optionalAttrs (cfg.tokenFile != null) {
          LoadCredential = ["token:${toString cfg.tokenFile}"];
        };
    };

    users.users = mkIf (cfg.user == "cobblemon-overlay") {
      cobblemon-overlay = {
        isSystemUser = true;
        group = cfg.group;
        home = cfg.stateDir;
        description = "cobblemon-overlay service user";
      };
    };
    users.groups = mkIf (cfg.group == "cobblemon-overlay") {cobblemon-overlay = {};};

    networking.firewall = mkMerge [
      (mkIf (cfg.openFirewall && !cfg.localNetworkOnly) {
        allowedTCPPorts = [cfg.port];
      })
      # Source-restricted open. Use the active firewall backend's own knob:
      # extraInputRules under nftables (extraCommands is silently ignored there),
      # raw iptables/ip6tables otherwise.
      (mkIf (cfg.openFirewall && cfg.localNetworkOnly) (
        if config.networking.nftables.enable
        then {
          extraInputRules = ''
            ip saddr { ${concatStringsSep ", " cfg.localNetworkSubnets} } tcp dport ${toString cfg.port} accept
            ip6 saddr { ${concatStringsSep ", " cfg.localNetworkSubnets6} } tcp dport ${toString cfg.port} accept
          '';
        }
        else {
          extraCommands = concatStringsSep "\n" (
            (map (subnet: "iptables -A nixos-fw -p tcp --source ${subnet} --dport ${toString cfg.port} -j nixos-fw-accept") cfg.localNetworkSubnets)
            ++ (map (subnet: "ip6tables -A nixos-fw -p tcp --source ${subnet} --dport ${toString cfg.port} -j nixos-fw-accept") cfg.localNetworkSubnets6)
          );
        }
      ))
    ];
  };
}
