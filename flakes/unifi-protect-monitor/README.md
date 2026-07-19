# unifi-protect-monitor

A **UniFi Protect camera wall** — a security / baby-monitor screen you can leave running
or interact with. Two halves:

- **Service** (`services.unifi-protect-monitor`) — a Deno web service that talks to the
  UniFi Protect **Integration API**, serves a dark, camera-first web UI, and bridges each
  camera's live RTSPS stream to the browser (audio on).
- **Program** (`unifi-protect-viewer`) — a full-screen **Wayland** viewer that opens that
  UI as a kiosk (a wall panel / bedside monitor).

Exposed by the antlers root flake as `packages.<system>.unifi-protect-monitor` (backend)
and `.unifi-protect-viewer` (viewer); the service is wired by
`nixosModules.unifi-protect-monitor`. Like `vibe-server`, the backend is a `deno compile`
binary (a generic ELF) run under **nix-ld** by the systemd unit — don't run it directly.

> **Status:** live-tested against a real console (Protect 7.1.87) — dashboard + focus
> modes render live video for all cameras; snapshots, RTSPS→MSE streaming, and the
> event/device subscriptions all work.

## Live view vs. the timeline (important)

- **Grid tiles and the enlarged view are genuinely LIVE** — RTSPS is remuxed by ffmpeg to
  fragmented MP4, streamed over a WebSocket, and played via **MediaSource Extensions**
  (audio kept as AAC, **on by default**). Video is copied (no re-encode), so a wall of
  cameras stays light; tiles use the **medium** substream, the enlarged view uses **high**.
  A camera whose codec a browser can't decode (e.g. HEVC/H.265 on some browsers) falls back
  to periodic **snapshots**.
- **The enlarge view has a live feed AND (opt-in) a recorded-playback scrubber.** The timeline
  always shows **motion / smart-detect event markers** (from `/v1/subscribe/events`) over the
  live feed. When **recorded playback is enabled** (see below), a **● Live / ▷ Playback** toggle
  appears: switch to Playback and click/drag the timeline (or an event marker) to scrub back
  through recorded footage, with hover frame previews. Recorded playback uses Protect's
  *internal* API (the Integration API has no recordings endpoint), which the `X-API-KEY` can't
  authenticate — it needs a local-admin session — so it's **off by default**.

## The two view modes

Driven by the `?cameras=` query (the viewer sets it from `UPM_CAMERAS`):

- **Focus / baby-monitor** — one or more camera **names**: a full-screen multiview of just
  those, **audio on**, **no chrome**, minimal gaps. One name → single full-screen.
- **Dashboard** — no `cameras=`: a grid of **all** cameras. Drag to reorder, resize (cycle
  1/2/3-column span), scroll; the layout is saved in the browser. Click a tile to enlarge
  it with the live feed + the event timeline.

Everything is dark-themed. Audio autoplay needs a one-time gesture in a normal browser; the
kiosk viewer launches Chromium with `--autoplay-policy=no-user-gesture-required`, so it just
plays.

## Getting an API key (do this first)

The key **must be a key the local console recognizes**, sent in the `X-API-KEY` header.

- **Local key (use this):** create it on the console's own UI at `https://<console-ip>` →
  **Settings → Control Plane → Integrations → API Keys → Create** (the admin needs Protect
  access). This authenticates direct-to-console requests.
- **⚠️ Cloud keys 401 locally:** a key created at **unifi.ui.com** (Site Manager / cloud)
  authenticates the **cloud** connector (`api.ui.com`), **not** direct local-IP access — it
  returns `401` against `https://<console-ip>/…`. If you must use a cloud key, use
  `cloud.consoleId` (below) instead of `consoleIP`.

**Verify the key before deploying** (from any host on the LAN):

```sh
curl -sk -H "X-API-KEY: <key>" https://10.10.10.251/proxy/protect/integration/v1/meta/info
# good:  {"applicationVersion":"7.1.87"}
# bad:   {"error":{"code":401,"message":"Unauthorized"}}   -> wrong key type; make a LOCAL key
```

## Running it on NixOS

### 1. Add the flake input

```nix
# flake.nix
{
  inputs.antlers.url = "github:CalamooseLabs/antlers";
  # ... in your nixosSystem modules, import the module below.
}
```

### 2. Enable the service on a host on the camera LAN

```nix
# hosts/<name>/configuration.nix
{ config, inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.unifi-protect-monitor ];

  services.unifi-protect-monitor = {
    enable = true;

    consoleIP  = "10.10.10.251";                          # local console (expands to
                                                          # https://10.10.10.251/proxy/protect/integration)
    apiKeyFile = config.age.secrets.protect-api-key.path; # agenix/sops — never in the store

    # Expose the web UI to the LAN only, and require a password for remote clients.
    openFirewall     = true;
    localNetworkOnly = true;                              # RFC1918 / ULA subnets only
    passwordFile     = config.age.secrets.protect-monitor-pw.path;  # loopback stays trusted

    # Optional tuning:
    # port           = 8460;
    # defaultQuality = "medium";   # grid tiles
    # focusQuality   = "high";     # enlarged / single-camera view
  };
}
```

Point `consoleIP`/`consoleUrl` only at a **trusted local console**: the backend reaches it
over HTTPS + RTSPS (7441) and does **not** verify the console's self-signed TLS cert — the
API key is the auth boundary.

Then browse to `http://<host>:8460/` (or `?cameras=Nursery` for baby-monitor mode).

### The agenix secret (example)

```nix
# secrets are decrypted at activation; the module reads the path at runtime.
age.secrets.protect-api-key.file    = ../secrets/protect-api-key.age;
age.secrets.protect-monitor-pw.file = ../secrets/protect-monitor-pw.age;
```

(`echo -n 'q8Fz…' | agenix -e protect-api-key.age`; sops-nix works the same way — just pass
the resulting path to `apiKeyFile`.)

### A dedicated kiosk screen

Runs the viewer full-screen via `services.cage` on this host:

```nix
services.unifi-protect-monitor.kiosk = {
  enable  = true;
  cameras = [ "Nursery" "Aubrielle's Room" ];  # [] = full dashboard; names = chrome-free multiview
  # server = "http://127.0.0.1:8460";          # default; point elsewhere to view a remote server
};
```

The kiosk connects over **loopback, which is trusted**, so it works even when `passwordFile`
gates remote clients. `cage` takes over **tty1** and the graphical target — enable `kiosk`
only on a dedicated host with **no other display-manager/greetd** (the module warns if it
detects one).

Run the viewer by hand on any Wayland box (or from a bare TTY — it brings up `cage` itself):

```sh
nix run github:CalamooseLabs/antlers#unifi-protect-viewer -- \
  --server http://server-host:8460 --cameras "Nursery,Backyard"
```

Or bake defaults into your home config with the **`programs.unifi-protect-viewer`**
home-manager module, so a bare `unifi-protect-viewer` just opens them (args still override):

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.homeManagerModules.unifi-protect-viewer ];
  programs.unifi-protect-viewer = {
    enable  = true;
    server  = "http://10.10.10.20:8460";
    cameras = [ "Nursery" ];   # optional; empty = full dashboard
  };
}
```

### Recorded playback (opt-in)

The recorded-footage timeline uses Protect's **internal** API, which the `X-API-KEY` does
**not** authenticate — it needs a UniFi-OS **local-admin session** (username + password). So
it's off by default; enable it with a **dedicated local-only admin** account:

```nix
services.unifi-protect-monitor.recordings = {
  enable       = true;
  username     = "protect-monitor";                             # a LOCAL-only admin (no cloud MFA)
  passwordFile = config.age.secrets.protect-local-admin.path;   # agenix/sops
  # channel               = 0;    # 0=high 1=medium 2=low
  # maxClipDurationSeconds = 120;  # caps per-clip export load
};
```

Create that account in the console UI (**Settings → Admins & Users → add an admin with
_Local Access Only_** and Protect access). In the enlarge view you then get a **● Live /
▷ Playback** toggle; in Playback, click/drag the timeline or an event marker to scrub recorded
footage (hover shows a frame preview). It works by exporting short MP4 clips on demand and
chaining them (the export endpoint isn't byte-range seekable). This stores **real admin
credentials** — keep the password in agenix/sops and use a dedicated account (the module warns).

### Cloud-console variant (if you only have a unifi.ui.com key)

```nix
services.unifi-protect-monitor = {
  enable = true;
  cloud.consoleId = "942A…E710560…:9999999999";  # from the unifi.ui.com console URL
  apiKeyFile = config.age.secrets.protect-api-key.path;
};
```

Note: with the cloud connector, API calls route through `api.ui.com`; live RTSPS video is
still pulled from the cameras on your LAN, so the host must reach both.

## Options

| Option | Default | Notes |
|--------|---------|-------|
| `consoleUrl` / `consoleIP` / `cloud.consoleId` | — | set exactly one (Protect API base) |
| `apiKey` / `apiKeyFile` | — | set exactly one; the **file** is a runtime secret (never in the store); the inline **string** lands in the store — avoid |
| `port` / `hostname` | `8460` / `0.0.0.0` | web UI bind |
| `defaultQuality` / `focusQuality` | `medium` / `high` | grid tiles vs. enlarged/single view |
| `streamQualities` | `[high medium low]` | qualities created on the console on demand |
| `passwordFile` | `null` | optional shared-password login (passwordless otherwise; loopback always trusted) |
| `openFirewall` / `localNetworkOnly` | `false` | LAN-scoped firewall opening (+ `localNetworkSubnets`/`…6`) |
| `ffmpegPackage` | `pkgs.ffmpeg-headless` | provides `ffmpeg`/`ffprobe` for the RTSPS→fMP4 bridge |
| `kiosk.enable` / `kiosk.cameras` / `kiosk.server` | `false` / `[]` / loopback | run the viewer as a cage kiosk on this host |
| `recordings.enable` | `false` | opt-in recorded-video scrubber (needs `recordings.username` + `recordings.passwordFile` — a local-admin session) |
| `recordings.channel` / `recordings.maxClipDurationSeconds` | `0` / `120` | export quality (0=high) / per-clip export cap |
| `snapshotCacheMs` / `eventBufferPerCamera` | `2000` / `200` | snapshot cache (quantized to whole seconds) / per-camera event ring |

See `module.nix` for the full set with descriptions.

## Troubleshooting

- **`401 Unauthorized` / "no cameras found":** the key isn't recognized by the local
  console. Almost always a **cloud (unifi.ui.com) key used against a local IP** — create a
  **local** key (see above), or switch to `cloud.consoleId`. Verify with the `curl` above.
- **A tile stays black but its snapshot works:** that camera's stream is likely **HEVC**
  (H.265), which some browsers can't decode in MSE. Use the medium/low H.264 substream
  (`defaultQuality = "low"`), or view it on Chromium (the kiosk viewer).
- **No audio in a normal browser:** click **Enable audio** once (browser autoplay policy).
  The kiosk viewer plays audio without a gesture.
- **Kiosk shows a login page:** it shouldn't (loopback is trusted); if you pointed
  `kiosk.server` at a *remote* password-protected server, that's expected — use a local key
  there or drop the password.
- **`systemctl status unifi-protect-monitor` shows "Protect health check failed":** check
  `consoleIP`/`consoleUrl`, the key, and LAN reachability of the console on 443 + 7441.

## Development

- App is Deno with **zero external imports** (so `deno compile` is offline). `cd app` then
  `deno task test` (offline suite), `deno task check`, or `deno task dev` (set
  `UPM_CONSOLE_URL`, `UPM_API_KEY`/`UPM_API_KEY_FILE`).
- Architecture map: [docs/index.md](docs/index.md). API contract: `docs/protect-openapi.json`
  (UniFi Protect v7.1.87). Manual verification: [SMOKETEST.md](SMOKETEST.md).
