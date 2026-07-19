# NixOS module for unifi-protect-monitor (the Deno camera-wall web service) and an
# optional full-screen kiosk viewer.
#
# Wired into the antlers root flake.nix as
#   nixosModules.unifi-protect-monitor = import ./flakes/unifi-protect-monitor/module.nix self
# Exposes `services.unifi-protect-monitor`. Patterned on robomoose/module.nix: renders
# /etc/unifi-protect-monitor/config.json, runs the compiled Deno binary under nix-ld in a
# hardened systemd unit, and (optionally) runs the viewer as a cage kiosk.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  system = pkgs.stdenv.hostPlatform.system;
  cfg = config.services.unifi-protect-monitor;
  serverPkg = flake.packages.${system}.unifi-protect-monitor;
  viewerPkg = flake.packages.${system}.unifi-protect-viewer;

  # Effective Protect API base URL: explicit consoleUrl > cloud console > local IP.
  consoleUrl =
    if cfg.consoleUrl != null
    then cfg.consoleUrl
    else if cfg.cloud.consoleId != null
    then "https://api.ui.com/v1/connector/consoles/${cfg.cloud.consoleId}/proxy/protect/integration"
    else if cfg.consoleIP != null
    then "https://${cfg.consoleIP}/proxy/protect/integration"
    else ""; # asserted below

  ffmpegPath = "${cfg.ffmpegPackage}/bin/ffmpeg";
  ffprobePath = "${cfg.ffmpegPackage}/bin/ffprobe";

  quotePath = p: ''"${p}"'';

  # EXACTLY the keys config.ts (parseConfig) accepts — it rejects unknown keys, so this
  # attrset must carry no extras. The API key stays out of this file unless the operator
  # chose the inline-string option (then it lands in the store — see the apiKey warning).
  configFile = pkgs.writeText "unifi-protect-monitor-config.json" (builtins.toJSON {
    inherit (cfg) port hostname stateDir streamQualities defaultQuality focusQuality snapshotCacheMs eventBufferPerCamera;
    inherit consoleUrl ffmpegPath ffprobePath;
    apiKey =
      if cfg.apiKeyFile != null
      then ""
      else cfg.apiKey;
    apiKeyFile =
      if cfg.apiKeyFile != null
      then toString cfg.apiKeyFile
      else null;
    passwordFile =
      if cfg.passwordFile != null
      then toString cfg.passwordFile
      else null;
    # Recorded-video playback (opt-in; internal API session auth).
    recordingsEnabled = cfg.recordings.enable;
    recordingUsername = cfg.recordings.username;
    recordingPasswordFile =
      if cfg.recordings.passwordFile != null
      then toString cfg.recordings.passwordFile
      else null;
    recordingChannel = cfg.recordings.channel;
    maxClipDurationMs = cfg.recordings.maxClipDurationSeconds * 1000;
  });

  anyUnderHome = p: p == "/home" || hasPrefix "/home/" p;

  # Kiosk launcher: bake server/cameras into a wrapper cage runs as its client.
  kioskCameras = concatStringsSep "," cfg.kiosk.cameras;
  kioskServer =
    if cfg.kiosk.server != null
    then cfg.kiosk.server
    else "http://127.0.0.1:${toString cfg.port}";
  kioskWrapper = pkgs.writeShellScript "unifi-protect-kiosk" ''
    export UPM_SERVER=${escapeShellArg kioskServer}
    export UPM_CAMERAS=${escapeShellArg kioskCameras}
    exec ${viewerPkg}/bin/unifi-protect-viewer
  '';
in {
  options.services.unifi-protect-monitor = {
    enable = mkEnableOption "the UniFi Protect camera-wall web service";

    package = mkOption {
      type = types.package;
      default = serverPkg;
      defaultText = literalExpression "unifi-protect-monitor.packages.\${system}.unifi-protect-monitor";
      description = "The backend package to run.";
    };

    viewerPackage = mkOption {
      type = types.package;
      default = viewerPkg;
      defaultText = literalExpression "unifi-protect-monitor.packages.\${system}.unifi-protect-viewer";
      description = "The Wayland viewer package used by the optional kiosk.";
    };

    port = mkOption {
      type = types.port;
      default = 8460;
      description = "Port the web UI listens on.";
    };

    hostname = mkOption {
      type = types.str;
      default = "0.0.0.0";
      description = "Address the web UI binds to.";
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/unifi-protect-monitor";
      description = "State directory (cookie secret, etc.). The compiled binary's --allow-write is unscoped, so any path works, but the systemd sandbox only makes this one writable.";
    };

    # ---- Protect API endpoint (set exactly one of consoleUrl / consoleIP / cloud.consoleId) ----
    consoleUrl = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "https://192.168.1.1/proxy/protect/integration";
      description = "Full base URL of the UniFi Protect Integration API. Overrides consoleIP / cloud.consoleId.";
    };

    consoleIP = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "192.168.1.1";
      description = "Local console IP/host — expands to https://<ip>/proxy/protect/integration. Ignored if consoleUrl is set.";
    };

    cloud.consoleId = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "UniFi cloud console id — routes via https://api.ui.com/.../proxy/protect/integration. Ignored if consoleUrl/consoleIP is set.";
    };

    # ---- API key (set exactly one) ----
    apiKey = mkOption {
      type = types.str;
      default = "";
      description = "The Protect X-API-KEY as an inline string. CONVENIENT BUT INSECURE: it is written world-readably into the Nix store (and /etc config). Prefer apiKeyFile with agenix/sops for anything real.";
    };

    apiKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/protect-api-key";
      description = "File whose contents are the Protect X-API-KEY (read at runtime, never copied to the store). Wins over apiKey. agenix/sops-friendly.";
    };

    # ---- streaming ----
    ffmpegPackage = mkOption {
      type = types.package;
      default = pkgs.ffmpeg-headless;
      defaultText = literalExpression "pkgs.ffmpeg-headless";
      description = "ffmpeg build providing `ffmpeg` and `ffprobe` for the RTSPS -> fMP4 bridge.";
    };

    streamQualities = mkOption {
      type = types.listOf (types.enum ["high" "medium" "low" "package"]);
      default = ["high" "medium" "low"];
      description = "Quality levels to create/enable on the console (POST /rtsps-stream) when a stream is first requested.";
    };

    defaultQuality = mkOption {
      type = types.enum ["high" "medium" "low" "package"];
      default = "medium";
      description = "Quality used for grid tiles (kept modest so a wall of cameras stays light).";
    };

    focusQuality = mkOption {
      type = types.enum ["high" "medium" "low" "package"];
      default = "high";
      description = "Quality used for the enlarged single-camera view and single-camera focus mode.";
    };

    snapshotCacheMs = mkOption {
      type = types.ints.unsigned;
      default = 2000;
      description = "Browser cache lifetime for proxied JPEG snapshots. Sent as Cache-Control max-age, which is whole seconds, so this is rounded down to seconds with a 1s floor (2000 → 2s; values < 1000 → 1s).";
    };

    eventBufferPerCamera = mkOption {
      type = types.ints.unsigned;
      default = 200;
      description = "How many recent events to keep per camera (in memory) to seed the timeline strip.";
    };

    # ---- recorded-video playback (OPT-IN) ----
    # The recorded-footage timeline uses the console's INTERNAL API, which the X-API-KEY
    # does NOT authenticate — it needs a UniFi-OS local-admin session (username/password).
    # All off by default: an API-key-only deploy is unaffected (the routes 404, the UI
    # keeps its live-only timeline).
    recordings = {
      enable = mkEnableOption "recorded-video playback (a timeline scrubber) via the internal Protect API — requires a local-admin login (the X-API-KEY does NOT work there)";

      username = mkOption {
        type = types.str;
        default = "";
        description = "Local-admin username for POST /api/auth/login. Use a dedicated LOCAL-ONLY admin account (exempt from cloud MFA).";
      };

      passwordFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        example = "/run/secrets/protect-local-admin-password";
        description = "File with that admin's password (read at runtime, never in the store). agenix/sops-friendly.";
      };

      channel = mkOption {
        type = types.enum [0 1 2];
        default = 0;
        description = "Export stream channel: 0=high, 1=medium, 2=low.";
      };

      maxClipDurationSeconds = mkOption {
        type = types.ints.positive;
        default = 120;
        description = "Max single exported-clip window (seconds). Caps export load so a long scrub range can't stall the console.";
      };
    };

    # ---- web ----
    passwordFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/protect-monitor-password";
      description = "File with the shared login password (read at runtime). null (default) runs passwordless — fine on a trusted LAN / behind the kiosk; set it (and restrict the network) when exposed further.";
    };

    user = mkOption {
      type = types.str;
      default = "unifi-protect-monitor";
      description = "User the service runs as (auto-created only for the default name).";
    };

    group = mkOption {
      type = types.str;
      default = "unifi-protect-monitor";
      description = "Group the service runs as (auto-created only for the default name).";
    };

    enableNixLd = mkOption {
      type = types.bool;
      default = true;
      description = "Enable nix-ld so the compiled Deno binary (a generic ELF) can run.";
    };

    protectHome = mkOption {
      type = types.nullOr (types.either types.bool (types.enum ["tmpfs" "read-only"]));
      default = null;
      description = "Override systemd ProtectHome. null auto-derives: false if a secret file lives under /home, else \"tmpfs\".";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the web UI port in the firewall.";
    };

    localNetworkOnly = mkOption {
      type = types.bool;
      default = false;
      description = "When opening the firewall, restrict access to local-network subnets only.";
    };

    localNetworkSubnets = mkOption {
      type = types.listOf types.str;
      default = ["192.168.0.0/16" "10.0.0.0/8" "172.16.0.0/12"];
      description = "IPv4 subnets allowed when localNetworkOnly is set.";
    };

    localNetworkSubnets6 = mkOption {
      type = types.listOf types.str;
      default = ["fc00::/7" "fe80::/10"];
      description = "IPv6 subnets allowed when localNetworkOnly is set (ULA + link-local).";
    };

    # ---- optional kiosk (the Wayland viewer as a dedicated always-on panel) ----
    kiosk = {
      enable = mkEnableOption "a full-screen cage kiosk running the viewer on this host (a wall panel / bedside monitor)";

      user = mkOption {
        type = types.str;
        default = "protect-kiosk";
        description = "User the cage kiosk session runs as (auto-created for the default name; added to video/input/render/seat groups).";
      };

      cameras = mkOption {
        type = types.listOf types.str;
        default = [];
        example = ["Nursery" "Backyard"];
        description = "Cameras to show (by name). Empty = the full dashboard multiview; one or more = the minimal, chrome-free, audio-on multiview.";
      };

      server = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Backend URL the kiosk opens. null = http://127.0.0.1:<port> (this host).";
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = (cfg.consoleUrl != null) || (cfg.consoleIP != null) || (cfg.cloud.consoleId != null);
        message = "services.unifi-protect-monitor: set one of consoleUrl, consoleIP, or cloud.consoleId.";
      }
      {
        assertion = (cfg.apiKey != "") != (cfg.apiKeyFile != null);
        message = "services.unifi-protect-monitor: set EXACTLY one of apiKey (inline) or apiKeyFile.";
      }
      {
        assertion = !cfg.recordings.enable || (cfg.recordings.username != "" && cfg.recordings.passwordFile != null);
        message = "services.unifi-protect-monitor.recordings: enable needs both recordings.username and recordings.passwordFile (a local-admin session — the X-API-KEY does not work on the internal recorded-video API).";
      }
      {
        # The internal session login (/api/auth/login) is a LOCAL-console feature; the cloud
        # connector (api.ui.com/.../consoles/<id>) does not expose it, so recordings can't work there.
        assertion = !cfg.recordings.enable || cfg.cloud.consoleId == null;
        message = "services.unifi-protect-monitor.recordings: recorded playback needs a LOCAL console (consoleIP / a local consoleUrl) — the internal session-login API isn't reachable via cloud.consoleId. Disable recordings or use a local console endpoint.";
      }
    ];

    warnings =
      (optional (cfg.apiKey != "" && cfg.apiKeyFile == null)
        "services.unifi-protect-monitor: apiKey is an inline string — it is written world-readably into the Nix store and /etc/unifi-protect-monitor/config.json. Use apiKeyFile (agenix/sops) instead for anything real.")
      ++ (optional (cfg.passwordFile == null && cfg.openFirewall && cfg.hostname != "127.0.0.1" && cfg.hostname != "::1")
        "services.unifi-protect-monitor: no passwordFile set — the camera UI is passwordless and anyone who can reach it can view your cameras (with audio). Set passwordFile or restrict the network when exposing it beyond a trusted host.")
      ++ (optional (cfg.kiosk.enable && ((config.services.greetd.enable or false) || (config.services.displayManager.enable or false) || (config.services.xserver.enable or false)))
        "services.unifi-protect-monitor.kiosk: the cage kiosk takes over tty1 and the graphical target, which conflicts with the greetd/display-manager this host also enables — they race for the VT and one silently loses. Use kiosk.enable only on a dedicated host with no other seat/display manager.")
      ++ (optional cfg.recordings.enable
        "services.unifi-protect-monitor.recordings: this stores a real console ADMIN credential (username + password) and uses the undocumented internal API. Use a dedicated LOCAL-ONLY admin account (exempt from cloud MFA), and keep the password in agenix/sops (recordings.passwordFile), not inline.");

    programs.nix-ld = mkIf cfg.enableNixLd {
      enable = true;
      libraries = with pkgs; [stdenv.cc.cc.lib glibc zlib openssl];
    };

    environment.etc."unifi-protect-monitor/config.json".source = configFile;

    systemd.services.unifi-protect-monitor = {
      description = "UniFi Protect camera-wall web service";
      after = ["network-online.target"];
      wants = ["network-online.target"];
      wantedBy = ["multi-user.target"];

      # ffmpeg/ffprobe are spawned by name for the RTSPS -> fMP4 bridge.
      path = [cfg.ffmpegPackage];

      serviceConfig = {
        Type = "exec";
        User = cfg.user;
        Group = cfg.group;
        ExecStart = "${cfg.package}/bin/unifi-protect-monitor";
        Restart = "always";
        RestartSec = "5";

        StateDirectory = "unifi-protect-monitor";
        StateDirectoryMode = "0750";

        Environment = [
          "HOME=${cfg.stateDir}"
          "UPM_CONFIG=/etc/unifi-protect-monitor/config.json"
        ];

        # Filesystem confinement is the real sandbox (the Deno binary is built with broad
        # --allow-*). NEVER set MemoryDenyWriteExecute or SystemCallFilter — both break
        # V8's JIT.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome =
          if cfg.protectHome != null
          then cfg.protectHome
          else if
            (cfg.apiKeyFile != null && anyUnderHome (toString cfg.apiKeyFile))
            || (cfg.passwordFile != null && anyUnderHome (toString cfg.passwordFile))
            || (cfg.recordings.passwordFile != null && anyUnderHome (toString cfg.recordings.passwordFile))
          then false
          else "tmpfs";
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
        RestrictAddressFamilies = ["AF_INET" "AF_INET6" "AF_UNIX" "AF_NETLINK"];
      };
    };

    # Service user + (optionally) the kiosk user — merged so both mkIf branches apply.
    users.users = mkMerge [
      (mkIf (cfg.user == "unifi-protect-monitor") {
        unifi-protect-monitor = {
          isSystemUser = true;
          group = cfg.group;
          home = cfg.stateDir;
          description = "unifi-protect-monitor service user";
        };
      })
      (mkIf (cfg.kiosk.enable && cfg.kiosk.user == "protect-kiosk") {
        protect-kiosk = {
          isSystemUser = true;
          group = "protect-kiosk";
          extraGroups = ["video" "input" "render" "seat"];
          home = "/var/lib/protect-kiosk";
          createHome = true;
          description = "unifi-protect-monitor kiosk session user";
        };
      })
    ];
    users.groups = mkMerge [
      (mkIf (cfg.group == "unifi-protect-monitor") {unifi-protect-monitor = {};})
      (mkIf (cfg.kiosk.enable && cfg.kiosk.user == "protect-kiosk") {protect-kiosk = {};})
    ];

    networking.firewall = mkMerge [
      (mkIf (cfg.openFirewall && !cfg.localNetworkOnly) {
        allowedTCPPorts = [cfg.port];
      })
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

    # ---- optional kiosk: run the viewer full-screen via cage ----
    services.cage = mkIf cfg.kiosk.enable {
      enable = true;
      user = cfg.kiosk.user;
      program = toString kioskWrapper;
    };
  };
}
