# NixOS module: services.calman-sony — declares the background Windows *Pro* VM
# that runs Calman Home for Sony, wired for the Sony BRAVIA AutoCal workflow.
#
# Design (see ./README.md for the reasoning behind every choice):
#   • C6 HDR5000 colorimeter → passed straight into the guest as a USB HOSTDEV
#     (host-level passthrough, NOT RDP/SPICE redirection). The C6 is an OEM
#     rebadge of the X-Rite i1Display3 and enumerates as a plain HID device
#     (VID 0x0765) that Windows binds with its in-box driver; Calman must own it
#     for the whole run, which hostdev guarantees and redirection does not.
#   • BRIDGED NIC on the calibration LAN → so Calman can reach the G1 pattern
#     generator (IP-controlled) and the Sony TV (AutoCal over IP). A NAT guest
#     reaches NEITHER — this is the #1 failure mode, hence a bridge not the
#     default NAT network.
#   • NO GPU passthrough → the PC never sources the video signal (the G1 feeds
#     the TV over HDMI), so none is needed and the RDP colour-accuracy problem
#     does not exist for this workflow.
#
# SCAFFOLD: the domain XML below is a starting point with REPLACE_ME markers
# (Windows image path, meter PID, bridge name). Everything is inert until
# `services.calman-sony.enable = true`.
#
# Wired as `nixosModules.calman-sony = import ./flakes/calman-sony/module.nix self`.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  cfg = config.services.calman-sony;

  domainXml = pkgs.writeText "${cfg.domain}.xml" ''
    <domain type='kvm'>
      <name>${cfg.domain}</name>
      <memory unit='GiB'>${toString cfg.memoryGiB}</memory>
      <vcpu>${toString cfg.vcpu}</vcpu>
      <os>
        <type arch='x86_64' machine='q35'>hvm</type>
        <boot dev='hd'/>
      </os>
      <features><acpi/><apic/></features>
      <cpu mode='host-passthrough' check='none' migratable='on'/>
      <clock offset='localtime'>
        <timer name='rtc' tickpolicy='catchup'/>
        <timer name='pit' tickpolicy='delay'/>
        <timer name='hpet' present='no'/>
      </clock>
      <devices>
        <emulator>${pkgs.qemu}/bin/qemu-system-x86_64</emulator>

        <!-- Windows Pro system disk. REPLACE_ME: point at your qcow2/raw image.
             (Windows 11 additionally needs UEFI/OVMF + a vTPM — add <loader>/
             <tpm> here; Windows 10 Pro boots fine on this SATA/BIOS setup.) -->
        <disk type='file' device='disk'>
          <driver name='qemu' type='qcow2'/>
          <source file='${cfg.imagePath}'/>
          <target dev='sda' bus='sata'/>
        </disk>

        <!-- C6 HDR5000 colorimeter: host-level USB passthrough (managed=yes so
             libvirt detaches/reattaches it around the guest). VID 0x0765 is
             certain; CONFIRM the PID with `lsusb -d 0765:` — the C6 is an OEM
             i1d3 so its PID is almost certainly NOT 0x5020 (retail i1Display Pro). -->
        <hostdev mode='subsystem' type='usb' managed='yes'>
          <source>
            <vendor id='${cfg.meterVendorId}'/>
            <product id='${cfg.meterProductId}'/>
          </source>
        </hostdev>

        <!-- Bridged NIC onto the calibration LAN (reaches the G1 + the Sony TV).
             e1000e works with a stock Windows install (no virtio-net drivers);
             switch model to "virtio" once the guest has the drivers. -->
        <interface type='bridge'>
          <source bridge='${cfg.bridge}'/>
          <model type='${cfg.nicModel}'/>
        </interface>

        <!-- SPICE console for INITIAL setup only; the runtime path is RDP
             RemoteApp via the `calman-sony` launcher (programs.calman-sony). -->
        <graphics type='spice' autoport='yes'/>
        <video><model type='qxl'/></video>
        <input type='tablet' bus='usb'/>
      </devices>
    </domain>
  '';
in {
  options.services.calman-sony = {
    enable = mkEnableOption "the Calman Home for Sony background Windows VM (scaffold)";

    domain = mkOption {
      type = types.str;
      default = "calman-sony";
      description = "libvirt domain name for the Windows VM.";
    };

    imagePath = mkOption {
      type = types.str;
      default = "/var/lib/libvirt/images/calman-sony.qcow2";
      description = "REPLACE_ME — path to the Windows Pro system disk image.";
    };

    meterVendorId = mkOption {
      type = types.str;
      default = "0x0765";
      description = "USB vendor id of the colorimeter (X-Rite / i1d3 family = 0x0765).";
    };

    meterProductId = mkOption {
      type = types.str;
      default = "0x0000";
      example = "0x5021";
      description = ''
        REPLACE_ME — USB product id of the C6 HDR5000. Confirm on the host with
        `lsusb -d 0765:`; the C6 is an OEM i1d3, so its PID is almost certainly
        NOT 0x5020 (that is the retail i1Display Pro). The module asserts this is
        set before it will enable.
      '';
    };

    bridge = mkOption {
      type = types.str;
      default = "br0";
      description = "REPLACE_ME — host bridge on the calibration LAN (must reach the G1 + Sony TV).";
    };

    nicModel = mkOption {
      type = types.str;
      default = "e1000e";
      description = ''NIC model. "e1000e" works out-of-box on Windows; "virtio" is faster but needs virtio-net drivers in the guest.'';
    };

    vcpu = mkOption {
      type = types.ints.positive;
      default = 4;
      description = "vCPUs for the Windows VM.";
    };

    memoryGiB = mkOption {
      type = types.ints.positive;
      default = 8;
      description = "RAM (GiB) for the Windows VM.";
    };

    autostart = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Mark the domain autostart so it boots with the host — keeps the
        first-launch spin-up latency off the `calman-sony` click. Off by default.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.meterProductId != "0x0000";
        message = "services.calman-sony: set meterProductId to the C6's real USB PID (run `lsusb -d 0765:`).";
      }
    ];

    # The hypervisor this module drives. (Add your calibration user to the
    # "libvirtd" group in your host config so they can `virsh start` the domain.)
    virtualisation.libvirtd.enable = true;

    # Grant the C6 to the libvirt/qemu user. The managed hostdev also re-binds it
    # around the guest, but tagging keeps raw host access sane. CONFIRM the PID
    # above first — the assertion blocks enabling until you do.
    services.udev.extraRules = ''
      # Portrait C6 HDR5000 (OEM i1Display3) — colorimeter for Calman.
      SUBSYSTEM=="usb", ATTR{idVendor}=="${removePrefix "0x" cfg.meterVendorId}", ATTR{idProduct}=="${removePrefix "0x" cfg.meterProductId}", TAG+="uaccess", GROUP="libvirtd", MODE="0660"
    '';

    # Define (and optionally autostart) the domain once libvirtd is up.
    systemd.services.calman-sony-define = {
      description = "Define the calman-sony libvirt domain";
      wantedBy = ["multi-user.target"];
      after = ["libvirtd.service"];
      requires = ["libvirtd.service"];
      path = [pkgs.libvirt];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        virsh --connect qemu:///system define ${domainXml}
        ${optionalString cfg.autostart ''virsh --connect qemu:///system autostart ${cfg.domain} || true''}
      '';
    };
  };
}
