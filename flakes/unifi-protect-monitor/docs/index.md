# unifi-protect-monitor — architecture

A camera-wall for UniFi Protect: a Deno backend service + a Wayland kiosk viewer.
User-facing setup lives in the [README](../README.md); this is the developer map.

## Pieces

```
app/server/        the backend (deno compile target: server/main.ts)
  config.ts          load /etc config; resolve apiKey (string|file); env overrides
  protect.ts         Integration API client (X-API-KEY): cameras, snapshot, rtsps-stream, subscribe
  ws.ts              minimal RFC 6455 client (Deno's WebSocket can't send X-API-KEY)
  stream.ts          ffmpeg RTSPS -> fragmented-MP4, per-socket, + MSE codec detection
  events.ts          upstream event/device subscriptions -> per-camera ring -> browser fan-out
  protect-internal.ts  INTERNAL API client (session login) for recorded playback (opt-in)
  auth.ts            optional shared-password gate (HMAC-signed cookie)
  router.ts          HTTP + WS routes
  html.ts            the dark, camera-first SPA (inlined; imperative DOM, no template literals)
  main.ts            wire-up + Deno.serve
app/viewer/main.ts   Deno Desktop (2.9) window -> backend URL (forward-looking track)
app/test/            offline deno tests (zero external imports)
package.nix          deno compile the backend (denort FOD; --no-remote; bakes ignore-cert)
viewer.nix           the shipped viewer: Chromium in cage
module.nix           services.unifi-protect-monitor (+ .kiosk via services.cage)
docs/protect-openapi.json   the UniFi Protect Integration API contract (v7.1.87)
```

## Live-video path

`browser MSE  <—WS(/ws/live/:id/:q)—  backend  <—spawn—  ffmpeg  <—RTSPS—  camera`

1. Browser opens `GET /ws/live/<id>/<quality>`.
2. Backend `ensureRtspsUrl` (GET, else POST `/rtsps-stream`) → an `rtsps://…:7441/…` URL.
3. `ffprobe` learns the video codec → an exact MSE mime, sent as the first TEXT frame
   `{type:"init", mime}`.
4. `ffmpeg -c:v copy -c:a aac -f mp4 -movflags +frag_keyframe+empty_moov…` → fMP4 on
   stdout, relayed as BINARY frames; the browser appends them to a `SourceBuffer`.
5. One ffmpeg per socket; reaped on close. Backpressure drops data past 16 MB buffered.

## Event timeline + recorded playback

The enlarge view timeline always shows an event ribbon from `/v1/subscribe/events` (motion /
smart-detect / ring), kept in per-camera ring buffers and pushed to browsers over `/ws/events`.

The Integration API has **no recorded-video endpoint**, so recorded playback (opt-in,
`recordings.enable`) uses Protect's **internal** API (`protect-internal.ts`), which the
X-API-KEY can't authenticate — it needs a UniFi-OS session:

`POST /api/auth/login` → `TOKEN` JWT cookie + `x-csrf-token` (re-login near expiry / on 401).
Then per camera: `GET /proxy/protect/api/bootstrap` for the recorded `[start,end]` coverage,
`GET /proxy/protect/api/video/export?camera&start&end&channel` for a clip (H.264+AAC MP4,
**not** byte-range seekable → the frontend chains short `<video src>` clips), and
`GET …/recording-snapshot?ts` for the hover thumbnail. Routes: `/api/recordings/coverage`,
`/api/clip/:id`, `/api/frame/:id` (all behind the app's auth gate; 404 when disabled).

## Conventions

- **Zero external Deno imports** (`deno.jsonc` `vendor:true`) — so `deno compile` is offline
  and the Nix build needs no dep-vendoring FOD (same as vibe-server/robomoose). ffmpeg is a
  Nix runtime dep, not a Deno import.
- TLS to the local self-signed console is **not verified** (baked
  `--unsafely-ignore-certificate-errors`); the X-API-KEY is the boundary.
- Tests are offline and network-free except loopback (`ws_test.ts`).
