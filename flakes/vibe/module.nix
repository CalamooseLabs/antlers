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
        inherit (pcfg) model effort permissions subscriptionAuth extraSettings extraArgs;
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
    extraEnv = scfg.extraEnv;
    projectsDir = scfg.projectsDir;
    newProjectTemplate =
      if scfg.newProjectTemplate != null
      then toString scfg.newProjectTemplate
      else null;
    inherit (scfg) requireTLS sessionNamePrefix maxLogBytes;
  });

  # Auto-relax ProtectHome when any project dir (or the Claude config dir) lives
  # under /home — otherwise the sandbox hides it even when listed in ReadWritePaths.
  homePaths =
    (map (d: d.path) scfg.directories)
    ++ (optional (scfg.claudeConfigDir != null) (toString scfg.claudeConfigDir))
    ++ (optional (scfg.projectsDir != null) scfg.projectsDir);
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
      default = "opus[1m]";
      example = "claude-opus-4-8[1m]";
      description = "Model alias or full id pinned for vibe sessions (settings.json `model`). Defaults to `opus[1m]` (latest Opus + 1M context) — included on Max/Team/Enterprise plans; on Pro the 1M window draws usage credits. Use `\"opus\"` for the standard 200K window, or null to leave the model unpinned. Applies to both interactive and Remote Control sessions (delivered via `--settings`); the remote client at claude.ai / mobile may still switch model client-side.";
    };

    effort = mkOption {
      type = types.nullOr (types.enum ["low" "medium" "high" "xhigh" "max"]);
      default = null;
      description = "Reasoning effort pinned for vibe sessions (settings.json `effortLevel`). Applies to both interactive and Remote Control sessions (delivered via `--settings`).";
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
      description = "Claude Code `permissions` object baked into the session settings.json. Applies to both interactive and Remote Control sessions — delivered via `--settings`, so the full object is honoured, not just `defaultMode`.";
    };

    subscriptionAuth = mkOption {
      type = types.bool;
      default = true;
      description = "Target Claude Code subscription plans (Max/Team/Pro): the wrapper drops a stray ANTHROPIC_API_KEY so sessions use the plan's OAuth login (from ~/.claude / CLAUDE_CONFIG_DIR) instead of silently billing the API. Set false (or VIBE_API_KEY_AUTH=1 at runtime) for genuine API-key billing.";
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

    extraEnv = mkOption {
      type = types.listOf types.str;
      default = [];
      example = ["GITHUB_TOKEN"];
      description = "Additional environment-variable NAMES (not values) to propagate from the service into spawned sessions, on top of the built-in allowlist (PATH, HOME, CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY, …). Values come from the service environment (e.g. environmentFile). Anything not listed is dropped so stray secrets don't reach Claude Code or its browser-readable logs.";
    };

    projectsDir = mkOption {
      type = types.nullOr types.str;
      default = "${stateDir}/projects";
      description = "Base directory under which the web UI may create/register projects (the \"Add directory\" form). New projects are scaffolded from `newProjectTemplate` here, then `git init`-ed. Set to null to disable directory management from the UI. A non-null path is created (systemd-tmpfiles) and made writable to the service.";
    };

    newProjectTemplate = mkOption {
      type = types.nullOr types.str;
      default = "${flake}/templates/vibe-shell";
      defaultText = literalExpression "the antlers vibe-shell template";
      description = "Template directory copied into a newly-created project. Defaults to the antlers `vibe-shell` template; set to null to create empty directories instead.";
    };

    sessionNamePrefix = mkOption {
      type = types.str;
      default = "";
      example = "prod";
      description = "Prefix prepended to generated Remote Control session names (e.g. \"prod\" → `prod-antlers-a1b2`). Empty for none.";
    };

    requireTLS = mkOption {
      type = types.bool;
      default = false;
      description = "Reject plain-HTTP requests at the app (HTTP 426, except /healthz) — set when a TLS reverse proxy fronts vibe and forwards `x-forwarded-proto: https`. vibe-server itself does not terminate TLS.";
    };

    maxLogBytes = mkOption {
      type = types.ints.unsigned;
      default = 26214400;
      description = "Cap each session's captured log in bytes (0 = unlimited). Past the cap, appends stop and a truncation notice is written (a size cap, not rotation — rotation would break the live SSE tail).";
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
      description = "EnvironmentFile for the service (agenix/sops-friendly). For subscription plans prefer `claudeConfigDir` (OAuth) and leave this unset. Only set `ANTHROPIC_API_KEY=…` here for API-key billing — and then also set `programs.vibe.subscriptionAuth = false`, otherwise the wrapper drops the key.";
    };

    claudeConfigDir = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Pre-seeded Claude config dir holding a subscription OAuth login (run `claude` `/login` once as the service user, or copy its `~/.claude`). Exported as CLAUDE_CONFIG_DIR (and made writable). This is the recommended auth path for Max/Team/Pro plans — sessions then bill the subscription, not the API.";
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
      description = "IPv4 subnets allowed when localNetworkOnly is set.";
    };

    localNetworkSubnets6 = mkOption {
      type = types.listOf types.str;
      default = ["fc00::/7" "fe80::/10"];
      description = "IPv6 subnets allowed when localNetworkOnly is set (ULA + link-local by default).";
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

      systemd.tmpfiles.rules =
        optional (scfg.projectsDir != null)
        "d ${scfg.projectsDir} 0750 ${scfg.user} ${scfg.group} -";

      warnings =
        (optional (protectHome == false)
          "services.vibe: ProtectHome disabled because a configured directory lives under /home; the systemd sandbox is loosened accordingly.")
        ++ (optional (scfg.openFirewall && scfg.hostname != "127.0.0.1" && scfg.hostname != "::1" && !scfg.requireTLS)
          "services.vibe: exposed on a non-loopback address over plain HTTP without requireTLS — front it with a TLS reverse proxy (then set services.vibe.requireTLS = true) for anything beyond a trusted LAN.");

      assertions = [
        {
          assertion = all (d: hasPrefix "/" d.path) scfg.directories;
          message = "services.vibe.directories: every path must be absolute (start with /).";
        }
        {
          assertion = all (d: builtins.match "[A-Za-z0-9_-]+" d.name != null) scfg.directories;
          message = "services.vibe.directories: every name must match [A-Za-z0-9_-]+ (the web UI rejects other names).";
        }
      ];

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
              ++ (optional (scfg.claudeConfigDir != null) (toString scfg.claudeConfigDir))
              ++ (optional (scfg.projectsDir != null) scfg.projectsDir);

            # Extra hardening, safe for a Deno/Node web service. No
            # SystemCallFilter (and no MemoryDenyWriteExecute, above) — both
            # break V8's JIT.
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
            # claude (Node) needs INET/INET6 (API), UNIX (nss/IPC), NETLINK (iface enum).
            RestrictAddressFamilies = ["AF_INET" "AF_INET6" "AF_UNIX" "AF_NETLINK"];
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
        # raw iptables/ip6tables otherwise. Default subnets cover RFC1918 (v4) and
        # ULA + link-local (v6).
        (mkIf (scfg.openFirewall && scfg.localNetworkOnly) (
          if config.networking.nftables.enable
          then {
            extraInputRules = ''
              ip saddr { ${concatStringsSep ", " scfg.localNetworkSubnets} } tcp dport ${toString scfg.port} accept
              ip6 saddr { ${concatStringsSep ", " scfg.localNetworkSubnets6} } tcp dport ${toString scfg.port} accept
            '';
          }
          else {
            extraCommands = concatStringsSep "\n" (
              (map (
                  subnet: "iptables -A nixos-fw -p tcp --source ${subnet} --dport ${toString scfg.port} -j nixos-fw-accept"
                )
                scfg.localNetworkSubnets)
              ++ (map (
                  subnet: "ip6tables -A nixos-fw -p tcp --source ${subnet} --dport ${toString scfg.port} -j nixos-fw-accept"
                )
                scfg.localNetworkSubnets6)
            );
          }
        ))
      ];
    })
  ];
}
