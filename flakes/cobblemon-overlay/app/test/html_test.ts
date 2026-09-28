// HTML/XSS + sprite-mapping tests: escapeHtml, the server-rendered status and
// graveyard pages, the client pages' safety conventions, and the sprite slug
// sanitizer/fallback — plus the /overlay/redeems memo page and the toasts page
// EXECUTED against a tiny fake DOM (textContent-only rendering, the memo
// stamping, unknown game events ignored) and the /status effects section.

import { escapeHtml } from "../src/util.ts";
import { sanitizeSlug, SpriteStore } from "../src/sprites.ts";
import {
  BADGES_HTML,
  CEMETERY_HTML,
  FLICKER_WINDOWS,
  gravePlacement,
  PARTY_HTML,
  pixelArt,
  PLAYER_MAP,
  REDEEMS_HTML,
  renderGraveyardPage,
  renderStatusPage,
  STAKE_MAP,
  STONE_MAP,
  TOASTS_HTML,
  TOWER_MAP,
  TOWER_WIN_X,
  towerWindowCell,
  TREE_MAP,
} from "../src/html.ts";
import { handleIngest } from "../src/ingest.ts";
import { type MemorialEntry, OverlayState, type PublicState } from "../src/state.ts";
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";

Deno.test("escapeHtml neutralizes markup", () => {
  assertEquals(
    escapeHtml(`<img src=x onerror=alert("pwn")>&'`),
    "&lt;img src=x onerror=alert(&quot;pwn&quot;)&gt;&amp;&#39;",
  );
  assertEquals(escapeHtml("plain"), "plain");
});

function hostileView(): PublicState {
  const evil = `<script>alert("x")</script>`;
  return {
    live: true,
    lastIngestAt: 1000,
    updatedAt: 1000,
    attempt: 1,
    session: "s",
    player: evil,
    location: evil,
    world: null,
    party: [{
      slot: 0,
      uuid: "u",
      species: evil,
      dex: 1,
      name: evil,
      level: 5,
      hp: 1,
      maxHp: 5,
      fainted: false,
      shiny: false,
      gender: "",
      heldItem: "",
    }],
    deaths: { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 },
    campaign: { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 },
    progress: { badges: 0, levelCap: 0, nextLevelCap: 0, trainersDefeated: 0 },
    quest: { name: evil, stage: "1" },
    memorial: [
      { kind: "pokemon", name: evil, species: evil, dex: 1, level: 5, cause: "faint", attempt: 1, ts: 1000 },
      { kind: "player", name: evil, species: "", dex: 0, level: 0, cause: "forfeit", attempt: 1, ts: 2000 },
    ],
  };
}

Deno.test("status page escapes every player-controlled string", () => {
  const html = renderStatusPage(hostileView(), {
    events: [{ event: "pokemon_lost", ts: 1, attempt: 1, pokemon: { name: `<b>evil</b>` } }],
    spriteCount: 0,
    tokenConfigured: false,
    staleAfterSec: 15,
  });
  assert(!html.includes(`<script>alert`), "raw nickname markup must never appear");
  assert(!html.includes("<b>evil</b>"), "event JSON must be escaped");
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("end-to-end: hostile nickname via real ingest → state → status page is escaped", async () => {
  const state = new OverlayState({ stateDir: "", eventLogSize: 10, staleAfterSec: 15, persistDebounceMs: 50 });
  const hub = { broadcastState() {}, broadcastGame() {} };
  const evil = "<script>alert(1)</script>";
  const res = await handleIngest(
    new Request("http://overlay.test/ingest", {
      method: "POST",
      body: JSON.stringify({
        v: 1,
        type: "snapshot",
        session: "s-xss",
        seq: 1,
        t: 1,
        player: evil,
        location: evil,
        party: [{ species: evil, dex: 1, name: evil, level: 5, hp: 1, maxHp: 5 }],
        quest: { name: evil, stage: evil },
      }),
    }),
    { state, hub, token: "", maxBodyBytes: 65536, now: () => 1000 },
  );
  assertEquals(res.status, 200);
  await handleIngest(
    new Request("http://overlay.test/ingest", {
      method: "POST",
      body: JSON.stringify({
        v: 1,
        type: "event",
        session: "s-xss",
        seq: 2,
        t: 1,
        event: "pokemon_lost",
        cause: "faint",
        pokemon: { species: evil, dex: 1, name: evil, level: 5 },
      }),
    }),
    { state, hub, token: "", maxBodyBytes: 65536, now: () => 1100 },
  );
  const html = renderStatusPage(state.view(1200), {
    events: state.recentEvents(),
    spriteCount: 0,
    tokenConfigured: false,
    staleAfterSec: 15,
  });
  assert(!html.includes(evil), "raw <script> payload must never reach the page");
  assert(!html.includes("<script>alert"), "no unescaped script tag anywhere");
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

Deno.test("overlay pages: transparent bg, SSE, textContent-only rendering", () => {
  for (const html of [PARTY_HTML, CEMETERY_HTML, BADGES_HTML, TOASTS_HTML, REDEEMS_HTML]) {
    assertStringIncludes(html, "background: transparent");
    assertStringIncludes(html, "new EventSource('/events')");
    assert(!html.includes("innerHTML"), "player strings must go through textContent");
  }
  // the animation obligations from the plan
  assertStringIncludes(PARTY_HTML, "transition: width .6s ease"); // HP tween
  assertStringIncludes(PARTY_HTML, "grayscale(1)"); // faint
  assertStringIncludes(PARTY_HTML, "crossIn"); // cross fade-in
  assertStringIncludes(CEMETERY_HTML, "@keyframes rise"); // headstones rise
  assertStringIncludes(TOASTS_HTML, "@keyframes slideIn"); // toast slide
  assertStringIncludes(TOASTS_HTML, "@keyframes fadeOut"); // toast fade
  // player whiteout graves get the distinct stone (CSS + the client kind branch)
  assertStringIncludes(CEMETERY_HTML, ".stone.player");
  assertStringIncludes(CEMETERY_HTML, "'stone player'");
});

// ---- /overlay/graveyard (server-rendered scene) ----

function graveyardView(memorial: MemorialEntry[]): PublicState {
  return {
    live: true,
    lastIngestAt: 1000,
    updatedAt: 1000,
    attempt: 1,
    session: "s",
    player: "Cole",
    location: "Route 1",
    world: null,
    party: [],
    deaths: { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 },
    campaign: { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 },
    progress: { badges: 0, levelCap: 0, nextLevelCap: 0, trainersDefeated: 0 },
    quest: null,
    memorial,
  };
}

function mon(name: string, species: string, dex: number, ts: number): MemorialEntry {
  return { kind: "pokemon", name, species, dex, level: 11, cause: "faint", attempt: 1, ts };
}

Deno.test("graveyard renders all three stone variants, keeps the shell conventions", () => {
  const html = renderGraveyardPage(
    graveyardView([
      mon("Vee", "eevee", 133, 1111),
      { kind: "pokemon", name: "Marty", species: "magikarp", dex: 129, level: 7, cause: "sacrifice", attempt: 1, ts: 1500 },
      { kind: "player", name: "Cole", species: "", dex: 0, level: 0, cause: "forfeit", attempt: 1, ts: 2222 },
    ]),
    { tooltips: false, max: 0 },
  );
  assertStringIncludes(html, "background: transparent");
  assertStringIncludes(html, "new EventSource('/events')");
  assert(!html.includes("innerHTML"), "player strings must go through textContent/escapeHtml");
  assertStringIncludes(html, "@keyframes rise"); // new graves use the rise animation
  assertStringIncludes(html, `class="grave settled`); // …but pre-rendered ones don't replay it
  // default: gray pixel headstone with the sprite as the face of the grave
  assertStringIncludes(html, `<div class="stone"><img class="gsprite"`);
  assertStringIncludes(html, "/sprites/eevee.png?dex=133");
  // sacrifice: wooden stake with the sprite small on the plank sign
  assertStringIncludes(html, `class="stone stake"`);
  assertStringIncludes(html, `<div class="plank"><img class="gsprite"`);
  assertStringIncludes(html, "/sprites/magikarp.png?dex=129");
  // player: dark slab + pixel cross, no text at all
  assertStringIncludes(html, `<div class="stone player"><div class="pcross"></div></div>`);
  assert(!html.includes("Cole"), "the trainer stone carries no text");
  // no text on any stone without ?tooltips=1
  assert(!html.includes("Vee"), "pokemon stones show no visible name");
  assert(!html.includes("Marty"));
  assert(!html.includes("Lv "), "no level text on stones");
  // pixel discipline: sprites stay crisp, no rounded corners anywhere
  assertStringIncludes(html, "image-rendering: pixelated");
  assert(!html.includes("border-radius"), "pixel-art page: no border-radius curves");
});

Deno.test("graveyard scenery: Company tower, parking-lot lamps + trees, Lavender grass/decor, drifting mist", () => {
  const html = renderGraveyardPage(graveyardView([]), { tooltips: false, max: 0 });
  const rule = (sel: string) => {
    const i = html.indexOf(sel + " { ");
    assert(i >= 0, sel + " rule exists");
    return html.slice(i, html.indexOf("}", i));
  };
  // the old tree line is gone — THE COMPANY, INC. looms in its place
  assert(!html.includes("treeline"), "tree line replaced by the office tower");
  assertStringIncludes(html, `class="bldg"`);
  assertStringIncludes(html, `class="tower"`);
  assertStringIncludes(html, `class="wing wing-l"`);
  assertStringIncludes(html, `class="wing wing-r"`);
  // the tower is build-time pixelArt() box-shadow in corporate blue-grays
  const tower = rule(".tower");
  assertStringIncludes(tower, "box-shadow:");
  assertStringIncludes(tower, "#a0b0c8"); // light tower face
  assertStringIncludes(tower, "#383848"); // dark office windows
  assertStringIncludes(tower, "#f8d878"); // a handful of lit windows
  assertStringIncludes(tower, "#101010"); // black pixel outline
  // window flicker: slow steps(1) swap to a second frame of the SAME building
  // that lights a different window set (people moving about the office)
  assertStringIncludes(tower, "animation: officeShift 11s steps(1) infinite");
  const flick = rule("@keyframes officeShift");
  assertStringIncludes(flick, "box-shadow:");
  assertStringIncludes(flick, "#f8d878");
  const shadowOf = (r: string) => {
    const s = r.indexOf("box-shadow:");
    return r.slice(s, r.indexOf(";", s));
  };
  assert(shadowOf(tower) !== shadowOf(flick), "frame B lights a different window set");
  assertEquals(
    shadowOf(tower).length,
    shadowOf(flick).length,
    "flicker frames differ only in which windows are lit",
  );
  // the roofline is a flat stepped slab — the antenna/spire is gone (it read
  // as a cross on the silhouette, wrong vibe for corporate HQ)
  assertEquals(
    TOWER_MAP[0],
    ".".repeat(10) + "K".repeat(24) + ".".repeat(10),
    "the map starts at the stepped roofline, no antenna rows",
  );
  assertEquals(TOWER_MAP.length, 84, "tower is 84 game px tall without the spire");
  // …and the .bldg box shrinks with the map: the art's bottom edge lands at
  // (rows+1)·2 CSS px inside .bldg (the 1-game-px pixelArt shift), so the box
  // height must track the map or the building floats above its bottom anchor;
  // the 28-row wings (art bottom = top + 58) must land on the same ground line
  const bldgH = (TOWER_MAP.length + 1) * 2;
  assertStringIncludes(rule(".bldg"), `height: ${bldgH}px`);
  assertStringIncludes(html, `.wing { top: ${bldgH - 58}px;`);
  // the sign: legible plaque text flush on the building, GB textbox styling
  assertStringIncludes(html, `class="csign"`);
  assertStringIncludes(html, "THE COMPANY, INC.");
  const sign = rule(".csign");
  assertStringIncludes(sign, "border: 2px solid #101010");
  assertStringIncludes(sign, "monospace");
  // the fence row is gone — a corporate parking-lot lamp row stands on the
  // lawn instead, evenly spaced with a center gap for the tower entrance
  assert(!html.includes("fence"), "the fence row is fully removed");
  for (const pct of [4, 18, 32, 78, 92]) {
    assertStringIncludes(html, `<i class="lamp" style="left: ${pct}%"></i>`);
  }
  assertStringIncludes(html, `<i class="lamp lamp-flicker" style="left: 64%"></i>`);
  assertEquals((html.match(/class="lamp[ "]/g) ?? []).length, 6, "six lamps in the row");
  assert(!html.includes(`class="lamp" style="left: 5`), "no lamp collides with the entrance");
  // lamp art: outlined near-black post + warm lit head + hard light pool,
  // all build-time pixelArt box-shadows (structure on ::before, glow on ::after)
  const lamp = rule(".lamp::before");
  assertStringIncludes(lamp, "box-shadow:");
  assertStringIncludes(lamp, "#101010"); // black pixel outline
  assertStringIncludes(lamp, "#384858"); // near-black post metal
  const glow = rule(".lamp::after");
  assertStringIncludes(glow, "box-shadow:");
  assertStringIncludes(glow, "#f8d878"); // warm lit lamp pixels
  assertStringIncludes(glow, "#f8f0b0"); // the paler core
  assertStringIncludes(glow, "#7cb078"); // hard-edged light pool on the grass
  // background grove: SIX big darker trees spread unevenly across the strip
  // (not metronome-spaced like the lamps), every one fully clear of the
  // building — the two nearest HQ are calc()-anchored to the same 50% center
  // the tower uses, so they stay clear at every viewport width
  const trees: (readonly [string, (w: number) => number])[] = [
    ["2%", (w) => w * 0.02],
    ["13%", (w) => w * 0.13],
    ["calc(50% - 158px)", (w) => w / 2 - 158],
    ["calc(50% + 84px)", (w) => w / 2 + 84],
    ["71%", (w) => w * 0.71],
    ["86%", (w) => w * 0.86],
  ];
  assertEquals((html.match(/class="tree"/g) ?? []).length, trees.length, "six background trees");
  for (const [left] of trees) {
    assertStringIncludes(html, `<i class="tree" style="left: ${left}"></i>`);
  }
  // clearance proof at OBS-realistic widths: the building complex spans
  // 50% ± 70px (the 88px tower centered via margin-left -44px, wings at
  // -26px/+82px inside .bldg, 16 game px = 32px wide) and a tree box is
  // 64px wide — no tree box may intersect that span
  const treeW = TREE_MAP[0].length * 2;
  for (const w of [900, 950, 1200, 1280, 1500, 1920]) {
    for (const [left, at] of trees) {
      const x = at(w);
      assert(
        x + treeW <= w / 2 - 70 || x >= w / 2 + 70,
        `tree at ${left} clears the building at ${w}px viewport`,
      );
    }
  }
  const tree = rule(".tree::before");
  assertStringIncludes(tree, "box-shadow:");
  assertStringIncludes(tree, "#3e6a4c"); // canopy a step darker than the lawn mosses
  assertStringIncludes(tree, "#2c5038");
  assertStringIncludes(tree, "#1e3c2a"); // deep canopy underside
  assertStringIncludes(tree, "#5c3c20"); // dark trunk
  assertStringIncludes(tree, "#8f78b8"); // muted blossom pixels
  // the map really is a towering tree (lamps are 30 game px), and the CSS box
  // is exactly the map size at 2 CSS px per game px; the grove reads FURTHER
  // BACK than before: lifted 5 game px above the lamps' bottom-28px ground
  // line and shrunk a notch via a bottom-anchored scale (base stays put)
  assertEquals(TREE_MAP[0].length, 32);
  assertEquals(TREE_MAP.length, 44);
  assertStringIncludes(
    html,
    `.tree { bottom: 38px; width: ${TREE_MAP[0].length * 2}px; height: ${TREE_MAP.length * 2}px;`,
  );
  const treeRule = rule(".tree");
  assertStringIncludes(treeRule, "transform: scale(.9)");
  assertStringIncludes(treeRule, "transform-origin: 50% 100%");
  // …and the lift is computed, not just quoted: tree bottom minus the lamps'
  // actual ground line must be exactly 10 CSS px (5 game px)
  const bottomPx = (r: string) => Number((r.match(/bottom: (\d+)px/) ?? [])[1]);
  assertEquals(bottomPx(rule(".lamp")), 28, "the lamp row's ground line");
  assertEquals(bottomPx(treeRule) - bottomPx(rule(".lamp")), 10, "grove lifted 5 game px above the lamp ground line");
  // grove layering: trees paint BEHIND HQ and the lamp posts (same z-index,
  // earlier in the DOM), so canopies peek from behind the wings and can never
  // cover the sign or the door
  assert(
    html.indexOf(`class="grove"`) < html.indexOf(`class="bldg"`),
    "grove renders before (behind) the building",
  );
  assert(
    html.indexOf(`class="tree"`) < html.indexOf(`class="lamp"`),
    "trees render before (behind) the lamp posts",
  );
  // the lot paints over HQ but behind the graves
  assert(
    html.indexOf(`class="lot"`) > html.indexOf(`class="bldg"`) &&
      html.indexOf(`class="lot"`) < html.indexOf(`id="scene"`),
    "lamps render between the building and the graves",
  );
  // desaturated Lavender grass checker
  const ground = rule(".ground");
  assertStringIncludes(ground, "conic-gradient");
  assertStringIncludes(ground, "#689868");
  assertStringIncludes(ground, "#5c8a5c");
  // scattered decor: muted tufts + 2-frame blooming LAVENDER flowers
  assertStringIncludes(html, `class="tuft"`);
  assertStringIncludes(html, `class="flower"`);
  assertStringIncludes(html, "#c0a0e0", "flower petals recolored to lavender");
  assertStringIncludes(html, "@keyframes bloom");
  assertStringIncludes(html, "steps(1)", "the flower bloom snaps between frames, GB-style");
  // mist: cool lavender-gray tint, two bands behind the stones + one in front,
  // looping keyframes
  assertStringIncludes(html, "rgba(216,208,232,.8)");
  assert(!html.includes("rgba(248,248,248"), "mist is no longer plain white");
  assertStringIncludes(html, `class="fog fog-a"`);
  assertStringIncludes(html, `class="fog fog-b"`);
  assertStringIncludes(html, `class="fog fog-front"`);
  assertStringIncludes(html, "@keyframes fogA");
  assertStringIncludes(html, "@keyframes fogB");
  assertStringIncludes(html, "@keyframes fogFront");
  // the in-front band must actually stack above the stones
  assert(
    html.indexOf(`<div class="fog fog-front">`) > html.indexOf(`id="scene"`),
    "fog-front renders after the scene",
  );
  // the tower sits behind the graves in the DOM (scenery, not scene)
  assert(
    html.indexOf(`class="bldg"`) < html.indexOf(`id="scene"`),
    "building renders before (behind) the graves",
  );
});

Deno.test("graveyard flicker: buzzing tower windows are pixel-aligned; one lamp buzzes out of sync", () => {
  const html = renderGraveyardPage(graveyardView([]), { tooltips: false, max: 0 });
  // map proof: every buzz cell covers an always-dark `w` window (w is dark in
  // BOTH officeShift frames), so the fast buzz never fights the slow shift
  assert(FLICKER_WINDOWS.length >= 2 && FLICKER_WINDOWS.length <= 3, "2-3 bad tubes");
  for (const { floor, win } of FLICKER_WINDOWS) {
    for (let dy = 0; dy < 2; dy++) {
      const row = TOWER_MAP[9 + 4 * floor + dy]; // 9 rows of roof/slab/wall above the top office floor
      for (let dx = 0; dx < 3; dx++) {
        assertEquals(row[TOWER_WIN_X[win] + dx], "w", `floor ${floor} win ${win} must cover a dark window cell`);
      }
    }
  }
  // css proof: each overlay <i> sits at exactly the map-cell position — map
  // pixel (x, y) renders at ((x+1)·2, (y+1)·2) CSS px inside .bldg (the art is
  // shifted one game px; see pixelArt) — and spans one 3×2-game-px window
  assertEquals(towerWindowCell(2, 1), { left: 26, top: 36, width: 6, height: 4 });
  const classes = ["wf-a", "wf-b", "wf-c"];
  for (let i = 0; i < FLICKER_WINDOWS.length; i++) {
    const { floor, win } = FLICKER_WINDOWS[i];
    const c = towerWindowCell(floor, win);
    assertEquals(c.left, (TOWER_WIN_X[win] + 1) * 2, "left matches the map column math");
    assertEquals(c.top, (9 + 4 * floor + 1) * 2, "top matches the map row math");
    assertStringIncludes(html, `<i class="wflick ${classes[i]}"></i>`);
    assertStringIncludes(html, `.${classes[i]} { left: ${c.left}px; top: ${c.top}px; animation: tubeBuzz `);
  }
  assertStringIncludes(html, `.bldg .wflick { width: 6px; height: 4px; background: #f8d878; }`);
  // the buzz itself: fast irregular steps(1) loops with UNEVEN keyframe gaps
  // snapping opacity 1/0 (never a fade) — a dying tube, nothing like the slow
  // 11s officeShift; per-cell durations/phases differ so tubes never sync
  const keyframeLine = (name: string) => {
    const i = html.indexOf(`@keyframes ${name} { `);
    assert(i >= 0, name + " keyframes exist");
    return html.slice(i, html.indexOf("\n", i));
  };
  for (const name of ["tubeBuzz", "lampBuzz"]) {
    const line = keyframeLine(name);
    assertStringIncludes(line, "opacity: 0");
    assertStringIncludes(line, "opacity: 1");
    const stops = [...line.matchAll(/ (\d+)% \{ opacity: [01]; \}/g)].map((m) => Number(m[1]));
    const mids = stops.filter((s) => s > 0 && s < 100).sort((a, b) => a - b);
    assert(mids.length >= 6, name + " stutters several times per loop");
    const gaps = mids.slice(1).map((s, i) => s - mids[i]);
    assert(new Set(gaps).size >= 3, name + " keyframe gaps are uneven, not a metronome");
  }
  assertStringIncludes(html, "animation: tubeBuzz 6.3s steps(1) infinite;");
  assertStringIncludes(html, "animation: tubeBuzz 8.1s steps(1) infinite 1.5s;");
  assertStringIncludes(html, "animation: tubeBuzz 7.1s steps(1) infinite 2.7s;");
  // exactly one lamp in the row flickers, on its own period/phase
  assertStringIncludes(html, `class="lamp lamp-flicker"`);
  assertStringIncludes(html, ".lamp-flicker::after { animation: lampBuzz 8.5s steps(1) infinite .4s; }");
});

Deno.test("graveyard markers are pixelArt box-shadows; tooltip is a GB textbox", () => {
  // pixelArt: pixel map → box-shadow, one game px shifted (outer shadows are
  // invisible over their own base box), "." transparent, colors by char
  assertEquals(
    pixelArt(["K.", ".1"], { K: "#101010", "1": "#f8f8f8" }, 2),
    "2px 2px 0 #101010, 4px 4px 0 #f8f8f8",
  );
  const html = renderGraveyardPage(graveyardView([]), { tooltips: false, max: 0 });
  const rule = (sel: string) => {
    const i = html.indexOf(sel + " { ");
    assert(i >= 0, sel + " rule exists");
    return html.slice(i, html.indexOf("}", i));
  };
  // all three markers draw from generated box-shadow pixel art in the GB
  // palette (4-shade shading + the #101010 outline baked into the maps)
  const stone = rule(".stone::before");
  assertStringIncludes(stone, "box-shadow:");
  assertStringIncludes(stone, "#f8f8f8"); // headstone highlight gray
  assertStringIncludes(stone, "#484848"); // 4th shade: plaque recess/base shadow
  assertStringIncludes(stone, "#101010"); // black pixel outline
  const stake = rule(".stone.stake::before");
  assertStringIncludes(stake, "box-shadow:");
  assertStringIncludes(stake, "#b87838"); // wood
  assertStringIncludes(stake, "#5c3c20"); // third wood tone (under-plank shadow)
  const player = rule(".stone.player::before");
  assertStringIncludes(player, "box-shadow:");
  assertStringIncludes(player, "#484848"); // dark stone cross
  assertStringIncludes(player, "#303030"); // deep slab shadow
  // map ↔ CSS lockstep: each marker's box is exactly its map size at 2 CSS px
  // per game px (the ::before carrier compensates for the 1-game-px art shift)
  assertEquals([STONE_MAP[0].length, STONE_MAP.length], [20, 24]);
  assertEquals([STAKE_MAP[0].length, STAKE_MAP.length], [18, 22]);
  assertEquals([PLAYER_MAP[0].length, PLAYER_MAP.length], [14, 26]);
  assertStringIncludes(
    html,
    `.stone { position: relative; width: ${STONE_MAP[0].length * 2}px; height: ${STONE_MAP.length * 2}px;`,
  );
  assertStringIncludes(
    html,
    `.stone.stake { width: ${STAKE_MAP[0].length * 2}px; height: ${STAKE_MAP.length * 2}px; }`,
  );
  assertStringIncludes(
    html,
    `.stone.player { width: ${PLAYER_MAP[0].length * 2}px; height: ${PLAYER_MAP.length * 2}px; }`,
  );
  // the sprite rides HIGH on both sprite-bearing markers, and its content box
  // matches its housing EXACTLY — sprites are TRIMMED of their transparent
  // margins at package-build time, so the box below IS the visible art.
  // slab: the map carves the inset portrait plaque at rows 3-15 × cols 3-16
  // ("4" top/left shadow, "3" field, "1" light catch on the right edge, an
  // all-"1" catch row below)
  assert(STONE_MAP[3].includes("44444444444444"), "plaque top-shadow row right under the slab crown");
  for (let r = 4; r <= 15; r++) {
    assertEquals(STONE_MAP[r], ".K1433333333333312K.", `recessed plaque field row ${r} (the sprite's seat)`);
  }
  assert(!STONE_MAP[16].includes("3"), "the recess ends at row 15 — the light-catch face row sits below");
  // recess box in CSS px (map pixel (x,y) → (2x, 2y) inside .stone): the
  // .gsprite box must cover the whole dark plaque, so the trimmed art fills
  // it edge to edge (contain letterboxes extreme ratios inside the recess)
  const fieldRow = STONE_MAP[8];
  const recessL = fieldRow.indexOf("4") * 2; // left-shadow col
  const recessR = (fieldRow.lastIndexOf("1") + 1) * 2; // right light-catch col, inclusive
  const recessT = 3 * 2; // the all-"4" top-shadow row
  const recessB = (15 + 1) * 2; // last field row, inclusive
  const recessW = recessR - recessL;
  const recessH = recessB - recessT;
  assertEquals([recessL, recessT, recessW, recessH], [6, 6, 28, 26], "the plaque recess box");
  assertStringIncludes(
    html,
    `.gsprite { position: relative; image-rendering: pixelated; width: ${recessW}px; height: ${recessH}px; object-fit: contain; margin-top: ${recessT}px; }`,
  );
  // flex centering must drop the box exactly onto the recess, inside the K outline
  const stoneW = STONE_MAP[0].length * 2;
  assertEquals((stoneW - recessW) / 2, recessL, "centered sprite box lands on the recess left edge");
  const inX0 = (fieldRow.indexOf("K") + 1) * 2; // first interior CSS x
  const inX1 = fieldRow.lastIndexOf("K") * 2; // right outline's left edge
  assert(recessL >= inX0 && recessL + recessW <= inX1, "the sprite box stays inside the slab outline");
  // stake: the plank outline spans rows 1-10 × cols 1-15 → the .plank box;
  // the sprite box fills the plank FACE (one game px inside the outline)
  assertEquals(STAKE_MAP[10], "..KKKKKKKKKKKKKK..", "plank bottom outline row");
  const plankL = STAKE_MAP[1].indexOf("K") * 2;
  const plankR = (STAKE_MAP[1].lastIndexOf("K") + 1) * 2;
  const plankT = 1 * 2; // top outline row
  const plankB = (10 + 1) * 2; // bottom outline row, inclusive
  const plankW = plankR - plankL;
  const plankH = plankB - plankT;
  assertEquals([plankL, plankT, plankW, plankH], [2, 2, 30, 20], "the plank sign box");
  assertStringIncludes(
    html,
    `.plank { position: absolute; left: ${plankL}px; top: ${plankT}px; width: ${plankW}px; height: ${plankH}px;`,
  );
  assertStringIncludes(html, `.stake .gsprite { width: ${plankW - 4}px; height: ${plankH - 4}px; margin: 0; }`);
  // the tooltip is a mini Pokémon textbox: white, thick black double frame
  // (border + ring), hard corners, black monospace text
  const tip = rule(".tip");
  assertStringIncludes(tip, "background: #f8f8f8");
  assertStringIncludes(tip, "border: 2px solid #101010");
  assertStringIncludes(tip, "box-shadow: 0 0 0 2px #f8f8f8, 0 0 0 4px #101010");
  assertStringIncludes(tip, "monospace");
  assertStringIncludes(tip, "color: #101010");
});

Deno.test("graveyard SSE path builds the same three variants as the server (parity)", () => {
  // The page is half server-rendered (graveHtml) and half SSE-appended
  // (addGrave); both halves must produce the same classes and nesting.
  const html = renderGraveyardPage(graveyardView([]), { tooltips: false, max: 0 });
  assertStringIncludes(html, "el('div', 'stone player')");
  assertStringIncludes(html, "el('div', 'pcross')");
  assertStringIncludes(html, "m.cause === 'sacrifice'");
  assertStringIncludes(html, "el('div', 'stone stake')");
  assertStringIncludes(html, "el('div', 'plank')");
  assertStringIncludes(html, "el('div', 'stone')");
  assertStringIncludes(html, "el('div', 'mound')");
  // tip parity: same two-line bubble structure as the server tip branch
  assertStringIncludes(html, "el('b', 'tip-n')");
  assertStringIncludes(html, "el('span', 'tip-c')");
});

Deno.test("graveyard: ?tooltips=1 = name + cause bubbles; hostile nicknames escaped", () => {
  const evil = `<script>alert("x")</script>`;
  const view = graveyardView([mon(evil, "eevee", 133, 1111)]);

  const off = renderGraveyardPage(view, { tooltips: false, max: 0 });
  assert(!off.includes(`class="tip"`), "no bubbles without ?tooltips=1");

  const on = renderGraveyardPage(view, { tooltips: true, max: 0 });
  assertStringIncludes(on, `class="tip"`);
  assert(!on.includes(evil), "raw nickname markup must never appear");
  assert(!on.includes("<script>alert"), "no unescaped script tag anywhere");
  assertStringIncludes(on, `<b class="tip-n">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</b>`);
  assertStringIncludes(on, `<span class="tip-c">fainted</span>`); // the cause line
});

Deno.test("graveyard bubbles carry the cause of death for every variant", () => {
  const view = graveyardView([
    mon("Vee", "eevee", 133, 1111),
    { kind: "pokemon", name: "Marty", species: "magikarp", dex: 129, level: 7, cause: "sacrifice", attempt: 1, ts: 1500 },
    { kind: "pokemon", name: "Dupe", species: "rattata", dex: 19, level: 3, cause: "duplicate_release", attempt: 1, ts: 1600 },
    { kind: "player", name: "Cole", species: "", dex: 0, level: 0, cause: "forfeit", attempt: 1, ts: 2222 },
    { kind: "player", name: "", species: "", dex: 0, level: 0, cause: "faint", attempt: 1, ts: 3333 },
  ]);
  const on = renderGraveyardPage(view, { tooltips: true, max: 0 });
  assertStringIncludes(on, `<b class="tip-n">Vee</b><span class="tip-c">fainted</span>`);
  assertStringIncludes(on, `<b class="tip-n">Marty</b><span class="tip-c">sacrificed</span>`);
  assertStringIncludes(on, `<b class="tip-n">Dupe</b><span class="tip-c">released</span>`);
  assertStringIncludes(on, `<b class="tip-n">Cole</b><span class="tip-c">whiteout · forfeit</span>`);
  assertStringIncludes(on, `<b class="tip-n">Trainer</b><span class="tip-c">whiteout</span>`);
});

Deno.test("graveyard bubbles show who/what KO'd a Pokémon and how the trainer died", () => {
  const view = graveyardView([
    // wild KO
    { kind: "pokemon", name: "Vee", species: "eevee", dex: 133, level: 11, cause: "faint", attempt: 1, ts: 1111, killer: { by: "wild", name: "Zubat", species: "cobblemon:zubat", dex: 41, trainer: "" } },
    // trainer's mon KO
    { kind: "pokemon", name: "Sparky", species: "pikachu", dex: 25, level: 14, cause: "faint", attempt: 1, ts: 1222, killer: { by: "trainer", name: "Batty", trainer: "Rocket Grunt", species: "cobblemon:zubat", dex: 41 } },
    // natural death: full message shown
    { kind: "player", name: "Cole", species: "", dex: 0, level: 0, cause: "mob", attempt: 1, ts: 2000, killedBy: "Zombie", detail: "Cole was slain by Zombie" },
    // environmental death, no message → humanized cause
    { kind: "player", name: "Cole", species: "", dex: 0, level: 0, cause: "lava", attempt: 1, ts: 2100 },
  ]);
  const on = renderGraveyardPage(view, { tooltips: true, max: 0 });
  assertStringIncludes(on, `<b class="tip-n">Vee</b><span class="tip-c">fainted · by Zubat</span>`);
  assertStringIncludes(on, `<b class="tip-n">Sparky</b><span class="tip-c">fainted · by Rocket Grunt&#39;s Batty</span>`);
  assertStringIncludes(on, `<b class="tip-n">Cole</b><span class="tip-c">Cole was slain by Zombie</span>`);
  assertStringIncludes(on, `<span class="tip-c">burned in lava</span>`);
});

Deno.test("graveyard: a hostile death message is escaped in the bubble", () => {
  const evil = `<script>alert("x")</script>`;
  const view = graveyardView([
    { kind: "player", name: "Cole", species: "", dex: 0, level: 0, cause: "mob", attempt: 1, ts: 2000, detail: evil },
  ]);
  const on = renderGraveyardPage(view, { tooltips: true, max: 0 });
  assert(!on.includes(evil), "raw death-message markup must never appear");
  assert(!on.includes("<script>alert"), "no unescaped script tag anywhere");
  assertStringIncludes(on, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

Deno.test("toasts: loss shows the killer; a natural death gets its own YOU DIED toast", () => {
  assertStringIncludes(TOASTS_HTML, ".toast.death");
  assertStringIncludes(TOASTS_HTML, "'YOU DIED'");
  assertStringIncludes(TOASTS_HTML, "ev.event === 'player_death'");
  assertStringIncludes(TOASTS_HTML, "if (ev.killer) lost += ' · by ' + killerLabel(ev.killer);");
});

Deno.test("graveyard tooltips cycle one grave at a time (hidden at rest, spotlight class)", () => {
  const on = renderGraveyardPage(
    graveyardView([mon("Vee", "eevee", 133, 1111)]),
    { tooltips: true, max: 0 },
  );
  // Bubbles ship hidden; only the cycler's tipshow class reveals one at a time.
  assertStringIncludes(on, "opacity: 0", ".tip must be hidden at rest");
  assertStringIncludes(on, ".gpos.tipshow .tip { opacity: 1; }");
  assertStringIncludes(on, "setInterval(cycleTip, 5000)");
  assertStringIncludes(on, "classList.remove('tipshow')");
  assert(
    on.indexOf("cycleTip();") < on.indexOf("setInterval(cycleTip"),
    "first bubble shows immediately, not after the first interval",
  );
});

Deno.test("graveyard placement is deterministic (same input → same rendered offsets)", () => {
  const m = mon("Vee", "eevee", 133, 1_700_000_123_456);
  const view = graveyardView([m]);
  const a = renderGraveyardPage(view, { tooltips: false, max: 0 });
  const b = renderGraveyardPage(view, { tooltips: false, max: 0 });
  assertEquals(a, b, "same input must render byte-identical HTML");

  const p = gravePlacement(m.ts);
  assertEquals(gravePlacement(m.ts), p, "placement is a pure function of ts");
  assert(p.row === 0 || p.row === 1 || p.row === 2);
  assert(p.leftPct >= 3 && p.leftPct <= 89, "scatter stays inside the strip");
  assert(p.dx >= -12 && p.dx <= 12, "x jitter stays within ±12px");
  assert(p.rot >= -3 && p.rot <= 3, "rotation stays within ±3deg");
  assert(p.scale >= 0.75 && p.scale <= 1, "back rows scale ~0.75-1");
  // the computed offsets are exactly what the page renders
  assertStringIncludes(a, `style="left: ${p.leftPct}%"`);
  assertStringIncludes(a, `translate(${p.dx}px, ${p.dy}px) rotate(${p.rot}deg) scale(${p.scale})`);
  assertStringIncludes(a, ["g-back", "g-mid", "g-front"][p.row]);
  // different ts values actually scatter (not one fixed spot)
  const seen = new Set([1000, 2000, 3000, 44444, 555555, 6666666, 77777777]
    .map((t) => JSON.stringify(gravePlacement(t))));
  assert(seen.size > 1, "placement must vary with ts");
});

Deno.test("graveyard client query parsing mirrors the router (bad values ignored)", () => {
  const html = renderGraveyardPage(graveyardView([]), { tooltips: false, max: 0 });
  // Strict equality for tooltips and the ANCHORED digit test for max — the same
  // checks router.ts applies server-side, so e.g. ?max=12abc (rejected by the
  // server, which then renders ALL stones) can never make the client half of
  // the page trim SSE-appended stones to a number the server ignored.
  assertStringIncludes(html, "qs.get('tooltips') === '1'");
  assertStringIncludes(html, "/^[0-9]+$/.test(maxRaw)");
  assert(!html.includes("location.search.match"), "no lax prefix-match query parsing");
});

Deno.test("graveyard: ?max=N keeps only the most recent N stones", () => {
  const view = graveyardView([1, 2, 3, 4, 5].map((i) => mon(`M${i}`, `mon${i}`, i, i * 1000)));
  const html = renderGraveyardPage(view, { tooltips: false, max: 2 });
  assert(!html.includes("/sprites/mon1.png"), "oldest stones drop out under ?max");
  assert(!html.includes("/sprites/mon3.png"));
  assertStringIncludes(html, "/sprites/mon4.png?dex=4");
  assertStringIncludes(html, "/sprites/mon5.png?dex=5");
});

Deno.test("sanitizeSlug maps species ids to the [a-z0-9-] sprite charset", () => {
  assertEquals(sanitizeSlug("Pikachu"), "pikachu");
  assertEquals(sanitizeSlug("cobblemon:pikachu"), "pikachu");
  assertEquals(sanitizeSlug("Mr. Mime"), "mr-mime");
  assertEquals(sanitizeSlug("mr_mime"), "mr-mime");
  assertEquals(sanitizeSlug("Farfetch'd"), "farfetchd");
  assertEquals(sanitizeSlug("NIDORAN♀"), "nidoran");
  assertEquals(sanitizeSlug("porygon-z"), "porygon-z");
  assertEquals(sanitizeSlug(""), "");
});

Deno.test("sanitizeSlug defuses path traversal", () => {
  assertEquals(sanitizeSlug("../../../etc/passwd"), "etcpasswd");
  assertEquals(sanitizeSlug("..%2f..%2fsecret"), "2f2fsecret");
  assertEquals(sanitizeSlug("/absolute/path"), "absolutepath");
  assert(!sanitizeSlug("a/../b").includes("/"));
  assert(!sanitizeSlug("a/../b").includes("."));
});

Deno.test("sprite resolve: direct slug, loose (dash-less) match, dex fallback, clean miss", () => {
  const store = SpriteStore.forTest(
    ["pikachu", "mr-mime", "porygon-z"],
    new Map([[25, "pikachu"], [122, "mr-mime"], [999, "not-installed"]]),
  );
  assertEquals(store.resolve("pikachu"), "pikachu.png");
  assertEquals(store.resolve("cobblemon:Pikachu"), "pikachu.png");
  assertEquals(store.resolve("mrmime"), "mr-mime.png", "dash-less Cobblemon id hits the loose index");
  assertEquals(store.resolve("unknownmon", 122), "mr-mime.png", "dex number is the fallback key");
  assertEquals(store.resolve("unknownmon", 999), null, "dex mapped to a missing file still misses");
  assertEquals(store.resolve("unknownmon"), null);
  assertEquals(store.resolve("unknownmon", 0), null);
});

Deno.test("sprite serve 404s cleanly on traversal and misses", async () => {
  // dir-less store: everything 404s, never throws
  const disabled = new SpriteStore("");
  const r1 = await disabled.serve("pikachu.png", null);
  assertEquals(r1.status, 404);
  await r1.body?.cancel();

  // real dir with one sprite: traversal + misses 404, the real file serves
  const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-sprites" });
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await Deno.writeFile(`${dir}/pikachu.png`, png);
    await Deno.writeTextFile(`${dir}/secret.txt`, "nope");
    const store = new SpriteStore(dir);
    await store.init();

    const ok = await store.serve("pikachu.png", null);
    assertEquals(ok.status, 200);
    assertEquals(ok.headers.get("content-type"), "image/png");
    assertEquals(new Uint8Array(await ok.arrayBuffer()), png);

    // traversal collapses to the sanitized whitelisted slug — it can only ever
    // reach files init() indexed inside the sprite dir, never escape it
    const collapsed = await store.serve("..%2Fpikachu.png", null);
    assertEquals(collapsed.status, 200);
    assertEquals(new Uint8Array(await collapsed.arrayBuffer()), png);

    for (const evil of ["secret.txt", "secret.txt.png", "%2e%2e%2fsecret.txt.png", "%2e%2e%2fsecret.png", "missing.png", "%zz.png"]) {
      const res = await store.serve(evil, null);
      assertEquals(res.status, 404, `must 404: ${evil}`);
      await res.body?.cancel();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- client pages EXECUTED against a tiny fake DOM ----
// Just enough DOM for the page JS: createElement, textContent (the ONLY way
// text enters — there is no innerHTML), children, class lists, and captured
// EventSource listeners + timers, so a test can dispatch SSE `game` events.

class FakeEl {
  tagName: string;
  className = "";
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  style: Record<string, string> = {};
  src = "";
  alt = "";
  #text = "";

  constructor(tag: string) {
    this.tagName = tag;
  }

  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join("");
  }

  set textContent(v: string) {
    this.#text = String(v);
    for (const c of this.children) c.parent = null;
    this.children = [];
  }

  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }

  appendChild(c: FakeEl): FakeEl {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }

  removeChild(c: FakeEl): FakeEl {
    this.children = this.children.filter((x) => x !== c);
    c.parent = null;
    return c;
  }

  remove(): void {
    if (this.parent) this.parent.removeChild(this);
  }

  addEventListener(): void {}

  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    const set = (cs: string[]) => {
      this.className = cs.join(" ");
    };
    return {
      add: (...cs: string[]) => set([...new Set([...list(), ...cs])]),
      remove: (...cs: string[]) => set(list().filter((c) => !cs.includes(c))),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !list().includes(c);
        set(on ? [...new Set([...list(), c])] : list().filter((x) => x !== c));
      },
      contains: (c: string) => list().includes(c),
    };
  }
}

function runPage(html: string) {
  const script = html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  const stack = new FakeEl("div");
  const listeners: Record<string, (e: { data: string }) => void> = {};
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const document = { getElementById: () => stack, createElement: (tag: string) => new FakeEl(tag), body: new FakeEl("body") };
  class EventSource {
    constructor(_url: string) {}
    addEventListener(name: string, fn: (e: { data: string }) => void) {
      listeners[name] = fn;
    }
  }
  const setTimeoutFake = (fn: () => void) => {
    timers.set(nextTimer, fn);
    return nextTimer++;
  };
  const clearTimeoutFake = (id: number) => {
    timers.delete(id);
  };
  new Function("document", "EventSource", "setTimeout", "clearTimeout", script)(
    document,
    EventSource,
    setTimeoutFake,
    clearTimeoutFake,
  );
  return {
    stack,
    game(ev: Record<string, unknown>) {
      listeners.game({ data: JSON.stringify(ev) });
    },
    // fire every pending timer (and whatever those schedule) until none remain
    drainTimers() {
      while (timers.size) {
        const fns = [...timers.values()];
        timers.clear();
        for (const fn of fns) fn();
      }
    },
  };
}

Deno.test("redeems page: a redeem files a PENDING memo built only from textContent", () => {
  const page = runPage(REDEEMS_HTML);
  const evil = `<img src=x onerror=alert(1)>`;
  page.game({ event: "redeem", ts: 1, id: "r1", viewer: evil, reward: "Budget Cuts", effect: "potion", cost: 750 });
  assertEquals(page.stack.children.length, 1);
  const memo = page.stack.children[0];
  assert(memo.classList.contains("memo") && memo.classList.contains("pending"));
  const text = memo.textContent;
  assertStringIncludes(text, "The Company, Inc.");
  assertStringIncludes(text, `MEMO — ${evil} filed: Budget Cuts`, "the hostile name is inert TEXT");
  assertStringIncludes(text, "FORM POTION · 750 pts");
  assertStringIncludes(text, "PENDING REVIEW");
});

Deno.test("redeems page: effect_result stamps the SAME memo APPROVED / DENIED + REFUNDED", () => {
  const page = runPage(REDEEMS_HTML);
  page.game({ event: "redeem", ts: 1, id: "ok1", viewer: "Alice", reward: "Budget Cuts", effect: "potion", cost: 750 });
  page.game({ event: "redeem", ts: 2, id: "no1", viewer: "Bob", reward: "Butterfingers", effect: "drop_held_item" });
  page.game({ event: "redeem", ts: 3, id: "arm1", viewer: "Cy", reward: "Mandatory Meeting", effect: "forfeit_turns" });

  page.game({ event: "effect_result", ts: 4, id: "ok1", status: "applied", reason: "", detail: "Slowness II for 45s" });
  page.game({ event: "effect_result", ts: 5, id: "no1", status: "rejected", reason: "empty_hand", detail: "" });
  page.game({ event: "effect_result", ts: 6, id: "arm1", status: "armed", reason: "", detail: "" });
  assertEquals(page.stack.children.length, 3, "results re-stamp existing memos, never add cards");

  const [ok, no, arm] = page.stack.children;
  assert(ok.classList.contains("approved") && !ok.classList.contains("pending"));
  assertStringIncludes(ok.textContent, "APPROVED");
  assertStringIncludes(ok.textContent, "Slowness II for 45s");
  assert(!ok.textContent.includes("REFUNDED"));

  assert(no.classList.contains("denied"));
  assertStringIncludes(no.textContent, "DENIEDREFUNDED"); // two stamp lines
  assertStringIncludes(no.textContent, "Nothing in hand to confiscate.");

  assert(arm.classList.contains("approved"), "armed is APPROVED (Twitch FULFILLED)");
  assertStringIncludes(arm.textContent, "Scheduled at the next opportunity.");
});

Deno.test("redeems page: a cancel reads by its reason — fulfilled_externally is CLOSED + NO ACTION, never REFUNDED", () => {
  const page = runPage(REDEEMS_HTML);
  const cases: [string, string, string][] = [
    ["ext", "fulfilled_externally", "canceled"],
    ["ext2", "fulfilled_externally", "rejected"], // cancel-requested, then the mod stood down
    ["ref", "refunded", "canceled"],
    ["man", "manual", "canceled"],
    ["tmo", "timeout", "expired"],
  ];
  for (const [id] of cases) {
    page.game({ event: "redeem", ts: 1, id, viewer: "Eve", reward: "Magikarp Mandate", effect: "magikarp_mandate" });
  }
  for (const [id, reason, status] of cases) {
    page.game({ event: "effect_result", ts: 2, id, status, reason, detail: "" });
  }
  const [ext, ext2, ref, man, tmo] = page.stack.children;
  for (const c of [ext, ext2]) {
    assert(c.classList.contains("closed") && !c.classList.contains("denied") && !c.classList.contains("pending"));
    assertStringIncludes(c.textContent, "CLOSEDNO ACTION"); // two stamp lines
    assertStringIncludes(c.textContent, "Closed by management. No action taken.");
    assert(!c.textContent.includes("REFUNDED"), "the points were SPENT — never claim a refund");
    assert(!c.textContent.includes("DENIED"));
  }
  for (const c of [ref, man, tmo]) {
    assert(c.classList.contains("denied"));
    assertStringIncludes(c.textContent, "DENIEDREFUNDED");
  }
  assertStringIncludes(ref.textContent, "Request withdrawn.");
  assertStringIncludes(man.textContent, "Withdrawn by management.");
  assertStringIncludes(tmo.textContent, "Request died in committee.");
  // one that ran despite the cancel is APPROVED, whatever the reason
  page.game({ event: "effect_result", ts: 3, id: "ran", status: "applied", reason: "fulfilled_externally", detail: "" });
  assert(page.stack.children.at(-1)!.classList.contains("approved"));
});

Deno.test("redeems page: a result with no memo on screen files a pre-stamped one; stack capped; memos retire", () => {
  const page = runPage(REDEEMS_HTML);
  for (const status of ["expired", "canceled"]) {
    page.game({
      event: "effect_result",
      ts: 1,
      id: `late-${status}`,
      viewer: "Dana",
      reward: "Lights Out",
      effect: "potion",
      status,
      reason: status === "expired" ? "timeout" : "canceled",
      detail: "",
    });
  }
  assertEquals(page.stack.children.length, 2);
  assert(page.stack.children[0].classList.contains("denied"));
  assertStringIncludes(page.stack.children[0].textContent, "Request died in committee.");
  assertStringIncludes(page.stack.children[1].textContent, "Request withdrawn.");
  assertStringIncludes(page.stack.children[1].textContent, "REFUNDED");

  // a burst never grows past 5 memos (and never touches /overlay/toasts at all)
  for (let i = 0; i < 12; i++) {
    page.game({ event: "redeem", ts: 10 + i, id: `b${i}`, viewer: "V", reward: "Hop To It", effect: "force_jump" });
  }
  assertEquals(page.stack.children.length, 5);
  assertStringIncludes(page.stack.children[4].textContent, "Hop To It");

  // non-memo game events are ignored
  page.game({ event: "pokemon_lost", ts: 99, cause: "faint", pokemon: { species: "eevee", name: "Vee" } });
  assertEquals(page.stack.children.length, 5);

  page.drainTimers();
  assertEquals(page.stack.children.length, 0, "every memo leaves after its timer");
});

Deno.test("toasts page ignores the redeem / effect_result game events (they belong to /overlay/redeems)", () => {
  const page = runPage(TOASTS_HTML);
  page.game({ event: "redeem", ts: 1, id: "r1", viewer: "Alice", reward: "Budget Cuts", effect: "potion" });
  page.game({ event: "effect_result", ts: 2, id: "r1", status: "applied", reason: "", detail: "" });
  assertEquals(page.stack.children.length, 0, "no toast for effect events — loss/death toasts are never evicted by them");
  // (sanity: the harness does drive the real toast code)
  page.game({ event: "capture", ts: 3, attempt: 1, pokemon: { species: "zubat", dex: 41, name: "Batty", level: 4 } });
  assertEquals(page.stack.children.length, 1);
  assertStringIncludes(page.stack.children[0].textContent, "Caught Batty!");
});

Deno.test("status page: the effects section escapes every viewer/mod-controlled string", () => {
  const evil = `<script>alert("fx")</script>`;
  const html = renderStatusPage(hostileView(), {
    events: [],
    spriteCount: 0,
    tokenConfigured: false,
    staleAfterSec: 15,
    effects: {
      now: 100_000,
      health: { ok: true, enabled: true, accepting: true, lastPollAgoMs: 1500, ready: true, open: 1, pending: 0 },
      records: [{
        id: "abcdef12-0000-4000-8000-000000000000",
        effect: "potion",
        params: {},
        viewer: evil,
        viewerLogin: evil,
        reward: evil,
        cost: 750,
        simulated: true,
        createdAt: 40_000,
        expiresAt: 700_000,
        status: "rejected",
        deliveries: 2,
        reason: evil,
        detail: evil,
        updatedAt: 90_000,
        cancelRequested: true,
        cancelReason: "fulfilled_externally",
      }],
      modVersion: evil,
      tokenConfigured: false,
    },
  });
  assert(!html.includes(`<script>alert("fx")`), "no raw effect string reaches the page");
  assertStringIncludes(html, "&lt;script&gt;alert(&quot;fx&quot;)&lt;/script&gt;");
  assertStringIncludes(html, "<h2>channel-point effects</h2>");
  assertStringIncludes(html, `<td title="abcdef12-0000-4000-8000-000000000000">abcdef12</td>`);
  assertStringIncludes(html, "rejected (cancel requested) [sim]");
  assertStringIncludes(html, " · cancel: fulfilled_externally — ", "the cancel reason is shown next to the mod's");
  assertStringIncludes(html, "<td>2</td><td>60s</td>", "deliveries + age");
  assertStringIncludes(html, "ACCEPTING");
  assertStringIncludes(html, "loopback only");
});
