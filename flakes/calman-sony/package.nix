# calman-sony — a "winapps-lite" seamless launcher for Calman Home for Sony,
# plus a first-run `calman-sony-setup` wizard.
#
# Returns a FUNCTION of config (like mkVibeWrapper / mkMoosefetch). Ships two
# commands + a .desktop entry:
#
#   calman-sony        Start the background libvirt Windows VM (if needed),
#                      AUTO-DISCOVER its IP (virsh domifaddr — no rdpHost to
#                      hardcode), wait for RDP, then open ONLY Calman as a
#                      seamless FreeRDP RemoteApp window — like a native app.
#   calman-sony-setup  First-run: create the disk if missing, ASK FOR a Windows
#                      install ISO (or use one you configured), insert it, start
#                      the VM and open the SPICE console to run Windows setup +
#                      install Calman.
#
# Why RemoteApp is SAFE here: in Sony BRAVIA AutoCal the G1 feeds patterns to the
# TV over HDMI and the C6 reads the panel over USB; Calman only sends IP control.
# The measured signal never crosses RDP / the compositor — RemoteApp carries only
# Calman's UI. (Don't use this to calibrate the *local* monitor.)
#
# SCAFFOLD — see ./README.md for the full rationale and checklist.
{
  lib,
  writeShellApplication,
  makeDesktopItem,
  runCommandLocal,
  libvirt,
  freerdp,
  virt-viewer,
  qemu,
  coreutils,
  gnugrep,
  gawk,
}: {
  # libvirt domain name of the background Windows VM (see ./module.nix).
  domain ? "calman-sony",
  # The guest's address. Leave "" (or the placeholder) to AUTO-DISCOVER via libvirt.
  rdpHost ? "",
  # A Windows *Pro* user with RDP / RemoteApp rights.
  rdpUser ? "calibrator",
  # Windows-side path to the Calman executable. CONFIRM the exact folder + exe.
  appPath ? ''C:\Program Files\Portrait Displays\Calman\Calman.exe'',
  # libvirt connection URI used to start the VM.
  connectUri ? "qemu:///system",
  # Seconds to wait for the guest RDP port (3389) before giving up.
  rdpTimeout ? 180,
  # CD-drive target the setup wizard inserts the install ISO into (matches module).
  cdromTarget ? "sdb",
  ...
}: let
  launcher = writeShellApplication {
    name = "calman-sony";
    runtimeInputs = [libvirt freerdp coreutils gnugrep gawk];
    text = ''
      # --- configured at build time -----------------------------------------
      domain=${lib.escapeShellArg domain}
      uri=${lib.escapeShellArg connectUri}
      host=${lib.escapeShellArg rdpHost}
      user=${lib.escapeShellArg rdpUser}
      app=${lib.escapeShellArg appPath}
      timeout_s=${toString rdpTimeout}
      # ----------------------------------------------------------------------

      # 1. Ensure the background Windows VM is running (idempotent).
      if ! virsh --connect "$uri" domstate "$domain" 2>/dev/null | grep -q running; then
        echo "calman-sony: starting VM '$domain'…"
        virsh --connect "$uri" start "$domain"
      fi

      # 2. Resolve the guest IP — auto-discover from libvirt unless one was set.
      if [ -z "$host" ] || [ "$host" = "REPLACE_ME_GUEST_IP" ]; then
        echo "calman-sony: discovering VM IP…"
        waited=0
        found=""
        until [ -n "$found" ]; do
          for src in lease agent arp; do
            found=$(virsh --connect "$uri" domifaddr "$domain" --source "$src" 2>/dev/null \
              | awk '/ipv4/ {print $4}' | cut -d/ -f1 | head -n1)
            [ -n "$found" ] && break
          done
          [ -n "$found" ] && break
          sleep 2
          waited=$((waited + 2))
          if [ "$waited" -ge "$timeout_s" ]; then
            echo "calman-sony: could not auto-discover the VM's IP (install the QEMU guest agent, or set programs.calman-sony.rdpHost)." >&2
            exit 1
          fi
        done
        host="$found"
        echo "calman-sony: VM is at $host"
      fi

      # 3. Wait for the guest to accept RDP (port 3389).
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

      # 4. Open ONLY Calman as a seamless RemoteApp window.
      #    FreeRDP 3 syntax; extra args pass straight through (e.g. /p:… ). NOTE:
      #    verify the binary name — recent FreeRDP may install `xfreerdp3`.
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

  setup = writeShellApplication {
    name = "calman-sony-setup";
    runtimeInputs = [libvirt qemu virt-viewer coreutils];
    text = ''
      # First-run wizard: bring up a Windows VM to install Calman into.
      domain=${lib.escapeShellArg domain}
      uri=${lib.escapeShellArg connectUri}
      cdrom=${lib.escapeShellArg cdromTarget}

      if ! virsh --connect "$uri" dominfo "$domain" >/dev/null 2>&1; then
        echo "calman-sony-setup: domain '$domain' is not defined." >&2
        echo "  Enable services.calman-sony on this host first (it defines the VM + disk)." >&2
        exit 1
      fi

      # Ask for the Windows install ISO unless one is already in the drive.
      iso="''${CALMAN_ISO:-}"
      if [ -z "$iso" ]; then
        # Is media already inserted (installerIso configured in the module)?
        if virsh --connect "$uri" domblklist "$domain" --details 2>/dev/null \
             | awk -v t="$cdrom" '$3==t {print $4}' | grep -q '/'; then
          echo "calman-sony-setup: an install ISO is already inserted."
        else
          read -rp "Path to a Windows 10/11 Pro install ISO: " iso
        fi
      fi

      if [ -n "$iso" ]; then
        if [ ! -r "$iso" ]; then
          echo "calman-sony-setup: cannot read ISO '$iso'." >&2
          exit 1
        fi
        echo "calman-sony-setup: inserting $iso into $cdrom…"
        virsh --connect "$uri" change-media "$domain" "$cdrom" --source "$iso" --insert --config 2>/dev/null \
          || virsh --connect "$uri" change-media "$domain" "$cdrom" --source "$iso" --update --config
      fi

      echo "calman-sony-setup: starting '$domain' and opening the console…"
      virsh --connect "$uri" start "$domain" 2>/dev/null || true
      echo "  Run Windows setup, then inside Windows: enable Remote Desktop, create a"
      echo "  user named 'calibrator' (or set programs.calman-sony.rdpUser), and install"
      echo "  Calman. After that, launch it seamlessly with:  calman-sony"
      exec virt-viewer --connect "$uri" "$domain"
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
      description = "Seamless FreeRDP RemoteApp launcher + first-run wizard for Calman Home for Sony (scaffold)";
      platforms = lib.platforms.linux;
      mainProgram = "calman-sony";
    };
  } ''
    mkdir -p "$out/bin" "$out/share/applications"
    ln -s ${launcher}/bin/calman-sony "$out/bin/calman-sony"
    ln -s ${setup}/bin/calman-sony-setup "$out/bin/calman-sony-setup"
    ln -s ${desktopItem}/share/applications/*.desktop "$out/share/applications/"
  ''
