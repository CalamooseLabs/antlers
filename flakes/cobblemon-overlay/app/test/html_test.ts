// HTML/XSS + sprite-mapping tests: escapeHtml, the server-rendered status page,
// the client pages' safety conventions, and the sprite slug sanitizer/fallback.

import { escapeHtml } from "../src/util.ts";
import { sanitizeSlug, SpriteStore } from "../src/sprites.ts";
import { BADGES_HTML, CEMETERY_HTML, PARTY_HTML, renderStatusPage, TOASTS_HTML } from "../src/html.ts";
import { handleIngest } from "../src/ingest.ts";
import { OverlayState, type PublicState } from "../src/state.ts";
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
    memorial: [{ name: evil, species: evil, dex: 1, level: 5, cause: "faint", attempt: 1, ts: 1000 }],
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
