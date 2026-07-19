# cobblemon-overlay

A zero-dependency Deno web service that turns live game state from **The
Cobblemon Initiative** (the Fabric mod's `streamsync` subsystem) into
transparent **OBS browser-source overlays**: a party bar with sprites and
animated HP, a **cemetery of headstones** for the campaign's losses, a
badges/level-cap card, and animated event toasts.

Data flow:

```
mod (battlestation) ──POST /ingest──▶ cobblemon-overlay (broadcast :8082)
                                        │  in-memory state + /var/lib/cobblemon-overlay/state.json
                                        └─SSE /events──▶ OBS browser sources (127.0.0.1:8082)
```

The service survives **hardcore resets**: each distinct `worldId` is one
attempt — a new one banks the previous save's counters into campaign totals,
increments the attempt number, and keeps every headstone. State persists across
service restarts (debounced atomic writes, flushed on shutdown) and boots
*stale* until the mod pushes again. Staleness is judged by **server receive
time**, never the mod's clock.

## Wire protocol (v1)

One JSON document per `POST /ingest`; the overlay replies 2xx. `src/protocol.ts`
is the contract file — keep it in sync with the mod's `streamsync` package.

**Envelope** (strict): `v: 1`, `type: "snapshot" | "event"`, `session` (UUID
minted per SERVER_STARTED), `seq` (monotonic long per session), `t` (mod epoch
ms, informational only). The overlay dedups on per-session `lastSeq`
(`{ok, dup: true}` 2xx, nothing re-applied); a new `session` id resets
tracking. Unknown fields are ignored; missing inner fields default.

**snapshot**:

```json
{
  "v": 1, "type": "snapshot", "session": "…", "seq": 42, "t": 1700000000000,
  "player": "Cole",
  "worldId": "…",
  "world": { "day": 3, "timeOfDay": 1000, "playtimeTicks": 99000 },
  "location": "Route 1",
  "party": [
    { "slot": 0, "uuid": "…", "species": "cobblemon:pikachu", "dex": 25,
      "name": "Sparky", "level": 12, "hp": 30, "maxHp": 35,
      "fainted": false, "shiny": true, "gender": "male", "heldItem": "light_ball" }
  ],
  "deaths": { "total": 1, "whiteouts": 0, "sacrifices": 0, "duplicateReleases": 1 },
  "progress": { "badges": 2, "levelCap": 28, "nextLevelCap": 36, "trainersDefeated": 7 },
  "quest": { "name": "First Steps", "stage": 2 }
}
```

`worldId` is a UUID minted once per save (persisted in the mod's stats file) —
it is how the service detects new hardcore attempts. When absent (old-protocol
pushes), a `deaths.total` **decrease** is the fallback detector. `party` is
capped at 6; a member without `species` is dropped.

**events** — `"type": "event"` plus an `event` discriminator, fields flat in
the same document:

| `event`            | fields                                                        |
| ------------------ | ------------------------------------------------------------- |
| `pokemon_lost`     | `cause: faint\|sacrifice\|duplicate_release`, `pokemon`, `deathsTotal?` |
| `capture`          | `pokemon`                                                     |
| `whiteout`         | `reason: faint\|flee\|forfeit`                                |
| `badge`            | `badgeId`, `badges?`                                          |
| `trainer_defeated` | `trainerId`, `trainerName`, `category`                        |
| `level_cap`        | `cap`                                                         |
| `session_start`    | `modVersion`, `protocol`                                      |
| `session_stop`     | —                                                             |

`pokemon` is `{species, dex, name, level, shiny?}`. Every **newly**-accepted
`pokemon_lost` appends a memorial entry `{kind: "pokemon", name, species, dex,
level, cause, attempt, ts}` and every newly-accepted `whiteout` appends a
`{kind: "player"}` grave for the trainer (name from the latest snapshot,
fallback `Trainer`; `cause` = the whiteout reason) — the cemetery/graveyard
data, kept forever. Entries persisted before `kind` existed load as
`kind: "pokemon"`. The service also emits a synthetic `new_attempt` toast event
when it detects a reset (the mod never sends it).

**Auth**: when a token is configured, ingest requires `Authorization: Bearer
<token>` (or `X-Overlay-Token: <token>`); compared timing-safely. Responses:
`200 {ok}` / `200 {ok, dup}` / `400` (bad JSON, wrong `v`, invalid message) /
`401` / `413` (body over 64 KiB) / `405`.

**Sprites**: the mod only sends ids (`species` + `dex`). The overlay maps them
to bundled [msikma/pokesprite](https://github.com/msikma/pokesprite) gen-8 box
icons (fetched at *build* time — zero internet dependency on stream night):
slug match first (lowercase, strip `cobblemon:`; a dash-less loose index covers
`mrmime` → `mr-mime`), `dex` number as fallback, and a clean 404 otherwise —
the pages then fall back to text, never a broken card.

## Endpoints

| Path                     | What                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `POST /ingest`           | mod push endpoint (see above)                               |
| `GET /events`            | SSE: full `state` on connect (+ `status`), then live `state` / `game` / `status` events, 15s keepalives. **No event replay on connect** — refreshing OBS never re-fires toasts |
| `GET /overlay/party`     | 6 party cards: sprite, name, Lv, tweened HP bar, shiny ★, faint = grayscale + cross fade-in |
| `GET /overlay/cemetery`  | the graveyard: rising headstones grouped by attempt plaques, totals header; `?compact=1` = counter only; player whiteouts get a distinct darker cross-topped stone |
| `GET /overlay/graveyard` | retro pixel graveyard **scene** (GBA-look): stepped hill silhouettes, dithered grass band, drifting blocky fog (two bands behind the stones, one in front); sprite-sized stones in staggered depth rows with deterministic per-grave jitter (stable across reloads) — gray pixel headstone by default, a cheap wooden stake + crooked plank sign for sacrifices, a taller dark cross-topped slab for player whiteouts (no text on stones); `?tooltips=1` = cycling pixel bubble with nickname + cause of death (one grave at a time, ~2.5s each), `?max=N` = newest N stones |
| `GET /overlay/badges`    | badge count + current level cap                             |
| `GET /overlay/toasts`    | ~6s animated cards: loss=red, capture=green, badge=gold, whiteout=full-width slam, new-attempt banner |
| `GET /status`            | server-rendered debug page                                  |
| `GET /api/state.json`    | the full public state as JSON                               |
| `GET /sprites/<slug>.png?dex=N` | bundled sprite (cacheable; everything else is `Cache-Control: no-store`) |
| `GET /healthz`           | liveness probe `{ok, live, lastIngestAt}`                   |

Overlay pages have a transparent background and fade when the feed goes stale
(default: 15s without an accepted ingest).

## NixOS module

```nix
{
  imports = [inputs.antlers.nixosModules.cobblemon-overlay];
  services.cobblemon-overlay = {
    enable = true;
    hostname = "0.0.0.0"; # mod pushes over the LAN; OBS reads 127.0.0.1
    port = 8082;
    openFirewall = true;
    localNetworkOnly = true;
    localNetworkSubnets = ["10.10.10.30/32"]; # tokenless: the /32 IS the gate
    # or authenticate instead of (as well as) pinning the subnet:
    # tokenFile = "/run/secrets/cobblemon-overlay-token";
  };
}
```

Options: `port` (8082), `hostname`, `stateDir` (`/var/lib/cobblemon-overlay` —
the compiled binary's write scope, keep it there), `tokenFile` (staged via
systemd `LoadCredential`, never in the store), `staleAfterSec` (15),
`eventLogSize` (500), `spriteDir` (defaults to the package's bundled pokesprite
icons), `user`/`group` (`cobblemon-overlay` + `StateDirectory`),
`openFirewall`, `localNetworkOnly`, `localNetworkSubnets`(+`6`), `enableNixLd`.
The unit is hardened but deliberately has **no** `SystemCallFilter` /
`MemoryDenyWriteExecute` (both break V8's JIT). A warning fires when ingest is
exposed unauthenticated beyond restricted subnets.

## OBS setup

Browser sources on the OBS host (keep **"Shutdown source when not visible"
OFF** for toasts — an SSE drop would miss events; there is no replay by
design):

| Source   | URL                                            | Size (approx.) |
| -------- | ---------------------------------------------- | -------------- |
| party    | `http://127.0.0.1:8082/overlay/party`          | 1000×140       |
| cemetery | `http://127.0.0.1:8082/overlay/cemetery`       | to taste (intermission scene) |
| counter  | `http://127.0.0.1:8082/overlay/cemetery?compact=1` | 300×80 corner |
| graveyard | `http://127.0.0.1:8082/overlay/graveyard`     | 900×230 bottom strip, pixel scene (`?tooltips=1` = cycling name + cause bubble, `?max=N` = newest N) |
| badges   | `http://127.0.0.1:8082/overlay/badges`         | 320×80         |
| toasts   | `http://127.0.0.1:8082/overlay/toasts`         | 480×600        |

## Dev loop

```sh
cd flakes/cobblemon-overlay/app

# unit tests (offline, import-free)
deno test --allow-read --allow-write --allow-net --no-lock test/

# run against a dev config
cat > /tmp/co-dev.json <<'EOF'
{ "port": 8082, "hostname": "127.0.0.1", "stateDir": "/tmp/co-state", "spriteDir": "" }
EOF
COBBLEMON_OVERLAY_CONFIG=/tmp/co-dev.json deno run --allow-read --allow-write --allow-net --allow-env src/main.ts

# push a fake snapshot + a loss, watch /overlay/party and /status in a browser
curl -s http://127.0.0.1:8082/ingest -d '{"v":1,"type":"snapshot","session":"dev","seq":1,"t":0,"player":"Dev","worldId":"w1","location":"Route 1","party":[{"slot":0,"species":"pikachu","dex":25,"name":"Sparky","level":12,"hp":30,"maxHp":35}],"deaths":{"total":0},"progress":{"badges":1,"levelCap":15}}'
curl -s http://127.0.0.1:8082/ingest -d '{"v":1,"type":"event","session":"dev","seq":2,"t":0,"event":"pokemon_lost","cause":"faint","pokemon":{"species":"pikachu","dex":25,"name":"Sparky","level":12},"deathsTotal":1}'

# restart the service → counters persist, overlays come back stale until the next push
```

Then `nix build .#cobblemon-overlay` (compiled binary + bundled sprites) and
`nix flake check` (the `cobblemon-overlay-unit` / `-module` checks).

The app has **zero external imports** (no `jsr:`/`npm:`/`https:`/`@std`) so the
deno-cache FOD stays empty and the build works offline; keep tests import-free
via `test/assert.ts`.
