// Wire-protocol (v1) validator tests — strict envelope, tolerant innards.

import { parseMessage } from "../src/protocol.ts";
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";

function snap(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    type: "snapshot",
    session: "s-1",
    seq: 7,
    t: 1700000000000,
    player: "Cole",
    worldId: "w-1",
    world: { day: 3, timeOfDay: 1000, playtimeTicks: 99 },
    location: "Route 1",
    party: [{
      slot: 0,
      uuid: "u-1",
      species: "cobblemon:pikachu",
      dex: 25,
      name: "Sparky",
      level: 12,
      hp: 30,
      maxHp: 35,
      fainted: false,
      shiny: true,
      gender: "male",
      heldItem: "light_ball",
    }],
    deaths: { total: 1, whiteouts: 0, sacrifices: 0, duplicateReleases: 1 },
    progress: { badges: 2, levelCap: 28, nextLevelCap: 36, trainersDefeated: 7 },
    quest: { name: "First Steps", stage: 2 },
    ...extra,
  };
}

Deno.test("parses a full snapshot", () => {
  const r = parseMessage(snap());
  assert(r.ok, r.ok ? "" : r.error);
  const m = r.msg;
  assert(m.type === "snapshot");
  assertEquals(m.session, "s-1");
  assertEquals(m.seq, 7);
  assertEquals(m.player, "Cole");
  assertEquals(m.worldId, "w-1");
  assertEquals(m.location, "Route 1");
  assertEquals(m.party.length, 1);
  assertEquals(m.party[0].species, "cobblemon:pikachu");
  assertEquals(m.party[0].heldItem, "light_ball");
  assertEquals(m.deaths.duplicateReleases, 1);
  assertEquals(m.progress.nextLevelCap, 36);
  // numeric quest stage is normalized to a string
  assertEquals(m.quest, { name: "First Steps", stage: "2" });
});

Deno.test("unknown fields are ignored, missing inner fields default", () => {
  const r = parseMessage({
    v: 1,
    type: "snapshot",
    session: "s",
    seq: 0,
    somethingNew: { future: true },
    party: [{ species: "eevee", junkField: 9 }],
  });
  assert(r.ok, r.ok ? "" : r.error);
  const m = r.msg;
  assert(m.type === "snapshot");
  assertEquals(m.worldId, null);
  assertEquals(m.world, null);
  assertEquals(m.quest, null);
  assertEquals(m.deaths, { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 });
  assertEquals(m.progress.badges, 0);
  assertEquals(m.party[0].name, "");
  assertEquals(m.party[0].level, 0);
});

Deno.test("rejects bad envelopes", () => {
  for (
    const bad of [
      null,
      42,
      [],
      "x",
      { ...snap(), v: 2 },
      { ...snap(), v: undefined },
      { ...snap(), session: "" },
      { ...snap(), session: undefined },
      { ...snap(), seq: "7" },
      { ...snap(), seq: -1 },
      { ...snap(), seq: NaN },
      { ...snap(), type: "wibble" },
      { ...snap(), type: undefined },
    ]
  ) {
    const r = parseMessage(bad);
    assert(!r.ok, `should reject ${JSON.stringify(bad)}`);
  }
});

Deno.test("version error is explicit", () => {
  const r = parseMessage({ ...snap(), v: 3 });
  assert(!r.ok);
  assertStringIncludes(r.error, "version");
});

Deno.test("party is capped at 6, memberless entries dropped", () => {
  const members: Record<string, unknown>[] = [];
  for (let i = 0; i < 9; i++) members.push({ species: `mon${i}`, slot: i });
  members.splice(2, 0, { level: 5 }); // no species → dropped
  const r = parseMessage(snap({ party: members }));
  assert(r.ok, r.ok ? "" : r.error);
  assert(r.msg.type === "snapshot");
  assertEquals(r.msg.party.length, 6);
  assertEquals(r.msg.party.map((m) => m.species), ["mon0", "mon1", "mon2", "mon3", "mon4", "mon5"]);
});

function ev(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, type: "event", session: "s-1", seq: 3, t: 1, event, ...extra };
}

Deno.test("parses each event type", () => {
  const cases: [Record<string, unknown>, (m: Record<string, unknown>) => void][] = [
    [
      ev("pokemon_lost", { cause: "sacrifice", pokemon: { species: "eevee", dex: 133, name: "Vee", level: 20 }, deathsTotal: 4 }),
      (m) => {
        assertEquals(m.cause, "sacrifice");
        assertEquals(m.deathsTotal, 4);
        assertEquals((m.pokemon as { name: string }).name, "Vee");
      },
    ],
    [ev("capture", { pokemon: { species: "zubat", dex: 41 } }), (m) => assertEquals((m.pokemon as { dex: number }).dex, 41)],
    [ev("whiteout", { reason: "flee" }), (m) => assertEquals(m.reason, "flee")],
    [ev("badge", { badgeId: "gyms/badge_1", badges: 3 }), (m) => {
      assertEquals(m.badgeId, "gyms/badge_1");
      assertEquals(m.badges, 3);
    }],
    [ev("trainer_defeated", { trainerId: "t1", trainerName: "Rival", category: "story" }), (m) => assertEquals(m.trainerName, "Rival")],
    [ev("level_cap", { cap: 36 }), (m) => assertEquals(m.cap, 36)],
    [ev("session_start", { modVersion: "1.2.3", protocol: 1 }), (m) => assertEquals(m.modVersion, "1.2.3")],
    [ev("session_stop"), () => {}],
  ];
  for (const [raw, check] of cases) {
    const r = parseMessage(raw);
    assert(r.ok, r.ok ? "" : `${raw.event}: ${r.error}`);
    assert(r.msg.type === "event");
    assertEquals(r.msg.event, raw.event);
    check(r.msg as unknown as Record<string, unknown>);
  }
});

Deno.test("event validation edges", () => {
  // unknown event name → rejected
  assert(!parseMessage(ev("mystery_event")).ok);
  // missing cause defaults to faint; invalid cause rejected
  const d = parseMessage(ev("pokemon_lost", { pokemon: { species: "eevee" } }));
  assert(d.ok, d.ok ? "" : d.error);
  assert(d.msg.type === "event");
  assertEquals(d.msg.cause, "faint");
  assertEquals(d.msg.deathsTotal, undefined);
  assert(!parseMessage(ev("pokemon_lost", { cause: "meteor", pokemon: { species: "eevee" } })).ok);
  // pokemon_lost / capture need pokemon.species
  assert(!parseMessage(ev("pokemon_lost")).ok);
  assert(!parseMessage(ev("capture", { pokemon: { level: 4 } })).ok);
  // whiteout reason defaults / rejects
  const w = parseMessage(ev("whiteout"));
  assert(w.ok && w.msg.type === "event");
  assertEquals(w.msg.reason, "faint");
  assert(!parseMessage(ev("whiteout", { reason: "rage_quit" })).ok);
  // level_cap requires a numeric cap
  assert(!parseMessage(ev("level_cap")).ok);
  assert(!parseMessage(ev("level_cap", { cap: "36" })).ok);
});
