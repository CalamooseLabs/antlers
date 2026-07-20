// HTML/XSS + sprite-mapping tests: escapeHtml, the server-rendered status and
// graveyard pages, the client pages' safety conventions, and the sprite slug
// sanitizer/fallback.

import { escapeHtml } from "../src/util.ts";
import { sanitizeSlug, SpriteStore } from "../src/sprites.ts";
import {
  BADGES_HTML,
  CEMETERY_HTML,
  gravePlacement,
  PARTY_HTML,
  pixelArt,
  renderGraveyardPage,
  renderStatusPage,
  TOASTS_HTML,
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

Deno.test("graveyard scenery: GB tree line, checker grass, decor tiles, drifting mist", () => {
  const html = renderGraveyardPage(graveyardView([]), { tooltips: false, max: 0 });
  // tree line: two depth rows of repeating round-top pixel trees (repeat-x tiles)
  assertStringIncludes(html, `class="treeline treeline-far"`);
  assertStringIncludes(html, `class="treeline treeline-near"`);
  assertStringIncludes(html, "background-repeat: repeat-x");
  // flat grass band with the classic two-tone tile checker
  assertStringIncludes(html, `class="ground"`);
  assertStringIncludes(html, "conic-gradient");
  // scattered decor: grass tufts + Crystal-style 2-frame blinking flowers
  assertStringIncludes(html, `class="tuft"`);
  assertStringIncludes(html, `class="flower"`);
  assertStringIncludes(html, "@keyframes bloom");
  assertStringIncludes(html, "steps(1)", "the flower blink snaps between frames, GB-style");
  // mist: two bands behind the stones, one thin band in front, looping keyframes
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
  // palette (flat shades + the #101010 outline baked into the maps)
  const stone = rule(".stone::before");
  assertStringIncludes(stone, "box-shadow:");
  assertStringIncludes(stone, "#f8f8f8"); // headstone highlight gray
  assertStringIncludes(stone, "#101010"); // black pixel outline
  const stake = rule(".stone.stake::before");
  assertStringIncludes(stake, "box-shadow:");
  assertStringIncludes(stake, "#b87838"); // wood
  const player = rule(".stone.player::before");
  assertStringIncludes(player, "box-shadow:");
  assertStringIncludes(player, "#484848"); // dark stone cross
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
