# Smoke test

The offline suite (`nix flake check`, the `deno test`) validates parsing, the API client
against a mock, the ffmpeg/codec logic, the router, the SPA invariants, and the WS client.
**Live camera playback can only be verified against a real console** — do that on the LAN
where the console is reachable.

## 1. Backend against a real console (no Nix install needed)

From the flake dir, with the console reachable:

```sh
cd flakes/unifi-protect-monitor/app
export UPM_CONSOLE_URL="https://192.168.1.1/proxy/protect/integration"
export UPM_API_KEY="<your-x-api-key>"          # or UPM_API_KEY_FILE=/path
export UPM_FFMPEG="$(command -v ffmpeg)" UPM_FFPROBE="$(command -v ffprobe)"
export UPM_PORT=8460
nix shell nixpkgs#deno nixpkgs#ffmpeg-headless -c \
  deno run --allow-read --allow-write --allow-env --allow-net --allow-run \
  --unsafely-ignore-certificate-errors server/main.ts
```

Then check, in order:

1. **Health / auth** — the journal (stdout) logs `connected to Protect` with a version.
   If it logs `Protect health check failed`, fix the URL / key / reachability first.
2. **Cameras** — `curl -s localhost:8460/api/cameras | jq` lists your cameras.
3. **Snapshot** — `curl -s localhost:8460/snapshot/<cameraId> -o /tmp/s.jpg` yields a JPEG.
4. **UI** — open `http://localhost:8460/` in Chromium: the dashboard grid shows live tiles
   (you may need one click to enable audio in a normal browser). Drag/resize/scroll a tile;
   click one to enlarge and see the event timeline; trigger motion to see the red dot.
5. **Focus mode** — `http://localhost:8460/?cameras=<Name>` shows only that camera,
   full-screen, audio on, no chrome.

If a tile stays black but the snapshot works, the camera's codec is likely **HEVC** on that
quality — try `?…` on a medium/low H.264 substream, or set `defaultQuality = "low"`.

## 2. The viewer (Wayland)

```sh
nix run .#unifi-protect-viewer -- --server http://localhost:8460 --cameras "Nursery"
```

From a desktop it opens a kiosk Chromium window; from a bare TTY it brings up `cage` first.

## 3. As a NixOS service

Add the module (see README), rebuild, then:

```sh
systemctl status unifi-protect-monitor
journalctl -u unifi-protect-monitor -f
curl -s localhost:8460/healthz          # -> ok
```

For the kiosk: set `services.unifi-protect-monitor.kiosk.enable = true;` on a host with a
GPU/seat and rebuild — `cage` autostarts the viewer full-screen.

## 4. Recorded playback (opt-in)

Recorded playback uses the **internal** API with a **local-admin session** (the X-API-KEY
does NOT work there). Verify the internal flow directly first (`$C=https://<console>`,
`$U`/`$P` = the local-admin creds):

```sh
# 1. the integration key does NOT authenticate the internal API (expect 500/401):
curl -sk -o /dev/null -w '%{http_code}\n' -H "X-API-KEY: $KEY" "$C/proxy/protect/api/bootstrap"
# 2. session login -> TOKEN cookie + x-csrf-token:
CSRF=$(curl -sk -c /tmp/pj -X POST "$C/api/auth/login" -H 'content-type: application/json' \
  -d "$(jq -n --arg u "$U" --arg p "$P" '{username:$u,password:$p,rememberMe:true}')" \
  -D - -o /dev/null | tr -d '\r' | awk 'tolower($1)=="x-csrf-token:"{print $2}')
# 3. coverage + a 15s clip:
curl -sk -b /tmp/pj -H "x-csrf-token: $CSRF" "$C/proxy/protect/api/bootstrap" \
  | jq -r '.cameras[]|"\(.id) \(.stats.video.recordingStart) \(.stats.video.recordingEnd) \(.name)"'
curl -sk -b /tmp/pj -H "x-csrf-token: $CSRF" -o /tmp/clip.mp4 -w '%{http_code} %{size_download}\n' \
  "$C/proxy/protect/api/video/export?camera=<id>&start=<ms>&end=<ms>&channel=0" && ffprobe /tmp/clip.mp4
```

Then enable `services.unifi-protect-monitor.recordings` (README) and, through the running
server, `curl -s localhost:8460/api/recordings/coverage | jq` and
`curl -s "localhost:8460/api/clip/<id>?start=<ms>&end=<ms>" -o clip.mp4`. In the UI: enlarge a
camera → **▷ Playback** → click/drag the timeline to scrub. (`/api/clip` & `/api/frame` return
`404` until `recordings.enable` is set.)
