// OverlayState tests: seq dedup, session reset, worldId→attempt banking (and
// the counter-decrease fallback), memorial append + persistence round-trip,
// stale-after-restart.

import { OverlayState } from "../src/state.ts";
import { parseMessage } from "../src/protocol.ts";
import type { Message } from "../src/protocol.ts";
import { assert, assertEquals } from "./assert.ts";

// stateDir "" = persistence disabled (no timers) unless a test passes a dir.
function mkState(stateDir = ""): OverlayState {
  return new OverlayState({ stateDir, eventLogSize: 10, staleAfterSec: 15, persistDebounceMs: 50 });
}

let seqCounter = 0;

function msg(raw: Record<string, unknown>): Message {
  const r = parseMessage({ v: 1, session: "s-1", seq: ++seqCounter, t: 1, ...raw });
  if (!r.ok) throw new Error(r.error);
  return r.msg;
}

function snapshot(extra: Record<string, unknown> = {}): Message {
  return msg({
    type: "snapshot",
    player: "Cole",
    location: "Route 1",
    deaths: { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 },
    progress: { badges: 0, levelCap: 15, nextLevelCap: 20, trainersDefeated: 0 },
    ...extra,
  });
}

function lost(name: string, extra: Record<string, unknown> = {}): Message {
  return msg({
    type: "event",
    event: "pokemon_lost",
    cause: "faint",
    pokemon: { species: "eevee", dex: 133, name, level: 11 },
    ...extra,
  });
}

Deno.test("dedup: same-session seq replay is dup and never double-appends", () => {
  const st = mkState();
  const e = lost("Vee");
  const first = st.apply(e, 1000);
  assert(first.accepted && !first.dup);
  assertEquals(st.view(1000).memorial.length, 1);

  const replay = st.apply(e, 2000); // same session + seq
  assert(replay.dup && !replay.accepted);
  assertEquals(st.view(2000).memorial.length, 1, "dup must not double-append the memorial");
  // …but a dup still refreshes liveness (server receive time)
  assertEquals(st.lastIngestAt, 2000);
});

Deno.test("dedup: lower seq within a session is dup; a new session resets tracking", () => {
  const st = mkState();
  st.apply(msg({ type: "snapshot", seq: 50 }), 1000);
  assert(st.apply(msg({ type: "snapshot", seq: 10 }), 1100).dup, "lower seq in-session is a dup");
  const other = st.apply(msg({ type: "snapshot", seq: 1, session: "s-2" }), 1200);
  assert(other.accepted, "new session id resets seq tracking");
});

Deno.test("worldId change banks counters into campaign totals and bumps attempt", () => {
  const st = mkState();
  st.apply(
    snapshot({ worldId: "w-1", deaths: { total: 3, whiteouts: 2, sacrifices: 1, duplicateReleases: 0 } }),
    1000,
  );
  st.apply(lost("Casualty"), 1500);
  let v = st.view(1500);
  assertEquals(v.attempt, 1);

  // hardcore reset → new world, counters restart at 0
  const r = st.apply(
    snapshot({ worldId: "w-2", deaths: { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 } }),
    2000,
  );
  assert(r.newAttempt, "new worldId = new attempt");
  v = st.view(2000);
  assertEquals(v.attempt, 2);
  // banked: the pokemon_lost event had bumped total 3→4 before the reset
  assertEquals(v.campaign.total, 4);
  assertEquals(v.campaign.whiteouts, 2);
  assertEquals(v.campaign.sacrifices, 1);
  assertEquals(v.deaths.total, 0, "current-save counters restart");
  // memorial survives the reset, tagged with the attempt it happened in
  assertEquals(v.memorial.length, 1);
  assertEquals(v.memorial[0].attempt, 1);

  // same worldId again → NOT a new attempt
  const same = st.apply(snapshot({ worldId: "w-2", deaths: { total: 1 } }), 3000);
  assert(!same.newAttempt);
  assertEquals(st.view(3000).attempt, 2);
  assertEquals(st.view(3000).campaign.total, 5); // 4 banked + 1 current
});

Deno.test("counter-decrease fallback detects a new attempt when worldId is absent", () => {
  const st = mkState();
  st.apply(snapshot({ deaths: { total: 5, whiteouts: 1, sacrifices: 0, duplicateReleases: 0 } }), 1000);
  assertEquals(st.view(1000).attempt, 1);
  const r = st.apply(snapshot({ deaths: { total: 1, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 } }), 2000);
  assert(r.newAttempt, "deaths.total decrease without worldId = new attempt");
  const v = st.view(2000);
  assertEquals(v.attempt, 2);
  assertEquals(v.campaign.total, 6); // 5 banked + 1 current
  // an increase is NOT a new attempt
  const r2 = st.apply(snapshot({ deaths: { total: 2, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 } }), 3000);
  assert(!r2.newAttempt);
});

Deno.test("adopting a worldId on an old-protocol campaign does not bank", () => {
  const st = mkState();
  st.apply(snapshot({ deaths: { total: 2, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 } }), 1000);
  const r = st.apply(snapshot({ worldId: "w-1", deaths: { total: 2, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 } }), 2000);
  assert(!r.newAttempt, "first-seen worldId on the same save adopts, not banks");
  assertEquals(st.view(2000).attempt, 1);
});

Deno.test("event hints merge into current state between snapshots", () => {
  const st = mkState();
  st.apply(snapshot({ progress: { badges: 1, levelCap: 20, nextLevelCap: 28, trainersDefeated: 3 } }), 1000);
  st.apply(msg({ type: "event", event: "badge", badgeId: "gyms/badge_2", badges: 2 }), 1100);
  st.apply(msg({ type: "event", event: "level_cap", cap: 28 }), 1200);
  st.apply(msg({ type: "event", event: "whiteout", reason: "faint" }), 1300);
  st.apply(msg({ type: "event", event: "trainer_defeated", trainerName: "Rival" }), 1400);
  st.apply(lost("Hinted", { deathsTotal: 9 }), 1500);
  const v = st.view(1500);
  assertEquals(v.progress.badges, 2);
  assertEquals(v.progress.levelCap, 28);
  assertEquals(v.deaths.whiteouts, 1);
  assertEquals(v.progress.trainersDefeated, 4);
  assertEquals(v.deaths.total, 9, "pokemon_lost deathsTotal hint is applied");
});

Deno.test("staleness uses server receive time, never the mod's t field", () => {
  const st = mkState();
  // mod clock (t) is wildly in the past; server receives it "now"
  st.apply(msg({ type: "snapshot", t: 5 }), 100_000);
  assert(st.view(100_001).live);
  assert(st.view(100_000 + 14_999).live);
  assert(!st.view(100_000 + 15_000).live, "stale exactly at staleAfterSec");
});

Deno.test("persistence round-trip: memorial + attempt survive, boots stale", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-test" });
  try {
    const st = mkState(dir);
    st.apply(
      snapshot({ worldId: "w-1", deaths: { total: 1, whiteouts: 1, sacrifices: 0, duplicateReleases: 0 } }),
      1000,
    );
    st.apply(lost("Ripley", { cause: "sacrifice" }), 1500);
    st.apply(snapshot({ worldId: "w-2", deaths: { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 } }), 2000);
    await st.flush();

    // state.json is real JSON on disk (atomic tmp+rename leaves no .tmp behind)
    const onDisk = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
    assertEquals(onDisk.version, 1);
    let tmpExists = true;
    try {
      await Deno.stat(`${dir}/state.json.tmp`);
    } catch {
      tmpExists = false;
    }
    assert(!tmpExists, "no tmp file left behind");

    const st2 = mkState(dir);
    await st2.load();
    assertEquals(st2.lastIngestAt, 0, "restored state must be stale until the mod pushes");
    const v = st2.view(Date.now());
    assert(!v.live);
    assertEquals(v.attempt, 2);
    assertEquals(v.memorial.length, 1);
    assertEquals(v.memorial[0].name, "Ripley");
    assertEquals(v.memorial[0].cause, "sacrifice");
    assertEquals(v.memorial[0].attempt, 1);
    // banked campaign totals restored (2 = 1 snapshot death + 1 sacrifice bump)
    assertEquals(v.campaign.total, 2);
    assertEquals(v.campaign.whiteouts, 1);
    assertEquals(v.player, "Cole");
    // session/seq tracking reset: an old seq from before the restart is accepted
    const r = st2.apply(msg({ type: "snapshot", seq: 1, session: "s-1" }), Date.now());
    assert(r.accepted);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("corrupt state.json is ignored (fresh start)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-test" });
  try {
    await Deno.writeTextFile(`${dir}/state.json`, "{not json");
    const st = mkState(dir);
    await st.load();
    assertEquals(st.view(1).attempt, 1);
    assertEquals(st.view(1).memorial.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("debounced persist timer is flushed cleanly (no dangling timer)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-test" });
  try {
    const st = mkState(dir);
    st.apply(snapshot(), 1000); // schedules the debounce timer
    await st.flush(); // cancels it + persists now
    const onDisk = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
    assertEquals(onDisk.player, "Cole");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
