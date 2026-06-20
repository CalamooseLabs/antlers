# NixOS module for vibe (lives in-tree under antlers/flakes/vibe).
#
# Wired into the root flake as `nixosModules.vibe = import ./flakes/vibe/module.nix self`,
# so the service's ExecStart resolves to this repo's vibe-server package. Exposes
# TWO independent option trees, each guarded by its own enable:
#   * programs.vibe — installs a configured `vibe` Claude Code launcher system-wide.
#   * services.vibe — runs the vibe-server web UI (browser session manager); spawns
#                     sessions with the `vibe` launcher in Remote Control mode.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  system = pkgs.system;

  pcfg = config.programs.vibe;
  scfg = config.services.vibe;

  mkVibeWrapper = pkgs.callPackage ./package.nix {};

  # The launcher built from programs.vibe options. Also the default command
  # services.vibe spawns per session (so a session honours the same model/effort).
  vibeWrapper =
    if pcfg.package != null
    then pcfg.package
    else
      mkVibeWrapper {
        inherit (pcfg) model effort permissions extraSettings extraArgs;
        remoteControl = pcfg.remoteControl.enable;
        remoteControlName = pcfg.remoteControl.name;
      };

  serverPkg = flake.packages.${system}.vibe-server;

  dirType = types.submodule {
    options = {
      name = mkOption {
        type = types.str;
        example = "antlers";
        description = "Short label shown in the web UI.";
      };
      path = mkOption {
        type = types.str;
        example = "/srv/projects/antlers";
        description = "Absolute path of the directory a vibe session runs in.";
      };
    };
  };

  # Default per-session command: the vibe launcher in remote-control mode, named
  # after the session. @DIR@/@NAME@ are substituted by the server at spawn time
  # (cwd is set to the chosen directory). Fully overridable via sessionCommand.
  defaultSessionCommand =
    ["${scfg.vibePackage}/bin/vibe"]
    ++ optionals scfg.remoteControl.enable ["--remote-control" "@NAME@"];

  stateDir = "/var/lib/vibe";

  configFile = pkgs.writeText "vibe-config.json" (builtins.toJSON {
    inherit (scfg) port hostname;
    inherit stateDir;
    passwordFile = toString scfg.passwordFile;
    directories = map (d: {inherit (d) name path;}) scfg.directories;
    sessionCommand = scfg.sessionCommand;
  });

  # Auto-relax ProtectHome when any project dir (or the Claude config dir) lives
  # under /home — otherwise the sandbox hides it even when listed in ReadWritePaths.
  homePaths =
    (map (d: d.path) scfg.directories)
    ++ (optional (scfg.claudeConfigDir != null) (toString scfg.claudeConfigDir));
  anyUnderHome = any (p: p == "/home" || hasPrefix "/home/" p) homePaths;
  protectHome =
    if scfg.protectHome != null
    then scfg.protectHome
    else if anyUnderHome
    then false
    else "tmpfs";
in {
  options.programs.vibe = {
    enable = mkEnableOption "the vibe Claude Code launcher (`vibe` command)";

    package = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = "Override the built `vibe` launcher. When null it is built from the options below.";
    };

    model = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "opus";
      description = "Model alias or full id pinned for interactive vibe sessions (settings.json `model`). Remote Control sessions choose their model client-side from claude.ai / mobile.";
    };

    effort = mkOption {
      type = types.nullOr (types.enum ["low" "medium" "high" "xhigh"]);
      default = null;
      description = "Reasoning effort pinned for interactive vibe sessions (settings.json `effortLevel`). Not applied to Remote Control sessions (chosen client-side).";
    };

    remoteControl = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Launch `vibe` in Claude Code Remote Control mode by default.";
      };
      name = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Human-readable session name shown in the Remote Control UI.";
      };
    };

    permissions = mkOption {
      type = types.attrs;
      default = {};
      example = literalExpression ''{ defaultMode = "acceptEdits"; }'';
      description = "Claude Code `permissions` object baked into the interactive session settings.json. In Remote Control mode only `defaultMode` is applied (passed as `--permission-mode`).";
    };

    extraSettings = mkOption {
      type = types.attrs;
      default = {};
      description = "Extra keys merged into the generated settings.json.";
    };

    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [];
      description = "Extra arguments appended to every `claude` invocation.";
    };
  };

  options.services.vibe = {
    enable = mkEnableOption "the vibe web service (browser session manager)";

    package = mkOption {
      type = types.package;
      default = serverPkg;
      defaultText = literalExpression "antlers.packages.\${system}.vibe-server";
      description = "The vibe-server package to run.";
    };

    vibePackage = mkOption {
      type = types.package;
      default = vibeWrapper;
      defaultText = literalExpression "the launcher built from programs.vibe options";
      description = "The `vibe` launcher package that sessions are spawned with.";
    };

    port = mkOption {
      type = types.port;
      default = 8420;
      description = "Port the web UI listens on.";
    };

    hostname = mkOption {
      type = types.str;
      default = "0.0.0.0";
      description = "Address the web UI binds to.";
    };

    passwordFile = mkOption {
      type = types.path;
      example = "/run/secrets/vibe-password";
      description = "File whose contents are the shared login password (read at runtime, never copied to the store).";
    };

    directories = mkOption {
      type = types.listOf dirType;
      default = [];
      description = "Predefined directories users may start vibe sessions in.";
    };

    sessionCommand = mkOption {
      type = types.listOf types.str;
      default = defaultSessionCommand;
      defaultText = literalExpression ''["''${vibePackage}/bin/vibe" "--remote-control" "@NAME@"]'';
      description = "Command run to start a session. @DIR@ and @NAME@ are substituted; cwd is the chosen directory.";
    };

    user = mkOption {
      type = types.str;
      default = "vibe";
      description = "User the service (and the sessions it spawns) run as. Only the default \"vibe\" user is auto-created; if you override this, create the user yourself (with a home directory).";
    };

    group = mkOption {
      type = types.str;
      default = "vibe";
      description = "Group the service runs as. Only the default \"vibe\" group is auto-created; if you override this, create the group yourself.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/vibe-env";
      description = "EnvironmentFile for the service, e.g. containing ANTHROPIC_API_KEY=… (agenix/sops-friendly).";
    };

    claudeConfigDir = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "If set, exported as CLAUDE_CONFIG_DIR (and made writable) so sessions use pre-seeded Claude credentials.";
    };

    remoteControl.enable = mkOption {
      type = types.bool;
      default = true;
      description = "Whether the default sessionCommand launches sessions in Claude Code Remote Control mode. When false, set a custom sessionCommand suitable for headless (non-interactive) use.";
    };

    protectHome = mkOption {
      type = types.nullOr (types.either types.bool (types.enum ["tmpfs" "read-only"]));
      default = null;
      description = ''
        Override the systemd ProtectHome setting. When null it is auto-derived:
        `false` if any configured directory is under /home, otherwise "tmpfs".
      '';
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the web UI port in the firewall.";
    };

    localNetworkOnly = mkOption {
      type = types.bool;
      default = false;
      description = "When opening the firewall, restrict access to local network subnets only.";
    };

    localNetworkSubnets = mkOption {
      type = types.listOf types.str;
      default = ["192.168.0.0/16" "10.0.0.0/8" "172.16.0.0/12"];
      description = "Subnets allowed when localNetworkOnly is set.";
    };

    enableNixLd = mkOption {
      type = types.bool;
      default = true;
      description = "Enable nix-ld so the compiled Deno binary can run.";
    };
  };

  config = mkMerge [
    # ---- programs.vibe -------------------------------------------------
    (mkIf pcfg.enable {
      environment.systemPackages = [vibeWrapper];
    })

    # ---- services.vibe -------------------------------------------------
    (mkIf scfg.enable {
      programs.nix-ld = mkIf scfg.enableNixLd {
        enable = true;
        libraries = with pkgs; [stdenv.cc.cc.lib glibc zlib openssl];
      };

      environment.etc."vibe/config.json".source = configFile;

      warnings =
        optional (protectHome == false)
        "services.vibe: ProtectHome disabled because a configured directory lives under /home; the systemd sandbox is loosened accordingly.";

      systemd.services.vibe = {
        description = "vibe web service (browser session manager for Claude Code)";
        after = ["network.target"];
        wantedBy = ["multi-user.target"];

        # setsid (util-linux) is invoked by name to start each session in its own
        # process group; bash/coreutils/git/nix back claude's tool execution.
        path = with pkgs; [bash coreutils util-linux git nix scfg.vibePackage claude-code];

        serviceConfig =
          {
            Type = "exec";
            User = scfg.user;
            Group = scfg.group;
            ExecStart = "${scfg.package}/bin/vibe-server";
            Restart = "always";
            RestartSec = "5";

            StateDirectory = "vibe";
            StateDirectoryMode = "0750";
            RuntimeDirectory = "vibe";

            Environment =
              ["HOME=${stateDir}"]
              ++ optional (scfg.claudeConfigDir != null) "CLAUDE_CONFIG_DIR=${toString scfg.claudeConfigDir}";

            # Filesystem confinement is the real sandbox (the Deno binary is built
            # with broad --allow-read/-run). Never set MemoryDenyWriteExecute — it
            # crashes V8's JIT.
            NoNewPrivileges = true;
            PrivateTmp = true;
            ProtectSystem = "strict";
            ProtectHome = protectHome;
            ReadWritePaths =
              [stateDir]
              ++ (map (d: d.path) scfg.directories)
              ++ (optional (scfg.claudeConfigDir != null) (toString scfg.claudeConfigDir));
          }
          // optionalAttrs (scfg.environmentFile != null) {
            EnvironmentFile = scfg.environmentFile;
          };
      };

      users.users = mkIf (scfg.user == "vibe") {
        vibe = {
          isSystemUser = true;
          group = scfg.group;
          home = stateDir;
          description = "vibe service user";
        };
      };
      users.groups = mkIf (scfg.group == "vibe") {vibe = {};};

      networking.firewall = mkMerge [
        (mkIf (scfg.openFirewall && !scfg.localNetworkOnly) {
          allowedTCPPorts = [scfg.port];
        })
        # Source-restricted open. Use the active firewall backend's own knob:
        # extraInputRules under nftables (extraCommands is silently ignored there),
        # raw iptables otherwise. Default subnets are IPv4 (RFC1918).
        (mkIf (scfg.openFirewall && scfg.localNetworkOnly) (
          if config.networking.nftables.enable
          then {
            extraInputRules = ''
              ip saddr { ${concatStringsSep ", " scfg.localNetworkSubnets} } tcp dport ${toString scfg.port} accept
            '';
          }
          else {
            extraCommands = concatStringsSep "\n" (
              map (
                subnet: "iptables -A nixos-fw -p tcp --source ${subnet} --dport ${toString scfg.port} -j nixos-fw-accept"
              )
              scfg.localNetworkSubnets
            );
          }
        ))
      ];
    })
  ];
}
