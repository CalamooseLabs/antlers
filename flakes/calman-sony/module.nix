# NixOS module: services.calman-sony — declares the background Windows *Pro* VM
# that runs Calman Home for Sony, wired for the Sony BRAVIA AutoCal workflow.
#
# Self-contained: the module OWNS its networking and provisions its own disk, so
# a first bring-up needs (almost) nothing from you.
#
#   • networkMode = "nat" (default): the module defines + starts its OWN libvirt
#     NAT network — no host bridge, no NIC name, zero host networking config.
#     Host→guest RDP works (the seamless app path) and the guest reaches the G1 /
#     Sony TV outbound by IP. Guest IP is auto-discovered from the DHCP lease.
#   • networkMode = "bridge": for when AutoCal needs the guest on the SAME subnet
#     as the TV. The module declares a Linux bridge on `uplink` (a physical NIC
#     you name) — advanced, host-specific, and may conflict with your host's
#     network stack (NetworkManager/networkd). Opt-in only.
#
#   • C6 HDR5000 colorimeter → USB HOSTDEV passthrough (confirmed 0765:5020).
#   • NO GPU passthrough — the G1 feeds the TV over HDMI; the PC never sources the
#     signal, so the RDP colour-accuracy problem does not exist for this workflow.
#
#   • First boot: the disk is auto-created and an (initially empty) CD drive is
#     kept in the VM; set `installerIso` (or use `calman-sony-setup`) to boot a
#     Windows installer. SeaBIOS falls through the empty disk to the CD.
#
# SCAFFOLD — inert until `services.calman-sony.enable = true`. See ./README.md.
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

  isNat = cfg.networkMode == "nat";

  # A libvirt NAT network the module fully owns (only used in nat mode).
  natXml = pkgs.writeText "${cfg.netName}.xml" ''
    <network>
      <name>${cfg.netName}</name>
      <forward mode='nat'/>
      <bridge name='${cfg.natBridge}' stp='on' delay='0'/>
      <ip address='${cfg.natGateway}' netmask='255.255.255.0'>
        <dhcp>
          <range start='${cfg.natDhcpStart}' end='${cfg.natDhcpEnd}'/>
        </dhcp>
      </ip>
    </network>
  '';

  # The guest NIC block depends on the chosen network mode.
  ifaceXml =
    if isNat
    then ''
      <interface type='network'>
              <source network='${cfg.netName}'/>
              <model type='${cfg.nicModel}'/>
            </interface>''
    else ''
      <interface type='bridge'>
              <source bridge='${cfg.bridge}'/>
              <model type='${cfg.nicModel}'/>
            </interface>'';

  # Optional virtio-win drivers CD (a second cdrom) when a path is given.
  virtioCdXml = optionalString (cfg.virtioWinIso != null) ''
    <disk type='file' device='cdrom'>
          <driver name='qemu' type='raw'/>
          <source file='${cfg.virtioWinIso}'/>
          <target dev='sdc' bus='sata'/>
          <readonly/>
        </disk>'';

  # The install CD is ALWAYS present but starts empty when installerIso is null;
  # `calman-sony-setup` (or setting installerIso) inserts media later.
  installSourceXml =
    optionalString (cfg.installerIso != null) ''
      <source file='${cfg.installerIso}'/>'';

  domainXml = pkgs.writeText "${cfg.domain}.xml" ''
    <domain type='kvm'>
      <name>${cfg.domain}</name>
      <memory unit='GiB'>${toString cfg.memoryGiB}</memory>
      <vcpu>${toString cfg.vcpu}</vcpu>
      <os>
        <type arch='x86_64' machine='q35'>hvm</type>
        <!-- HD first; a fresh (empty) disk has no bootloader so SeaBIOS falls
             through to the install CD. Windows 11 also needs UEFI/OVMF + vTPM. -->
        <boot dev='hd'/>
        <boot dev='cdrom'/>
        <bootmenu enable='yes'/>
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

        <!-- Windows Pro system disk (auto-created by the provision unit). -->
        <disk type='file' device='disk'>
          <driver name='qemu' type='qcow2'/>
          <source file='${cfg.imagePath}'/>
          <target dev='sda' bus='sata'/>
        </disk>

        <!-- Install CD (kept present; empty until media is inserted). -->
        <disk type='file' device='cdrom'>
          <driver name='qemu' type='raw'/>
          ${installSourceXml}
          <target dev='sdb' bus='sata'/>
          <readonly/>
        </disk>
        ${virtioCdXml}

        <!-- Colorimeter: host-level USB passthrough (managed=yes so libvirt
             detaches/reattaches it around the guest). Confirmed on this host as
             0765:5020 (presents as "i1 Display Pro" — the C6 HDR5000 shares the
             i1d3 silicon + USB identity; Calman unlocks the C6 in software, not
             via a distinct PID). Re-check with `lsusb -d 0765:` if you swap meters. -->
        <hostdev mode='subsystem' type='usb' managed='yes'>
          <source>
            <vendor id='${cfg.meterVendorId}'/>
            <product id='${cfg.meterProductId}'/>
          </source>
        </hostdev>

        <!-- Guest NIC (nat network the module owns, or a bridge you name). -->
        ${ifaceXml}

        <!-- SPICE console for the Windows install + initial setup; the runtime
             path is RDP RemoteApp via the `calman-sony` launcher. -->
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
      description = "Path to the Windows Pro system disk. Auto-created (empty) if it does not exist.";
    };

    diskSizeGiB = mkOption {
      type = types.ints.positive;
      default = 64;
      description = "Size of the auto-created system disk (GiB). Ignored if the image already exists.";
    };

    installerIso = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/var/lib/libvirt/images/Win11_Pro.iso";
      description = ''
        Path to a Windows Pro install ISO. When set, it is inserted in the VM's
        CD drive and the VM boots it on first start. Leave null and use
        `calman-sony-setup` to be prompted for the ISO interactively instead.
      '';
    };

    virtioWinIso = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = ''"''${pkgs.virtio-win}/share/virtio-win/virtio-win.iso"'';
      description = "Optional path to the virtio-win drivers ISO (a second CD) for virtio disk/net/guest-agent in the guest.";
    };

    meterVendorId = mkOption {
      type = types.str;
      default = "0x0765";
      description = "USB vendor id of the colorimeter (X-Rite / i1d3 family = 0x0765).";
    };

    meterProductId = mkOption {
      type = types.str;
      default = "0x5020";
      description = ''
        USB product id of the colorimeter. Confirmed on this host as 0765:5020
        (the meter presents as "i1 Display Pro"; the C6 HDR5000 shares the i1d3
        silicon + USB identity — Calman unlocks the C6 in software, not via a
        distinct PID). Re-check with `lsusb -d 0765:` if you swap meters.
      '';
    };

    networkMode = mkOption {
      type = types.enum ["nat" "bridge"];
      default = "nat";
      description = ''
        "nat" (default): the module owns a self-contained libvirt NAT network —
        no host networking config. "bridge": put the guest on your calibration
        LAN via a Linux bridge on `uplink` (advanced, host-specific).
      '';
    };

    uplink = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "enp3s0";
      description = ''
        Only for networkMode = "bridge": the physical NIC to enslave into the
        bridge. Required in bridge mode. WARNING: this takes over the interface
        and can disrupt host networking — make sure it is not the host's only uplink.
      '';
    };

    bridge = mkOption {
      type = types.str;
      default = "br0";
      description = "Bridge name used in networkMode = \"bridge\" (created by the module on `uplink`).";
    };

    # NAT-network knobs (networkMode = "nat"); defaults picked to avoid the usual
    # 192.168.122.0/24 libvirt default so this can coexist with it.
    netName = mkOption {
      type = types.str;
      default = "calman-sony";
      description = "Name of the module-owned libvirt NAT network.";
    };
    natBridge = mkOption {
      type = types.str;
      default = "virbr-cs";
      description = "Bridge device libvirt creates for the NAT network (≤15 chars).";
    };
    natGateway = mkOption {
      type = types.str;
      default = "192.168.171.1";
      description = "Host-side gateway IP of the NAT network.";
    };
    natDhcpStart = mkOption {
      type = types.str;
      default = "192.168.171.100";
      description = "NAT DHCP range start.";
    };
    natDhcpEnd = mkOption {
      type = types.str;
      default = "192.168.171.199";
      description = "NAT DHCP range end.";
    };

    nicModel = mkOption {
      type = types.str;
      default = "e1000e";
      description = ''NIC model. "e1000e" works out-of-box on Windows; "virtio" is faster but needs virtio-net drivers (see virtioWinIso).'';
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
      description = "Mark the domain autostart so it boots with the host (keeps first-launch latency off the click).";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = isNat || cfg.uplink != null;
        message = "services.calman-sony: networkMode = \"bridge\" requires `uplink` (the physical NIC to enslave).";
      }
    ];

    # The hypervisor this module drives. (Add your calibration user to the
    # "libvirtd" group in your host config so they can `virsh start` the domain.)
    virtualisation.libvirtd.enable = true;

    # Bridge mode only: declare the Linux bridge on the named uplink. (NAT mode
    # needs nothing here — the module owns its libvirt network instead.) Guarded
    # on `uplink != null` so a missing uplink surfaces the friendly assertion
    # below rather than a `[ null ]` type error.
    networking.bridges = mkIf (!isNat && cfg.uplink != null) {
      ${cfg.bridge}.interfaces = [cfg.uplink];
    };

    # Grant the meter to the libvirt/qemu user. The managed hostdev also re-binds
    # it around the guest; the tag keeps raw host access sane.
    services.udev.extraRules = ''
      # Colorimeter (i1d3 / C6 HDR5000, 0765:5020) — for Calman.
      SUBSYSTEM=="usb", ATTR{idVendor}=="${removePrefix "0x" cfg.meterVendorId}", ATTR{idProduct}=="${removePrefix "0x" cfg.meterProductId}", TAG+="uaccess", GROUP="libvirtd", MODE="0660"
    '';

    # Provision: create the disk if missing, and (nat mode) define+start the
    # module's own NAT network. Idempotent.
    systemd.services.calman-sony-provision = {
      description = "Provision calman-sony disk + network";
      wantedBy = ["multi-user.target"];
      after = ["libvirtd.service"];
      requires = ["libvirtd.service"];
      path = [pkgs.libvirt pkgs.qemu];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        if [ ! -e ${escapeShellArg cfg.imagePath} ]; then
          echo "calman-sony: creating ${toString cfg.diskSizeGiB}G system disk at ${cfg.imagePath}"
          mkdir -p "$(dirname ${escapeShellArg cfg.imagePath})"
          qemu-img create -f qcow2 ${escapeShellArg cfg.imagePath} ${toString cfg.diskSizeGiB}G
        fi
        ${optionalString isNat ''
          if ! virsh --connect qemu:///system net-info ${escapeShellArg cfg.netName} >/dev/null 2>&1; then
            virsh --connect qemu:///system net-define ${natXml}
          fi
          virsh --connect qemu:///system net-start ${escapeShellArg cfg.netName} 2>/dev/null || true
          virsh --connect qemu:///system net-autostart ${escapeShellArg cfg.netName} 2>/dev/null || true
        ''}
      '';
    };

    # Define (and optionally autostart) the domain once provisioning is done.
    systemd.services.calman-sony-define = {
      description = "Define the calman-sony libvirt domain";
      wantedBy = ["multi-user.target"];
      after = ["calman-sony-provision.service"];
      requires = ["calman-sony-provision.service"];
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
