// POST /control tests: button-authoritative sync (set attempt) + "reset it all"
// (wipe campaign) — token gate (timing-safe), validation, and the SSE broadcast.

import { handleControl } from "../src/control.ts";
import { OverlayState } from "../src/state.ts";
import { parseMessage } from "../src/protocol.ts";
import type { Message } from "../src/protocol.ts";
import { assertEquals } from "./assert.ts";

function mkState(): OverlayState {
  return new OverlayState({ stateDir: "", eventLogSize: 10, staleAfterSec: 15, persistDebounceMs: 50 });
}

interface HubSpy {
  states: unknown[];
  broadcastState(v: unknown): void;
}

function mkHub(): HubSpy {
  const spy: HubSpy = {
    states: [],
    broadcastState(v) {
      spy.states.push(v);
    },
  };
  return spy;
}

function mkDeps(state = mkState(), hub = mkHub(), token = "", maxBodyBytes = 65536) {
  return { state, hub, token, maxBodyBytes, now: () => 123456 };
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://overlay.test/control", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function parse(raw: Record<string, unknown>): Message {
  const r = parseMessage(raw);
  if (!r.ok) throw new Error(r.error);
  return r.msg;
}

Deno.test("set pins the attempt number and broadcasts it", async () => {
  const state = mkState();
  const hub = mkHub();
  const deps = mkDeps(state, hub);
  const res = await handleControl(req({ action: "set", attempt: 7 }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, attempt: 7 });
  assertEquals(hub.states.length, 1);
  assertEquals((hub.states[0] as { attempt: number }).attempt, 7);
});

Deno.test("set suppresses the next worldId auto-increment (no double-count)", () => {
  const state = mkState();
  state.setAttempt(7);
  // a brand-new worldId would normally bank + bump to 8; the pin adopts it
  const r = state.apply(
    parse({ v: 1, type: "snapshot", session: "s-1", seq: 1, t: 1, player: "Cole", worldId: "w-new" }),
    1000,
  );
  assertEquals(r.newAttempt, false);
  assertEquals(state.view(1000).attempt, 7);
});

Deno.test("reset wipes the campaign back to attempt 1 and clears the cemetery", async () => {
  const state = mkState();
  state.setAttempt(4);
  state.apply(parse({ v: 1, type: "event", session: "s-1", seq: 1, t: 1, event: "whiteout", reason: "faint" }), 1000);
  assertEquals(state.view(1000).memorial.length, 1);

  const hub = mkHub();
  const deps = mkDeps(state, hub);
  const res = await handleControl(req({ action: "reset" }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, attempt: 1 });
  const v = state.view(123456);
  assertEquals(v.attempt, 1);
  assertEquals(v.memorial.length, 0);
  assertEquals(hub.states.length, 1, "reset broadcasts exactly once");
});

Deno.test("token gate: missing/wrong → 401, bearer or x-overlay-token → 200", async () => {
  const state = mkState();
  const hub = mkHub();
  const deps = mkDeps(state, hub, "sekrit-token");

  const missing = await handleControl(req({ action: "set", attempt: 1 }), deps);
  assertEquals(missing.status, 401);
  await missing.body?.cancel();

  const wrong = await handleControl(req({ action: "set", attempt: 1 }, { authorization: "Bearer nope" }), deps);
  assertEquals(wrong.status, 401);
  await wrong.body?.cancel();

  const bearer = await handleControl(req({ action: "set", attempt: 5 }, { authorization: "Bearer sekrit-token" }), deps);
  assertEquals(bearer.status, 200);
  await bearer.body?.cancel();

  const header = await handleControl(req({ action: "reset" }, { "x-overlay-token": "sekrit-token" }), deps);
  assertEquals(header.status, 200);
  await header.body?.cancel();

  assertEquals(hub.states.length, 2, "unauthorized requests must not touch state");
});

Deno.test("bad requests: non-POST 405, bad JSON 400, attempt<1/non-number 400, unknown action 400", async () => {
  const get = await handleControl(new Request("http://overlay.test/control"), mkDeps());
  assertEquals(get.status, 405);
  await get.body?.cancel();

  const badJson = await handleControl(req("{not json"), mkDeps());
  assertEquals(badJson.status, 400);
  await badJson.body?.cancel();

  const zero = await handleControl(req({ action: "set", attempt: 0 }), mkDeps());
  assertEquals(zero.status, 400);
  await zero.body?.cancel();

  const nan = await handleControl(req({ action: "set", attempt: "x" }), mkDeps());
  assertEquals(nan.status, 400);
  await nan.body?.cancel();

  const unknown = await handleControl(req({ action: "frobnicate" }), mkDeps());
  assertEquals(unknown.status, 400);
  await unknown.body?.cancel();
});
