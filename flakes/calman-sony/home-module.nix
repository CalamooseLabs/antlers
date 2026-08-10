# home-manager module: programs.calman-sony — installs the seamless RemoteApp
# launcher (+ its .desktop entry) for Calman Home for Sony. Pairs with the
# NixOS `services.calman-sony` module that declares the background Windows VM.
#
# The launcher is built from ./package.nix (a FUNCTION of config, like
# mkVibeWrapper / mkMoosefetch), so the RDP host/user/app path are baked per user.
#
# Wired as `homeManagerModules.calman-sony = import ./flakes/calman-sony/home-module.nix self`.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  cfg = config.programs.calman-sony;
  mkCalmanSony = pkgs.callPackage ./package.nix {};
  builtPkg = mkCalmanSony {
    inherit (cfg) domain rdpHost rdpUser appPath connectUri rdpTimeout;
  };
in {
  options.programs.calman-sony = {
    enable = mkEnableOption "the Calman Home for Sony seamless RemoteApp launcher (scaffold)";

    package = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = "Override the launcher package; null builds one from the options below.";
    };

    domain = mkOption {
      type = types.str;
      default = "calman-sony";
      description = "libvirt domain name of the Windows VM (match services.calman-sony.domain).";
    };

    rdpHost = mkOption {
      type = types.str;
      default = "REPLACE_ME_GUEST_IP";
      description = "The Windows VM's IP on your calibration LAN (bridged NIC).";
    };

    rdpUser = mkOption {
      type = types.str;
      default = "calibrator";
      description = "A Windows Pro user with RDP / RemoteApp rights.";
    };

    appPath = mkOption {
      type = types.str;
      default = ''C:\Program Files\Portrait Displays\Calman\Calman.exe'';
      description = "CONFIRM — Windows-side path to the Calman executable.";
    };

    connectUri = mkOption {
      type = types.str;
      default = "qemu:///system";
      description = "libvirt connection URI used to start the VM.";
    };

    rdpTimeout = mkOption {
      type = types.ints.positive;
      default = 120;
      description = "Seconds to wait for the guest's RDP port before giving up.";
    };
  };

  config = mkIf cfg.enable {
    home.packages = [
      (
        if cfg.package != null
        then cfg.package
        else builtPkg
      )
    ];
  };
}
