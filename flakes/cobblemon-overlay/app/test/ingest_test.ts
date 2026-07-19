// POST /ingest tests: token gate (timing-safe), body cap, version check,
// dup handling, and the SSE broadcast wiring.

import { handleIngest, readBodyLimited } from "../src/ingest.ts";
import { OverlayState } from "../src/state.ts";
import { timingSafeEqual } from "../src/util.ts";
import { assert, assertEquals } from "./assert.ts";

function mkState(): OverlayState {
  return new OverlayState({ stateDir: "", eventLogSize: 10, staleAfterSec: 15, persistDebounceMs: 50 });
}

interface HubSpy {
  states: unknown[];
  games: unknown[];
  broadcastState(v: unknown): void;
  broadcastGame(v: unknown): void;
}

function mkHub(): HubSpy {
  const spy: HubSpy = {
    states: [],
    games: [],
    broadcastState(v) {
      spy.states.push(v);
    },
    broadcastGame(v) {
      spy.games.push(v);
    },
  };
  return spy;
}

function mkDeps(state = mkState(), hub = mkHub(), token = "", maxBodyBytes = 65536) {
  return { state, hub, token, maxBodyBytes, now: () => 123456 };
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://overlay.test/ingest", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function snapshot(seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, type: "snapshot", session: "s-1", seq, t: 1, player: "Cole", ...extra };
}

Deno.test("accepts a snapshot and broadcasts state", async () => {
  const hub = mkHub();
  const deps = mkDeps(mkState(), hub);
  const res = await handleIngest(req(snapshot(1)), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(hub.states.length, 1);
  assertEquals(hub.games.length, 0);
  assertEquals((hub.states[0] as { player: string }).player, "Cole");
});

Deno.test("duplicate seq → {ok,dup} 2xx and no re-broadcast", async () => {
  const hub = mkHub();
  const deps = mkDeps(mkState(), hub);
  await handleIngest(req(snapshot(5)), deps);
  const res = await handleIngest(req(snapshot(5)), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, dup: true });
  assertEquals(hub.states.length, 1, "dup must not re-broadcast");
});

Deno.test("events broadcast game (+ state when counters changed)", async () => {
  const hub = mkHub();
  const deps = mkDeps(mkState(), hub);
  const res = await handleIngest(
    req({
      v: 1,
      type: "event",
      session: "s-1",
      seq: 2,
      t: 1,
      event: "pokemon_lost",
      cause: "faint",
      pokemon: { species: "eevee", dex: 133, name: "Vee", level: 9 },
      deathsTotal: 1,
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(hub.games.length, 1);
  const game = hub.games[0] as Record<string, unknown>;
  assertEquals(game.event, "pokemon_lost");
  assertEquals(game.ts, 123456, "event ts is the SERVER receive time, not the mod's t");
  assertEquals(hub.states.length, 1, "counter-changing event re-broadcasts state");
  assertEquals(deps.state.view(123456).memorial.length, 1);
  // capture changes no derived state → game only
  await handleIngest(
    req({ v: 1, type: "event", session: "s-1", seq: 3, t: 1, event: "capture", pokemon: { species: "zubat" } }),
    deps,
  );
  assertEquals(hub.games.length, 2);
  assertEquals(hub.states.length, 1);
});

Deno.test("a new attempt emits a synthetic new_attempt game event", async () => {
  const hub = mkHub();
  const deps = mkDeps(mkState(), hub);
  await handleIngest(req(snapshot(1, { worldId: "w-1", deaths: { total: 2 } })), deps);
  await handleIngest(req(snapshot(2, { worldId: "w-2", deaths: { total: 0 } })), deps);
  assertEquals(hub.games.length, 1);
  const game = hub.games[0] as Record<string, unknown>;
  assertEquals(game.event, "new_attempt");
  assertEquals(game.attempt, 2);
});

Deno.test("protocol version mismatch → 400", async () => {
  const res = await handleIngest(req({ ...snapshot(1), v: 2 }), mkDeps());
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("invalid JSON → 400, non-POST → 405", async () => {
  const bad = await handleIngest(req("{not json"), mkDeps());
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const get = await handleIngest(new Request("http://overlay.test/ingest"), mkDeps());
  assertEquals(get.status, 405);
  await get.body?.cancel();
});

Deno.test("oversized body → 413", async () => {
  const deps = mkDeps(mkState(), mkHub(), "", 64);
  const res = await handleIngest(req(snapshot(1, { padding: "x".repeat(500) })), deps);
  assertEquals(res.status, 413);
  await res.body?.cancel();
});

Deno.test("token gate: missing/wrong → 401, bearer or x-overlay-token → 200", async () => {
  const state = mkState();
  const hub = mkHub();
  const deps = mkDeps(state, hub, "sekrit-token");

  const missing = await handleIngest(req(snapshot(1)), deps);
  assertEquals(missing.status, 401);
  await missing.body?.cancel();

  const wrong = await handleIngest(req(snapshot(1), { authorization: "Bearer nope" }), deps);
  assertEquals(wrong.status, 401);
  await wrong.body?.cancel();

  const bearer = await handleIngest(req(snapshot(1), { authorization: "Bearer sekrit-token" }), deps);
  assertEquals(bearer.status, 200);
  await bearer.body?.cancel();

  const header = await handleIngest(req(snapshot(2), { "x-overlay-token": "sekrit-token" }), deps);
  assertEquals(header.status, 200);
  await header.body?.cancel();

  assertEquals(hub.states.length, 2, "unauthorized requests must not touch state");
});

Deno.test("timingSafeEqual basics", () => {
  assert(timingSafeEqual("abc", "abc"));
  assert(!timingSafeEqual("abc", "abd"));
  assert(!timingSafeEqual("abc", "abcd"));
  assert(!timingSafeEqual("", "x"));
  assert(timingSafeEqual("", ""));
});

Deno.test("readBodyLimited honors the cap", async () => {
  const small = new Request("http://x/", { method: "POST", body: "hello" });
  assertEquals(await readBodyLimited(small, 10), "hello");
  const big = new Request("http://x/", { method: "POST", body: "y".repeat(100) });
  assertEquals(await readBodyLimited(big, 10), null);
});
