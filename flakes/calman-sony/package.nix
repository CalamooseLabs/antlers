# calman-sony — a "winapps-lite" seamless launcher for Calman Home for Sony.
#
# Returns a FUNCTION of config (like mkVibeWrapper / mkMoosefetch): given the
# background VM's RDP coordinates it produces a `calman-sony` command + a
# .desktop entry that (1) starts the libvirt Windows VM if it isn't running,
# (2) waits for its RDP port, then (3) opens ONLY Calman as a seamless FreeRDP
# RemoteApp window — so it looks and behaves like a native Linux app.
#
# Why RemoteApp is SAFE for this exact workflow: in Sony BRAVIA AutoCal the G1
# pattern generator feeds patterns to the TV over HDMI and the C6 HDR5000 meter
# reads the panel over USB; Calman only sends IP control to the TV. The measured
# signal therefore NEVER crosses RDP or the host compositor — RemoteApp carries
# only Calman's UI chrome. (Contrast: calibrating the *local* monitor through a
# composited RDP window is colour-unreliable — don't use this for that.)
#
# SCAFFOLD — see ./README.md for the full rationale and REPLACE_ME checklist.
{
  lib,
  writeShellApplication,
  makeDesktopItem,
  runCommandLocal,
  libvirt,
  freerdp,
  coreutils,
  gnugrep,
}: {
  # libvirt domain name of the background Windows VM (see ./module.nix).
  domain ? "calman-sony",
  # The guest's address on your calibration LAN (bridged NIC). REPLACE_ME.
  rdpHost ? "REPLACE_ME_GUEST_IP",
  # A Windows *Pro* user with RDP / RemoteApp rights.
  rdpUser ? "calibrator",
  # Windows-side path to the Calman executable. CONFIRM the exact folder + exe.
  appPath ? ''C:\Program Files\Portrait Displays\Calman\Calman.exe'',
  # libvirt connection URI used to start the VM.
  connectUri ? "qemu:///system",
  # Seconds to wait for the guest RDP port (3389) before giving up.
  rdpTimeout ? 120,
  ...
}: let
  launcher = writeShellApplication {
    name = "calman-sony";
    runtimeInputs = [libvirt freerdp coreutils gnugrep];
    text = ''
      # --- configured at build time -----------------------------------------
      domain=${lib.escapeShellArg domain}
      uri=${lib.escapeShellArg connectUri}
      host=${lib.escapeShellArg rdpHost}
      user=${lib.escapeShellArg rdpUser}
      app=${lib.escapeShellArg appPath}
      timeout_s=${toString rdpTimeout}
      # ----------------------------------------------------------------------

      if [ "$host" = "REPLACE_ME_GUEST_IP" ]; then
        echo "calman-sony: set rdpHost to the Windows VM's IP on your calibration LAN." >&2
        exit 1
      fi

      # 1. Ensure the background Windows VM is running (idempotent).
      if ! virsh --connect "$uri" domstate "$domain" 2>/dev/null | grep -q running; then
        echo "calman-sony: starting VM '$domain'…"
        virsh --connect "$uri" start "$domain"
      fi

      # 2. Wait for the guest to accept RDP (port 3389).
      echo "calman-sony: waiting for RDP on $host:3389…"
      waited=0
      until timeout 1 bash -c "exec 3<>/dev/tcp/$host/3389" 2>/dev/null; do
        sleep 2
        waited=$((waited + 2))
        if [ "$waited" -ge "$timeout_s" ]; then
          echo "calman-sony: timed out waiting for RDP on $host:3389." >&2
          exit 1
        fi
      done

      # 3. Open ONLY Calman as a seamless RemoteApp window.
      #    FreeRDP 3 syntax; extra args pass straight through (e.g. /p:… or a
      #    /cert:… override). NOTE: verify the binary name on your host — recent
      #    FreeRDP may install `xfreerdp3` instead of `xfreerdp`.
      exec xfreerdp \
        /v:"$host" \
        /u:"$user" \
        /app:program:"$app" \
        /dynamic-resolution \
        +clipboard \
        /cert:ignore \
        "$@"
    '';
  };

  desktopItem = makeDesktopItem {
    name = "calman-sony";
    desktopName = "Calman Home for Sony";
    comment = "Sony BRAVIA AutoCal — Calman in a background Windows VM, shown as a seamless app";
    exec = "calman-sony";
    icon = "video-display";
    categories = ["Utility" "Graphics"];
    keywords = ["calibration" "calman" "sony" "bravia" "colorimeter"];
  };
in
  runCommandLocal "calman-sony" {
    meta = {
      description = "Seamless FreeRDP RemoteApp launcher for Calman Home for Sony (scaffold)";
      platforms = lib.platforms.linux;
      mainProgram = "calman-sony";
    };
  } ''
    mkdir -p "$out/bin" "$out/share/applications"
    ln -s ${launcher}/bin/calman-sony "$out/bin/calman-sony"
    ln -s ${desktopItem}/share/applications/*.desktop "$out/share/applications/"
  ''
