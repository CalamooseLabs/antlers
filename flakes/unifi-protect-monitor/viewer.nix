# unifi-protect-viewer — the Wayland "program" that shows the camera wall full-screen.
#
# The plan's preferred long-term track is Deno Desktop (app/viewer/main.ts, `deno
# desktop`), but that needs Deno 2.9 which isn't in nixpkgs yet (unstable pins 2.8.x).
# So the SHIPPED viewer is a Chromium kiosk: great codec/MSE/WebRTC + audio support,
# rock-solid on Wayland today. It renders the backend's web UI — passing UPM_CAMERAS
# yields the minimal, chrome-free, audio-on multiview (baby-monitor mode); none yields
# the full dashboard.
#
# It runs Chromium DIRECTLY when already inside a Wayland session (WAYLAND_DISPLAY set,
# e.g. launched as services.cage's program by the module's kiosk option) and otherwise
# spawns `cage` itself — so it never double-nests compositors.
{
  lib,
  writeShellApplication,
  cage,
  chromium,
}:
writeShellApplication {
  name = "unifi-protect-viewer";
  runtimeInputs = [cage chromium];
  text = ''
    server="''${UPM_SERVER:-http://127.0.0.1:8460}"
    cameras="''${UPM_CAMERAS:-}"

    while [ "$#" -gt 0 ]; do
      case "$1" in
        --server) server="$2"; shift 2 ;;
        --cameras) cameras="$2"; shift 2 ;;
        -h|--help)
          echo "usage: unifi-protect-viewer [--server URL] [--cameras a,b,c]"
          echo "  env: UPM_SERVER, UPM_CAMERAS"
          exit 0 ;;
        *) break ;;
      esac
    done

    server="''${server%/}"
    url="$server/"
    if [ -n "$cameras" ]; then
      # Percent-encode the query-special ASCII chars so names with & # + ? or spaces
      # survive (commas stay literal as the list delimiter; the browser's URLSearchParams
      # decodes the rest). Patterns are quoted so # / % aren't treated as anchors, and %
      # is encoded first so we don't double-encode the escapes we add.
      enc="$cameras"
      enc="''${enc//'%'/%25}"
      enc="''${enc//'&'/%26}"
      enc="''${enc//'#'/%23}"
      enc="''${enc//'+'/%2B}"
      enc="''${enc//'?'/%3F}"
      enc="''${enc//' '/%20}"
      url="$server/?cameras=$enc"
    fi

    profile="''${XDG_RUNTIME_DIR:-/tmp}/upm-viewer-profile"
    mkdir -p "$profile"

    chromium_args=(
      --kiosk
      --app="$url"
      --ozone-platform=wayland
      --user-data-dir="$profile"
      --autoplay-policy=no-user-gesture-required
      --noerrdialogs
      --disable-infobars
      --disable-session-crashed-bubble
      "--disable-features=Translate,MediaRouter"
      --check-for-update-interval=31536000
      --start-fullscreen
    )

    if [ -n "''${WAYLAND_DISPLAY:-}" ]; then
      # Already inside a Wayland session (e.g. under services.cage) — run the browser directly.
      exec chromium "''${chromium_args[@]}"
    else
      # Standalone from a TTY — bring up a single-app kiosk compositor.
      exec cage -- chromium "''${chromium_args[@]}"
    fi
  '';

  meta = {
    description = "Full-screen Wayland kiosk viewer for unifi-protect-monitor (Chromium in cage)";
    mainProgram = "unifi-protect-viewer";
    platforms = ["x86_64-linux" "aarch64-linux"];
  };
}
