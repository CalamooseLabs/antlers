# NixOS module for the vibe web service (lives in-tree under antlers/flakes/vibe-server).
#
# Wired into the root flake as
# `nixosModules.vibe-server = import ./flakes/vibe-server/module.nix self`.
# This module exposes ONLY `services.vibe-server` — it runs `vibe-server`, the Deno web UI
# that manages Claude Code sessions (spawned via the `vibe` launcher in Remote
# Control mode). The launcher itself is a separate module: `nixosModules.vibe`
# (→ `programs.vibe`). When both are imported, sessions default to the launcher
# built from `programs.vibe` (same model/effort/permissions); imported alone,
# vibe-server falls back to a default-config launcher and stands on its own.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  system = pkgs.stdenv.hostPlatform.system;

  scfg = config.services.vibe-server;

  # The `vibe` launcher lives under ../vibe; build one with mkVibeWrapper.
  mkVibeWrapper = pkgs.callPackage ../vibe/package.nix {};

  # If the programs.vibe module is also imported, default the per-session launcher
  # to the one IT builds (so the service honours the same model/effort/permissions
  # pins). Imported on its own, fall back to a default-config launcher so the
  # service has no dependency on programs.vibe being present.
  hasPrograms = config.programs ? vibe;
  pcfg = optionalAttrs hasPrograms config.programs.vibe;
  vibeWrapper =
    if hasPrograms && pcfg.package != null
    then pcfg.package
    else if hasPrograms
    then
      mkVibeWrapper {
        inherit (pcfg) model effort ultracode permissionMode permissions subscriptionAuth extraSettings extraArgs;
        remoteControl = pcfg.remoteControl.enable;
        remoteControlName = pcfg.remoteControl.name;
        namePrefix = pcfg.remoteControl.prefix;
      }
    else mkVibeWrapper {remoteControl = true;};

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

  # Effective identity the unit runs under — root when runAsRoot, else user/group.
  runUser =
    if scfg.runAsRoot
    then "root"
    else scfg.user;
  runGroup =
    if scfg.runAsRoot
    then "root"
    else scfg.group;

  # systemd list-valued settings (ReadWritePaths, …) are split on whitespace
  # *within* a value, so a path containing spaces must be double-quoted or
  # systemd truncates it at the first space (→ "set up mount namespacing:
  # /home/hub/01: No such file or directory"). Quoting plain paths is harmless.
  quotePath = p: ''"${p}"'';

  configFile = pkgs.writeText "vibe-config.json" (builtins.toJSON {
    inherit (scfg) port hostname;
    inherit stateDir;
    passwordFile =
      if scfg.passwordFile != null
      then toString scfg.passwordFile
      else "";
    directories = map (d: {inherit (d) name path;}) scfg.directories;
    sessionCommand = scfg.sessionCommand;
    extraEnv = scfg.extraEnv;
    projectsDir = scfg.projectsDir;
    newProjectTemplate =
      if scfg.newProjectTemplate != null
      then toString scfg.newProjectTemplate
      else null;
    inherit (scfg) requireTLS sessionNamePrefix maxLogBytes pty seedClaudeOnboarding claudeTheme;
  });

  # Where Claude stores its config (onboarding/theme/trust in .claude.json, the
  # OAuth login in .credentials.json). Pinned so the location is deterministic and
  # both the login flow and spawned sessions read/write the same place.
  claudeConfigDirPath =
    if scfg.claudeConfigDir != null
    then toString scfg.claudeConfigDir
    else "${stateDir}/.claude";

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
  options.services.vibe-server = {
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
      defaultText = literalExpression "the launcher built from programs.vibe options (or a default-config launcher if that module is not imported)";
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
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/vibe-password";
      description = "File whose contents are the shared login password (read at runtime, never copied to the store). When null (the default), the web UI is passwordless — anyone who can reach it signs in automatically. Set this (and front the service with TLS / restrict the network) for anything beyond a trusted host.";
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

    runAsRoot = mkOption {
      type = types.bool;
      default = false;
      description = "Run the service (and the sessions it spawns) as root instead of `user`/`group`. Convenient when sessions need access to directories owned by assorted users (e.g. personal project dirs under /home, or /etc/nixos) — but it forgoes the privilege separation the dedicated `vibe` user provides, so prefer a real `user`/`group` with the right permissions where you can. When true, `user`/`group` are ignored and the `vibe` user/group is not created.";
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
      description = "Claude config dir holding the subscription OAuth login (in `.credentials.json`). Exported as CLAUDE_CONFIG_DIR and made writable; when null it defaults to `<stateDir>/.claude`. You can authenticate the service user directly from the web UI (the \"Log in to Claude\" banner runs `claude auth login` and stores the login here), pre-seed it (run `claude auth login` once as the service user, or copy a `~/.claude`), or point it at an existing login. This is the recommended auth path for Max/Team/Pro plans — sessions then bill the subscription, not the API.";
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

    pty = mkOption {
      type = types.bool;
      default = true;
      description = "Allocate a pseudo-terminal (via util-linux `script`) for each spawned session. Required for interactive `claude --remote-control`: without a TTY, Claude Code falls into headless `--print` mode and exits with \"Input must be provided … when using --print\". Set false only for a genuinely non-interactive `sessionCommand` (e.g. `claude -p …`).";
    };

    seedClaudeOnboarding = mkOption {
      type = types.bool;
      default = true;
      description = "Seed the Claude config dir's `.claude.json` (hasCompletedOnboarding + theme + per-directory trust) at startup and before each spawn, so a fresh service user's sessions don't block on Claude Code's first-run theme picker or workspace-trust dialog. The seed is written by the server process, whose write scope is fixed at build time to the state dir, so it only takes effect when the config dir is under `${stateDir}` (the default); a custom `claudeConfigDir` elsewhere must be pre-seeded (a warning is emitted). Set false if you fully manage the config dir yourself.";
    };

    claudeTheme = mkOption {
      type = types.str;
      default = "dark";
      example = "light";
      description = "Theme written into the seeded `.claude.json` so Claude Code doesn't prompt to pick one (only used when seedClaudeOnboarding is true). One of Claude Code's theme names: \"dark\", \"light\", \"dark-daltonized\", \"light-daltonized\", \"dark-ansi\", \"light-ansi\".";
    };
  };

  config = mkIf scfg.enable {
    programs.nix-ld = mkIf scfg.enableNixLd {
      enable = true;
      libraries = with pkgs; [stdenv.cc.cc.lib glibc zlib openssl];
    };

    environment.etc."vibe/config.json".source = configFile;

    systemd.tmpfiles.rules =
      optional (scfg.projectsDir != null)
      "d ${quotePath scfg.projectsDir} 0750 ${runUser} ${runGroup} -";

    warnings =
      (optional (protectHome == false)
        "services.vibe-server: ProtectHome disabled because a configured directory lives under /home; the systemd sandbox is loosened accordingly.")
      ++ (optional (scfg.openFirewall && scfg.hostname != "127.0.0.1" && scfg.hostname != "::1" && !scfg.requireTLS)
        "services.vibe-server: exposed on a non-loopback address over plain HTTP without requireTLS — front it with a TLS reverse proxy (then set services.vibe-server.requireTLS = true) for anything beyond a trusted LAN.")
      ++ (optional (scfg.passwordFile == null && scfg.openFirewall && scfg.hostname != "127.0.0.1" && scfg.hostname != "::1")
        "services.vibe-server: no passwordFile set — the web UI is passwordless and anyone who can reach it can spawn Claude Code sessions. Set services.vibe-server.passwordFile (or restrict the network) when exposing it beyond a trusted host.")
      # The compiled server's Deno --allow-write is fixed at build time to the
      # state dir, so the in-process onboarding seed can only write under it. A
      # custom claudeConfigDir outside it is fine for auth (the `claude` child
      # writes the login), but the seed is skipped → first-run prompts may block.
      ++ (optional (scfg.seedClaudeOnboarding
        && scfg.claudeConfigDir != null
        && claudeConfigDirPath != stateDir
        && !(hasPrefix "${stateDir}/" claudeConfigDirPath))
      "services.vibe-server: claudeConfigDir (${claudeConfigDirPath}) is outside ${stateDir}, so seedClaudeOnboarding cannot write its .claude.json there (the server's write scope is fixed at build time) and sessions may block on Claude Code's first-run theme/trust prompts. Pre-seed that dir (it must hold the login anyway) or keep claudeConfigDir under ${stateDir}.")
      ++ (optional scfg.runAsRoot
        "services.vibe-server: running as root (runAsRoot = true) — the service and every Claude Code session it spawns run with full privileges. Use a dedicated user/group with the right directory permissions instead, where possible.");

    assertions = [
      {
        assertion = all (d: hasPrefix "/" d.path) scfg.directories;
        message = "services.vibe-server.directories: every path must be absolute (start with /).";
      }
      {
        assertion = all (d: builtins.match "[A-Za-z0-9_-]+" d.name != null) scfg.directories;
        message = "services.vibe-server.directories: every name must match [A-Za-z0-9_-]+ (the web UI rejects other names).";
      }
    ];

    systemd.services.vibe-server = {
      description = "vibe web service (browser session manager for Claude Code)";
      after = ["network.target"];
      wantedBy = ["multi-user.target"];

      # setsid (util-linux) is invoked by name to start each session in its own
      # process group; bash/coreutils/git/nix back claude's tool execution.
      path = with pkgs; [bash coreutils util-linux git nix scfg.vibePackage claude-code];

      serviceConfig =
        {
          Type = "exec";
          User = runUser;
          Group = runGroup;
          ExecStart = "${scfg.package}/bin/vibe-server";
          Restart = "always";
          RestartSec = "5";

          StateDirectory = "vibe";
          StateDirectoryMode = "0750";
          RuntimeDirectory = "vibe";

          Environment = [
            "HOME=${stateDir}"
            "CLAUDE_CONFIG_DIR=${claudeConfigDirPath}"
          ];

          # Filesystem confinement is the real sandbox (the Deno binary is built
          # with broad --allow-read/-run). Never set MemoryDenyWriteExecute — it
          # crashes V8's JIT.
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ProtectHome = protectHome;
          # Double-quoted so paths with spaces survive systemd's whitespace split.
          ReadWritePaths = map quotePath (
            [stateDir]
            ++ (map (d: d.path) scfg.directories)
            ++ (optional (scfg.claudeConfigDir != null) (toString scfg.claudeConfigDir))
            ++ (optional (scfg.projectsDir != null) scfg.projectsDir)
          );

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

    users.users = mkIf (!scfg.runAsRoot && scfg.user == "vibe") {
      vibe = {
        isSystemUser = true;
        group = scfg.group;
        home = stateDir;
        description = "vibe service user";
      };
    };
    users.groups = mkIf (!scfg.runAsRoot && scfg.group == "vibe") {vibe = {};};

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
  };
}
