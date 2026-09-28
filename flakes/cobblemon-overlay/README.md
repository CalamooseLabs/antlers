# cobblemon-overlay

A zero-dependency Deno web service that turns live game state from **The
Cobblemon Initiative** (the Fabric mod's `streamsync` subsystem) into
transparent **OBS browser-source overlays**: a party bar with sprites and
animated HP, a **cemetery of headstones** for the campaign's losses, a
badges/level-cap card, and animated event toasts.

It also hosts the durable **channel-point effect queue** between multichat
(Twitch redemptions) and the mod — see [Channel-point effects](#channel-point-effects).

Data flow:

```
mod (battlestation) ──POST /ingest──▶ cobblemon-overlay (broadcast :8082)
                                        │  in-memory state + /var/lib/cobblemon-overlay/state.json
                                        └─SSE /events──▶ OBS browser sources (127.0.0.1:8082)

multichat (broadcast :8081) ──loopback: POST /effects, GET /effects?ids=, cancel, health──▶ cobblemon-overlay
mod (battlestation)         ──LAN: POST /effects/claim, POST /effects/<id>/result──────────▶  (+ effects.json)
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
| `player_death`     | `cause`, `deathMessage?`, `killedBy?`                         |
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
`200 {ok}` / `200 {ok, dup}` / `200 {ok, ignored}` (an event name not in the
table above, on an otherwise valid envelope — e.g. a newer mod's
`achievement`: acked and applied nowhere, because the mod's pusher retries a
4xx forever and would freeze every later push behind it) / `400` (bad JSON,
wrong `v`, bad envelope, missing event name, a known event missing its required
fields) / `401` / `413` (body over 64 KiB) / `405`.

**Sprites**: the mod only sends ids (`species` + `dex`). The overlay maps them
to bundled national-dex **gen 1–9** box icons ([msikma/pokesprite](https://github.com/msikma/pokesprite)
for gen 1–8, the [National Pokédex Version Delta](https://www.deviantart.com/mbcmechachu/art/National-Pokedex-Icon-Dex-824897934)
project for gen 9; vendored in `./sprites`, so zero internet dependency at build
*or* stream time): slug match first (lowercase, strip `cobblemon:`; a dash-less
loose index covers `mrmime` → `mr-mime`), `dex` number as fallback, and a clean
404 otherwise — the pages then fall back to text, never a broken card. (Some
gen-9 *alternate-form* icons ship but only render when the mod sends a matching
Cobblemon aspect — see `sprites/README.md` and `src/sprites.ts` `FORM_ASPECTS`.)

## Endpoints

| Path                     | What                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `POST /ingest`           | mod push endpoint (see above)                               |
| `POST /control`          | operator control (`{action:"set", attempt, bank?}` / `{action:"reset"}`), ingest token gate |
| `/effects…`              | the channel-point effect queue — see [below](#channel-point-effects) |
| `GET /overlay/redeems`   | channel-point redemption memos (see below)                  |
| `GET /events`            | SSE: full `state` on connect (+ `status`), then live `state` / `game` / `status` events, 15s keepalives. **No event replay on connect** — refreshing OBS never re-fires toasts |
| `GET /overlay/party`     | 6 party cards: sprite, name, Lv, tweened HP bar, shiny ★, faint = grayscale + cross fade-in |
| `GET /overlay/cemetery`  | the graveyard: rising headstones grouped by attempt plaques, totals header; `?compact=1` = counter only; player whiteouts get a distinct darker cross-topped stone |
| `GET /overlay/graveyard` | Lavender-Town-mood Game Boy pixel graveyard **scene** (flat GBC palette + black outlines): THE COMPANY, INC. — the campaign's corporate antagonist — looms behind the yard as one big pixel office tower (stepped roofline + antenna, window grid whose handful of lit windows slowly shifts on a steps(1) cycle — plus 2-3 bad windows buzzing with a fast irregular dying-fluorescent-tube flicker, pixel-aligned over the window grid, bordered sign plaque, awning + dark-glass double-door entrance, two darker wings for skyline depth), a corporate parking-lot lamp row on the lawn (tall double-arm posts with warm lit heads + hard-edged light pools, evenly spaced with a center gap for the entrance; one lamp buzzes like the bad windows, out of sync) with a few standalone round-top trees scattered between the lamps, muted checker-tiled grass with grass tufts + 2-frame blooming lavender flowers, cool-tinted drifting blocky mist (two bands behind the stones, one in front); build-time box-shadow pixel-art markers in staggered depth rows with deterministic per-grave jitter (stable across reloads) — a Lavender-Town rounded-top/stepped-base headstone by default, a cheap crooked wooden stake + plank sign for sacrifices, a taller dark stone cross for player whiteouts (no text on stones, the mini sprite is the face of the grave); `?tooltips=1` = cycling mini Pokémon-textbox bubble with nickname + cause of death (one grave at a time, ~2.5s each), `?max=N` = newest N stones |
| `GET /overlay/badges`    | badge count + current level cap                             |
| `GET /overlay/toasts`    | ~6s animated cards: loss=red, capture=green, badge=gold, whiteout=full-width slam, new-attempt banner |
| `GET /status`            | server-rendered debug page                                  |
| `GET /api/state.json`    | the full public state as JSON                               |
| `GET /sprites/<slug>.png?dex=N` | bundled sprite (cacheable; everything else is `Cache-Control: no-store`) |
| `GET /healthz`           | liveness probe `{ok, live, lastIngestAt}`                   |

Overlay pages have a transparent background and fade when the feed goes stale
(default: 15s without an accepted ingest).

## Channel-point effects

Twitch channel-point rewards that make the hardcore-Nuzlocke run harder.
**multichat** owns the Twitch side (rewards, the redemption ledger,
FULFILLED/CANCELED + refunds); **the mod** executes; this service is the
**durable queue** between them plus the on-stream memo cards. Wire protocol v1
gains no event names and no `v` bump (the mod's pusher wedges on any 4xx) —
effects ride their own routes, all JSON with `Cache-Control: no-store`. The
idempotency key end-to-end is the **Twitch redemption id**.

**Auth.** The *multichat-facing* routes require the TCP peer to be **loopback**
(multichat runs on the same host; non-loopback → `403 {ok:false,
reason:"forbidden"}`) and, when `effects.tokenFile` is set, **also**
`Authorization: Bearer <effects token>` (`401 {ok:false, reason:"unauthorized"}`).
The *mod-facing* routes use the **ingest token** rule (Bearer or
`X-Overlay-Token`; open when no `tokenFile`) and are not loopback-gated. Bodies
are capped at 64 KiB (`413`). **Every** `/effects*` route first refuses a
browser page — any request carrying an `Origin` header, or a `Sec-Fetch-Site`
other than `none`/`same-origin` → `403 {ok:false, reason:"forbidden"}` — so a
page open in a browser on the broadcast host can't drive the queue through the
loopback gate (multichat, the mod and curl send neither header). A transition
whose write to `effects.json` fails answers `500 {ok:false,
reason:"persist_failed"}` (both callers retry a 5xx).

| Route (who)                          | Body / query → reply |
| ------------------------------------ | -------------------- |
| `POST /effects` (multichat)          | `{id, effect, params?, viewer, viewerLogin?, reward, cost?, simulated?, ttlSec?}` (`ttlSec` clamped 30..3600, default `effects.ttlSec`) → new `202 {ok, status:"pending"}` · known id `200 {ok, dup:true, status}` · `503 {reason:"disabled"}` · `503 {reason:"game_offline"}` (the mod hasn't polled within `effects.acceptWindowSec`) · `429 {reason:"queue_full"}` · `400 {reason:"bad_request", error}` |
| `GET /effects?ids=a,b` (multichat)   | ≤50 ids → `{ok, effects:[{id, status, reason?, detail?, updatedAt}]}` (unknown ids omitted) |
| `POST /effects/<id>/cancel` (multichat) | `{reason?: refunded\|fulfilled_externally\|manual\|timeout}` (absent, unknown or unparseable = `refunded` — a cancel is never refused over its body) → never-delivered pending → `{ok, status:"canceled"}` · leased/accepted (or pending again after a lapsed lease/restart) → `{ok, status, cancelRequested:true}` (relayed to the mod, never re-leased) · final → `{ok, status}` · unknown → `404 {reason:"unknown"}`. The first cancel's reason is kept (`cancelReason`) and is the `reason` of the record's `effect_result` if it ends unrun |
| `GET /effects/health` (multichat)    | `{ok, enabled, accepting, lastPollAgoMs\|null, ready, open, pending}` — multichat auto-pauses the rewards while `accepting` is false |
| `POST /effects/claim` (mod)          | `{max?: 1..10 (3), ready, modVersion?}` → heartbeat; when `ready`, leases up to `max` pending effects (FIFO, persisted before the reply): `{ok, effects:[{id, effect, params, viewer, reward, simulated, expiresInMs}], cancels:[ids]}` (`expiresInMs` is relative — the hosts' clocks differ; `cancels` always included) |
| `POST /effects/<id>/result` (mod)    | `{status: accepted\|applied\|armed\|rejected\|expired, reason? (≤64), detail? (≤160)}` → `{ok, status}` · final/unknown id → `{ok, ignored:true, status}` (**never** a 4xx — the mod's outbox must not wedge) · `400` only for a malformed body |

**Lifecycle.** `pending ─claim→ leased ─accepted→ accepted ─final→
applied|armed|rejected|expired`. A lease not `accepted` within
`effects.leaseSec` (30s) goes back to `pending` and is redelivered (the mod
dedups by id); a leased record may take a final result directly, and a late
result still lands after a lease lapse. `cancel` on a never-delivered pending
record makes it `canceled`; on one the mod may hold (leased, accepted, or
pending again after a lapsed lease or a restart) it sets `cancelRequested`: the
record is never leased again, the id rides every claim's `cancels`, and the mod
rejects it (`canceled`) if it hasn't run yet — or the sweeper expires it. Any
open record 60s past its `expiresAt` is
swept to `expired` (`reason:"timeout"`) by the 5s sweeper. **Final states never
change.** `applied`/`armed` ⇒ multichat FULFILLS; `rejected`/`expired`/`canceled`
⇒ CANCELED (refund). Finals are kept 24h, hard cap 1000 records (oldest finals
pruned first).

**Durability.** Every transition is written through to
`/var/lib/cobblemon-overlay/effects.json` (its own file — never `state.json`)
and awaited before the reply, via a serialized writer (unique tmp + fsync +
rename). If that write fails (disk full, EIO), the in-memory queue is rolled
back to exactly the last durable state and the request gets a `500`: a lookup
or claim never acts on a transition a restart would forget, and the caller's
retry redoes it — including the `redeem`/`effect_result` broadcast the failed
attempt skipped. Lookups answer only once what they report is durable. On
boot, leased records return to pending. The mod's heartbeat is
in-memory only, so after a restart the queue reports `game_offline` until the
mod polls again (~1.5s). (`state.json` uses the same serialized writer, which
fixed two persistence races: a mutation during an in-flight write being lost by
a later flush, and overlapping flushes sharing one `.tmp`.)

**On stream.** Each accepted enqueue broadcasts an SSE `game` event
`{event:"redeem", id, viewer, reward, effect, cost, simulated}`, and every final
transition `{event:"effect_result", id, viewer, reward, effect, status, reason,
detail, simulated}` (a canceled record's `reason` is the cancel's reason) —
rendered ONLY by `/overlay/redeems` (a The Company, Inc. memo per redemption,
"MEMO — <viewer> filed: <reward>", stamped **APPROVED** or **DENIED +
REFUNDED** with the detail — or **CLOSED + NO ACTION** for a
`fulfilled_externally` cancel, i.e. a mod completed it in the Twitch queue: the
points are spent and nothing ran, so the card never claims a refund;
`/overlay/toasts` ignores both).
`/status` shows the queue (accepting, last poll, and a per-effect table).

**Deploy order: overlay first**, then multichat, then the mod — an older overlay
answers `405` on every `/effects` route, so it must be upgraded before either
caller starts using them.

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
    # channel-point effects (on by default; multichat reaches them over loopback):
    # effects.tokenFile = "/run/secrets/cobblemon-overlay-effects-token";
  };
}
```

Options: `port` (8082), `hostname`, `stateDir` (`/var/lib/cobblemon-overlay` —
the compiled binary's write scope, keep it there), `tokenFile` (staged via
systemd `LoadCredential`, never in the store), `staleAfterSec` (15),
`eventLogSize` (500), `spriteDir` (defaults to the package's bundled pokesprite
icons), `user`/`group` (`cobblemon-overlay` + `StateDirectory`),
`openFirewall`, `localNetworkOnly`, `localNetworkSubnets`(+`6`), `enableNixLd`,
and the effect queue's `effects.enable` (true), `effects.leaseSec` (30),
`effects.ttlSec` (600), `effects.acceptWindowSec` (45), `effects.maxOpen` (100),
`effects.tokenFile` (multichat's Bearer, `LoadCredential` `effects-token` →
`COBBLEMON_OVERLAY_EFFECTS_TOKEN_FILE`; set the same secret as multichat's
`channelPoints.overlayTokenFile`). No firewall change is needed for effects:
multichat is loopback, and the mod pulls over the existing subnet pin.
The unit is hardened but deliberately has **no** `SystemCallFilter` /
`MemoryDenyWriteExecute` (both break V8's JIT). A warning fires when ingest
(and with it the mod-facing effect routes) is exposed unauthenticated beyond
restricted subnets.

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
| redeems  | `http://127.0.0.1:8082/overlay/redeems`        | 480×700, its own source (a redemption burst never evicts a loss/death toast); keep "Shutdown source when not visible" OFF too |

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

# channel-point effects: act as the mod (claim) and as multichat (enqueue, loopback),
# with /overlay/redeems open
curl -s http://127.0.0.1:8082/effects/claim -d '{"ready":false}'
curl -s http://127.0.0.1:8082/effects -d '{"id":"sim-1","effect":"potion","params":{"effect":"slowness"},"viewer":"Dev","reward":"Budget Cuts","cost":750,"simulated":true}'
curl -s http://127.0.0.1:8082/effects/claim -d '{"ready":true}'
curl -s http://127.0.0.1:8082/effects/sim-1/result -d '{"status":"applied","detail":"Slowness II for 45s"}'
curl -s 'http://127.0.0.1:8082/effects?ids=sim-1'
```

Then `nix build .#cobblemon-overlay` (compiled binary + bundled sprites) and
`nix flake check` (the `cobblemon-overlay-unit` / `-module` checks).

The app has **zero external imports** (no `jsr:`/`npm:`/`https:`/`@std`) so the
deno-cache FOD stays empty and the build works offline; keep tests import-free
via `test/assert.ts`.
