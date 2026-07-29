// Sprite resolution for regional forms + shiny variants. The bundled pokesprite
// tree ships regional-form slugs (growlithe-hisui.png) in the flat set and a
// parallel shiny/<slug>.png set; resolve() maps a Pokémon's Cobblemon aspects to
// the form slug and the shiny flag to the shiny set, degrading gracefully.

import { SpriteStore } from "../src/sprites.ts";
import { assert, assertEquals } from "./assert.ts";

// regular set includes base + regional forms; shiny set is deliberately PARTIAL
// (no shiny meowth-alola, no shiny meowth) to exercise the fallbacks.
function store(): SpriteStore {
  return SpriteStore.forTest(
    ["growlithe", "growlithe-hisui", "meowth", "meowth-alola", "pikachu"],
    new Map([[58, "growlithe"], [52, "meowth"], [25, "pikachu"]]),
    ["growlithe", "growlithe-hisui", "pikachu"],
  );
}

Deno.test("regional forms: a mapped Cobblemon aspect selects the pokesprite form slug", () => {
  const s = store();
  assertEquals(s.resolve("growlithe", 0, { aspects: ["hisuian"] }), "growlithe-hisui.png");
  assertEquals(s.resolve("cobblemon:Growlithe", 58, { aspects: ["hisuian"] }), "growlithe-hisui.png");
  assertEquals(s.resolve("meowth", 0, { aspects: ["alolan"] }), "meowth-alola.png");
});

Deno.test("regional forms: an aspect that already IS the pokesprite slug passes through verbatim", () => {
  assertEquals(store().resolve("meowth", 0, { aspects: ["alola"] }), "meowth-alola.png");
});

Deno.test("regional forms: an unknown/irrelevant aspect falls back to the base sprite", () => {
  const s = store();
  assertEquals(s.resolve("growlithe", 0, { aspects: ["gigantamax"] }), "growlithe.png");
  assertEquals(s.resolve("growlithe", 0, { aspects: ["male"] }), "growlithe.png");
  assertEquals(s.resolve("growlithe", 0, { aspects: [] }), "growlithe.png");
});

Deno.test("shiny: the shiny flag picks the shiny/<slug>.png variant", () => {
  const s = store();
  assertEquals(s.resolve("growlithe", 0, { shiny: true }), "shiny/growlithe.png");
  assertEquals(s.resolve("pikachu", 25, { shiny: true }), "shiny/pikachu.png");
});

Deno.test("shiny + form: the shiny regional-form sprite is preferred when present", () => {
  assertEquals(
    store().resolve("growlithe", 0, { shiny: true, aspects: ["hisuian"] }),
    "shiny/growlithe-hisui.png",
  );
});

Deno.test("shiny falls back to the regular icon when no shiny sprite exists", () => {
  const s = store();
  // no shiny meowth at all → the plain box icon
  assertEquals(s.resolve("meowth", 0, { shiny: true }), "meowth.png");
  // form correctness wins over shininess: no shiny meowth-alola, so the regular
  // regional form is chosen over a shiny base
  assertEquals(s.resolve("meowth", 0, { shiny: true, aspects: ["alolan"] }), "meowth-alola.png");
});

Deno.test("resolve without a variant is unchanged (base slug + dex fallback)", () => {
  const s = store();
  assertEquals(s.resolve("growlithe"), "growlithe.png");
  assertEquals(s.resolve("unknownmon", 52), "meowth.png");
  assertEquals(s.resolve("nope"), null);
});

Deno.test("serve reads the shiny/ subdir when ?shiny=1 resolves there", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-shiny" });
  try {
    const regular = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]); // fake PNG (regular)
    const shiny = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]); // fake PNG (shiny) — distinct bytes
    await Deno.mkdir(`${dir}/shiny`);
    await Deno.writeFile(`${dir}/pikachu.png`, regular);
    await Deno.writeFile(`${dir}/shiny/pikachu.png`, shiny);
    const s = new SpriteStore(dir);
    await s.init();

    const plain = await s.serve("pikachu.png", null);
    assertEquals(plain.status, 200);
    assertEquals(new Uint8Array(await plain.arrayBuffer()), regular);

    const glint = await s.serve("pikachu.png", null, { shiny: true });
    assertEquals(glint.status, 200);
    assertEquals(new Uint8Array(await glint.arrayBuffer()), shiny, "shiny request serves the shiny/ file");

    // shiny requested for a species with no shiny file → the regular icon, 200
    await Deno.writeFile(`${dir}/eevee.png`, regular);
    const s2 = new SpriteStore(dir);
    await s2.init();
    const fallback = await s2.serve("eevee.png", null, { shiny: true });
    assertEquals(fallback.status, 200);
    assertEquals(new Uint8Array(await fallback.arrayBuffer()), regular);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
