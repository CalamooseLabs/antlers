# Home-manager module: `programs.unifi-protect-viewer` — installs the Wayland viewer with
# baked-in defaults so a bare `unifi-protect-viewer` opens your server/cameras. It wraps the
# viewer package, exporting UPM_SERVER/UPM_CAMERAS; runtime `--server`/`--cameras` still
# override (the viewer parses args after the env defaults). Wired into the root flake as
#   homeManagerModules.unifi-protect-viewer = import ./flakes/unifi-protect-monitor/viewer-module.nix self
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  system = pkgs.stdenv.hostPlatform.system;
  cfg = config.programs.unifi-protect-viewer;

  # The wrapper keeps the same binary name; runtime args win over these env defaults.
  wrapped = pkgs.writeShellScriptBin "unifi-protect-viewer" ''
    ${optionalString (cfg.server != null) "export UPM_SERVER=${escapeShellArg cfg.server}"}
    ${optionalString (cfg.cameras != []) "export UPM_CAMERAS=${escapeShellArg (concatStringsSep "," cfg.cameras)}"}
    exec ${cfg.package}/bin/unifi-protect-viewer "$@"
  '';
in {
  options.programs.unifi-protect-viewer = {
    enable = mkEnableOption "the UniFi Protect Wayland viewer with baked-in server/cameras defaults";

    package = mkOption {
      type = types.package;
      default = flake.packages.${system}.unifi-protect-viewer;
      defaultText = literalExpression "unifi-protect-monitor.packages.\${system}.unifi-protect-viewer";
      description = "The viewer package to wrap.";
    };

    server = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "http://10.10.10.20:8460";
      description = "Default backend URL. Bare `unifi-protect-viewer` opens this; `--server` overrides it.";
    };

    cameras = mkOption {
      type = types.listOf types.str;
      default = [];
      example = ["Nursery" "Backyard"];
      description = "Default cameras (by name). Empty = the full dashboard; one or more = the minimal, chrome-free, audio-on multiview. `--cameras` overrides it.";
    };
  };

  config = mkIf cfg.enable {
    home.packages = [wrapped];
  };
}
