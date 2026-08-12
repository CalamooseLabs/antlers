# calman-sony

**SCAFFOLD.** A seamless "near-native app" wrapper for **Calman Home for Sony**
(Portrait Displays; Windows-only) running in a **background libvirt/QEMU Windows
VM**, surfaced as a single FreeRDP **RemoteApp** window — click an icon, Calman
opens like a native Linux app.

This flake dir ships three pieces (antlers convention: `package.nix` + a NixOS
`module.nix` + a home-manager `home-module.nix`, mirroring `unifi-protect-monitor`):

| File | Output | What it does |
|------|--------|--------------|
| `package.nix` | `packages.calman-sony`, `lib.mkCalmanSony`, `apps.calman-sony`, overlay | The `calman-sony` launcher (auto-discovers the guest IP, opens Calman as a RemoteApp window) **and** `calman-sony-setup` (first-run ISO wizard). A function of config. |
| `module.nix` | `nixosModules.calman-sony` | `services.calman-sony` — declares the Windows VM: USB **hostdev** for the meter, **self-owned NAT network** (or an opt-in bridge), **auto-created disk**, an install CD drive, udev rule, domain define/autostart. |
| `home-module.nix` | `homeManagerModules.calman-sony` | `programs.calman-sony` — installs the configured launcher + `.desktop` entry into a user's home. |

Everything is **inert until enabled** (`enable` defaults to `false`), so it can be
published without a Windows image present.

## How little you have to configure

The module is self-contained by default — a first bring-up needs almost nothing:

- **Networking → nothing.** `networkMode = "nat"` (default) makes the module define
  and start its **own** libvirt NAT network. Host→guest RDP works, and the guest
  reaches the G1 / Sony TV outbound by IP. No host bridge, no NIC name.
  - Need the guest on the TV's *actual subnet* for AutoCal? Set
    `networkMode = "bridge"` **and** `uplink = "<physical NIC>"` and the module
    creates a Linux bridge on it. ⚠️ Advanced/host-specific — it takes over that
    NIC and can conflict with your host's network stack; don't point it at the
    host's only uplink.
- **Guest IP → nothing.** The launcher auto-discovers it via `virsh domifaddr`
  (install the QEMU guest agent in the guest for the most reliable result).
- **Disk → nothing.** Auto-created (`diskSizeGiB`, default 64) if missing.
- **Windows user → default.** Name the guest user `calibrator` to match, or set
  `programs.calman-sony.rdpUser`.

What you *do* still provide: a Windows **Pro** ISO (once), and confirming
`appPath` after Calman is installed.

## First boot / installing Windows

The VM keeps an (initially empty) CD drive and boots HD-first — a fresh empty disk
falls through to the CD. Two ways to install:

1. **Configured ISO:** set `services.calman-sony.installerIso = "…/Win11_Pro.iso"`;
   it is inserted and booted on first start.
2. **Interactive wizard:** run **`calman-sony-setup`** — it creates the disk if
   needed, **asks for the ISO path**, inserts it, starts the VM, and opens the
   SPICE console so you run Windows setup. Inside Windows: enable Remote Desktop,
   create the `calibrator` user, install Calman. Then `calman-sony` takes over.

(Optional: point `virtioWinIso` at `${pkgs.virtio-win}/share/virtio-win/virtio-win.iso`
for a second driver CD if you switch `nicModel`/disk to virtio.)

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
- **Meter reachability by IP, subnet only if AutoCal needs it.** NAT (default)
  lets Calman reach the G1/TV outbound and keeps host→guest RDP working with zero
  setup; switch to `bridge` only if AutoCal requires the guest on the TV's subnet.
- **No GPU passthrough.** See above — the PC never emits the pattern.

## Still-yours checklist

Almost everything now has a working default (see "How little you have to
configure"). What genuinely remains:

1. **A Windows *Pro* ISO/image** — Pro is required for RDP/RemoteApp; Home won't
   do it. Supply via `installerIso` or the `calman-sony-setup` wizard. (Windows 11
   also needs UEFI/OVMF + vTPM — add `<loader>`/`<tpm>` to the domain XML.)
2. **`programs.calman-sony.appPath`** — confirm the exact install path of
   `Calman.exe` inside the guest, once installed.
3. **FreeRDP binary name** — the launcher calls `xfreerdp`; recent FreeRDP may
   install `xfreerdp3`. Verify on the host.

Optional: `networkMode = "bridge"` + `uplink` if AutoCal needs same-subnet;
`rdpUser` if you don't name the Windows user `calibrator`. `meterProductId` is
already `0x5020` (confirmed via `lsusb`).

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
# NixOS layer (host that owns the calibration box) — NAT default: no networking to set up
imports = [ inputs.antlers.nixosModules.calman-sony ];
services.calman-sony = {
  enable = true;
  # installerIso = "/var/lib/libvirt/images/Win11_Pro.iso";  # or use `calman-sony-setup`
  autostart = true;
  # networkMode = "bridge"; uplink = "enp3s0";   # only if AutoCal needs same-subnet
};

# home-manager layer (the calibrating user)
imports = [ inputs.antlers.homeManagerModules.calman-sony ];
programs.calman-sony.enable = true;   # rdpHost auto-discovered; rdpUser defaults to "calibrator"
```

Also add the calibration user to the `libvirtd` group on the host. Then:
`calman-sony-setup` (install Windows + Calman once) → `calman-sony` (seamless app).
