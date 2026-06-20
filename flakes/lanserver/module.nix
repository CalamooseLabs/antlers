# NixOS module for LanServer (lives in-tree under antlers/flakes/lanserver).
#
# Wired into the root flake as `nixosModules.lanserver = import ./flakes/lanserver/module.nix self`,
# so `flake.packages.<system>.lanserver` resolves to this repo's lanserver package.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  cfg = config.services.lanserver;

  routeType = types.submodule {
    options = {
      path = mkOption {
        type = types.str;
        description = "HTTP path for the route";
        example = "/shutdown";
      };

      method = mkOption {
        type = types.enum ["GET" "POST" "PUT" "DELETE"];
        default = "GET";
        description = "HTTP method for the route";
      };

      command = mkOption {
        type = types.listOf types.str;
        description = "Command strings to execute when route is accessed";
        example = ["echo 'Shutting down...'" "shutdown 0"];
      };

      data = mkOption {
        type = types.nullOr (types.attrsOf types.str);
        default = null;
        description = "Expected data fields for POST requests";
        example = {serviceName = "string";};
      };
    };
  };

  configFile = pkgs.writeText "lanserver-config.json" (builtins.toJSON {
    port = cfg.port;
    runAsRoot = cfg.runAsRoot;
    routes = cfg.routes;
  });
in {
  options.services.lanserver = {
    enable = mkEnableOption "LAN command server";

    port = mkOption {
      type = types.port;
      default = 8080;
      description = "Port to listen on";
    };

    runAsRoot = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to run the server as root";
    };

    routes = mkOption {
      type = types.listOf routeType;
      default = [];
      description = "List of routes and their associated command strings";
    };

    localNetworkOnly = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to restrict access to local network only";
    };

    localNetworkSubnets = mkOption {
      type = types.listOf types.str;
      default = ["192.168.0.0/16" "10.0.0.0/8" "172.16.0.0/12"];
      description = "Local network subnets to allow access from";
    };

    enableNixLd = mkOption {
      type = types.bool;
      default = true;
      description = "Whether to enable nix-ld for running the compiled Deno binary";
    };
  };

  config = mkIf cfg.enable {
    # Enable nix-ld for running unpatched Deno binaries
    programs.nix-ld = mkIf cfg.enableNixLd {
      enable = true;
      libraries = with pkgs; [
        stdenv.cc.cc.lib
        glibc
        zlib
        openssl
      ];
    };

    # Create config directory and file
    environment.etc."lanserver/config.json".source = configFile;

    # Create the systemd service using the compiled binary from the flake
    systemd.services.lanserver = {
      description = "LAN Command Server";
      after = ["network.target"];
      wantedBy = ["multi-user.target"];

      path = with pkgs;
        [
          bash
          coreutils
          systemd
          util-linux
        ]
        ++ (
          if cfg.runAsRoot
          then [pkgs.sudo]
          else []
        );

      serviceConfig =
        {
          Type = "simple";
          User =
            if cfg.runAsRoot
            then "root"
            else "lanserver";
          Group =
            if cfg.runAsRoot
            then "root"
            else "lanserver";
          # Use the compiled binary from the flake package
          ExecStart = "${flake.packages.${pkgs.stdenv.hostPlatform.system}.lanserver}/bin/lanserver";
          Restart = "always";
          RestartSec = "10";

          Environment = [
            "PATH=/run/current-system/sw/bin:/run/current-system/sw/sbin"
          ];
        }
        // (optionalAttrs (!cfg.runAsRoot) {
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          ReadWritePaths = ["/tmp"];
        });
    };

    # Create user if not running as root
    users.users = mkIf (!cfg.runAsRoot) {
      lanserver = {
        isSystemUser = true;
        group = "lanserver";
        description = "LAN server user";
      };
    };

    users.groups = mkIf (!cfg.runAsRoot) {
      lanserver = {};
    };

    # Firewall configuration
    networking.firewall = mkMerge [
      (mkIf (!cfg.localNetworkOnly) {
        allowedTCPPorts = [cfg.port];
      })

      (mkIf cfg.localNetworkOnly {
        extraCommands = concatStringsSep "\n" (
          map (
            subnet: "iptables -A nixos-fw -p tcp --source ${subnet} --dport ${toString cfg.port} -j nixos-fw-accept"
          )
          cfg.localNetworkSubnets
        );
      })
    ];
  };
}
