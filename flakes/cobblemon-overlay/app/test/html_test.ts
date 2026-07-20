// HTML/XSS + sprite-mapping tests: escapeHtml, the server-rendered status and
// graveyard pages, the client pages' safety conventions, and the sprite slug
// sanitizer/fallback.

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
  for (const html of [PARTY_HTML, CEMETERY_HTML, BADGES_HTML, TOASTS_HTML]) {
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
  // background grove: three BIG darker trees as set dressing — two tucked in
  // behind the building's flanks (px-anchored to the tower), one on the lawn
  assertEquals((html.match(/class="tree"/g) ?? []).length, 3, "three background trees");
  assertStringIncludes(html, `<i class="tree" style="left: calc(50% - 100px)"></i>`);
  assertStringIncludes(html, `<i class="tree" style="left: calc(50% + 36px)"></i>`);
  assertStringIncludes(html, `<i class="tree" style="left: 76%"></i>`);
  const tree = rule(".tree::before");
  assertStringIncludes(tree, "box-shadow:");
  assertStringIncludes(tree, "#3e6a4c"); // canopy a step darker than the lawn mosses
  assertStringIncludes(tree, "#2c5038");
  assertStringIncludes(tree, "#1e3c2a"); // deep canopy underside
  assertStringIncludes(tree, "#5c3c20"); // dark trunk
  assertStringIncludes(tree, "#8f78b8"); // muted blossom pixels
  // the map really is a towering tree (lamps are 30 game px), and the CSS box
  // is exactly the map size at 2 CSS px per game px
  assertEquals(TREE_MAP[0].length, 32);
  assertEquals(TREE_MAP.length, 44);
  assertStringIncludes(
    html,
    `.tree { bottom: 34px; width: ${TREE_MAP[0].length * 2}px; height: ${TREE_MAP.length * 2}px; }`,
  );
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
  assertStringIncludes(html, "animation: tubeBuzz 2.9s steps(1) infinite;");
  assertStringIncludes(html, "animation: tubeBuzz 3.7s steps(1) infinite .7s;");
  assertStringIncludes(html, "animation: tubeBuzz 3.3s steps(1) infinite 1.3s;");
  // exactly one lamp in the row flickers, on its own period/phase
  assertStringIncludes(html, `class="lamp lamp-flicker"`);
  assertStringIncludes(html, ".lamp-flicker::after { animation: lampBuzz 3.9s steps(1) infinite .2s; }");
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
  assertEquals([STONE_MAP[0].length, STONE_MAP.length], [18, 20]);
  assertEquals([STAKE_MAP[0].length, STAKE_MAP.length], [16, 20]);
  assertEquals([PLAYER_MAP[0].length, PLAYER_MAP.length], [14, 24]);
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
  // the sprite rides HIGH on both sprite-bearing markers: on the slab it sits
  // on the inset portrait plaque the map carves at rows 4-12 (y 8..26 CSS px),
  // and on the stake it sits on the plank nailed at rows 1-8 (y 2..18) — never
  // overflowing the marker outline
  assert(STONE_MAP[4].includes("4444444444"), "plaque top-shadow row high on the slab face");
  assert(STONE_MAP[8].includes("433333333"), "recessed plaque field where the sprite sits");
  assertStringIncludes(html, ".gsprite { position: relative; image-rendering: pixelated; height: 18px; margin-top: 8px; }");
  assertStringIncludes(html, ".plank { position: absolute; left: 2px; top: 2px; width: 26px; height: 16px;");
  assertStringIncludes(html, ".stake .gsprite { height: 14px; margin: 0; }");
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

Deno.test("graveyard tooltips cycle one grave at a time (hidden at rest, spotlight class)", () => {
  const on = renderGraveyardPage(
    graveyardView([mon("Vee", "eevee", 133, 1111)]),
    { tooltips: true, max: 0 },
  );
  // Bubbles ship hidden; only the cycler's tipshow class reveals one at a time.
  assertStringIncludes(on, "opacity: 0", ".tip must be hidden at rest");
  assertStringIncludes(on, ".gpos.tipshow .tip { opacity: 1; }");
  assertStringIncludes(on, "setInterval(cycleTip, 2500)");
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
