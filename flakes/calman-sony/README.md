# calman-sony

**SCAFFOLD.** A seamless "near-native app" wrapper for **Calman Home for Sony**
(Portrait Displays; Windows-only) running in a **background libvirt/QEMU Windows
VM**, surfaced as a single FreeRDP **RemoteApp** window — click an icon, Calman
opens like a native Linux app.

This flake dir ships three pieces (antlers convention: `package.nix` + a NixOS
`module.nix` + a home-manager `home-module.nix`, mirroring `unifi-protect-monitor`):

| File | Output | What it does |
|------|--------|--------------|
| `package.nix` | `packages.calman-sony`, `lib.mkCalmanSony`, `apps.calman-sony`, overlay | The `calman-sony` launcher: starts the VM, waits for RDP, opens Calman as a RemoteApp window. A function of config (host/user/app path). |
| `module.nix` | `nixosModules.calman-sony` | `services.calman-sony` — declares the Windows VM: USB **hostdev** for the meter, **bridged** NIC, udev rule, domain define/autostart. |
| `home-module.nix` | `homeManagerModules.calman-sony` | `programs.calman-sony` — installs the configured launcher + `.desktop` entry into a user's home. |

Everything is **inert until enabled** (`enable` defaults to `false`), so it can be
published without a Windows image present.

## Why this works for *this* rig (and where it wouldn't)

The intended hardware chain is **G1 pattern generator + C6 HDR5000 colorimeter +
Calman Home for Sony**, calibrating Sony BRAVIA TVs via **AutoCal**. That is the
best case for a RemoteApp VM, because the Windows box is **pure orchestration** —
it never sources a video signal:

1. **G1 → HDMI → Sony TV** — the G1 generates bit-accurate patches in its own hardware.
2. **C6 HDR5000 → USB → Windows** — the meter reads the panel and reports to Calman.
3. **Calman → LAN/IP → Sony TV** — AutoCal writes calibration into the TV (the
   "Calman for BRAVIA" app; the TV shows an `IP:port`, commonly `:9022`).

Because the calibration signal never crosses RDP or the host compositor,
**RemoteApp only carries Calman's UI** and the usual "don't calibrate through a
remote desktop" colour-accuracy objection **does not apply**. No GPU/VFIO
passthrough is needed.

> ⚠️ This is **not** valid for calibrating the *local PC monitor* (RGB mode): a
> patch drawn through a composited RDP window is colour-unreliable and would also
> want GPU passthrough. Use native DisplayCAL/ArgyllCMS for that, or run Calman
> full-screen on the VM's own display.

## Key design decisions

- **Meter over host-level USB passthrough, not RDP redirection.** The C6 is an
  OEM i1Display3 → a plain **HID** device (VID `0x0765`). HID is exactly the class
  Windows demotes out of RDP USB redirection, so a `<hostdev>` bind (owned by
  Calman for the whole run) is the robust path.
- **Bridged NIC, never NAT.** Calman must reach the G1 *and* the TV by IP. A
  NAT-isolated guest reaches neither — the single most common failure.
- **No GPU passthrough.** See above — the PC never emits the pattern.

## REPLACE_ME / CONFIRM checklist

Before enabling downstream:

1. **`services.calman-sony.imagePath`** — path to your Windows **Pro** qcow2/raw
   image (Pro is required for RDP/RemoteApp; Home won't do it). Windows 11 also
   needs UEFI/OVMF + vTPM — add `<loader>`/`<tpm>` to the domain XML.
2. **`services.calman-sony.meterProductId`** — run `lsusb -d 0765:` and use the
   real PID. It is almost certainly **not** `0x5020` (that's the retail i1Display
   Pro). The module asserts this is set.
3. **`services.calman-sony.bridge`** — your host bridge on the calibration LAN.
4. **`programs.calman-sony.rdpHost` / `rdpUser`** — the guest's LAN IP and a
   Windows Pro user with RemoteApp rights.
5. **`programs.calman-sony.appPath`** — confirm the exact install path of
   `Calman.exe` inside the guest.
6. **FreeRDP binary name** — the launcher calls `xfreerdp`; recent FreeRDP may
   install `xfreerdp3`. Verify on the host.

## Residual risks

- **Windows Pro** mandatory for RemoteApp.
- **Node-locked Calman activation** binds to the VM's hardware fingerprint —
  **pin the domain's machine type / CPU / MAC / disk topology and don't churn it**.
- **First-launch latency** — the cold VM boot happens on the first click; set
  `autostart = true` (or keep the domain suspended) to hide it.
- **Unlock codes ≠ passthrough** — the C6 needs its Portrait unlock code + Calman
  ≥ 5.15.6, the G1 needs ≥ 5.15.0.4. If the *device* appears but Calman won't
  drive it, that's licensing, not USB.

## Wiring downstream (publish-before-wire)

Per the antlers flow, push this to `github:CalamooseLabs/antlers` and bump the
lock in cala-m-os **before** referencing it. Then in `/etc/nixos`:

```nix
# NixOS layer (host that owns the calibration box)
imports = [ inputs.antlers.nixosModules.calman-sony ];
services.calman-sony = {
  enable = true;
  imagePath = "/var/lib/libvirt/images/calman-sony.qcow2";
  meterProductId = "0xXXXX";   # from `lsusb -d 0765:`
  bridge = "br0";
  autostart = true;
};

# home-manager layer (the calibrating user)
imports = [ inputs.antlers.homeManagerModules.calman-sony ];
programs.calman-sony = {
  enable = true;
  rdpHost = "10.10.10.42";
  rdpUser = "calibrator";
};
```

Also add the calibration user to the `libvirtd` group on the host.
