// SSE hub + watchdog tests: full state on connect, NO history replay, live
// broadcast delivery, keepalive comments, and the exactly-once stale watchdog.

import { formatSse, SseHub, Watchdog } from "../src/sse.ts";
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";

Deno.test("formatSse frames an event", () => {
  assertEquals(formatSse("state", { a: 1 }), 'event: state\ndata: {"a":1}\n\n');
});

Deno.test("watchdog fires each transition exactly once", () => {
  let last = 0;
  const wd = new Watchdog(15000, () => last);
  assertEquals(wd.live, false, "boots stale");
  assertEquals(wd.check(1000), null, "no ingest yet → stays stale, no fire");

  last = 5000;
  assertEquals(wd.check(6000), true, "first ingest → fires live once");
  assertEquals(wd.check(7000), null, "…and only once");
  assertEquals(wd.check(19999), null, "still within staleAfter");
  assertEquals(wd.check(20000), false, "goes stale exactly once at the boundary");
  assertEquals(wd.check(30000), null, "…and only once");

  last = 29000;
  assertEquals(wd.check(30001), true, "recovers → fires live once");
  assertEquals(wd.check(30002), null);
});

function mkHub(view: unknown = { player: "Cole" }, lastIngestAt = () => 0) {
  const wd = new Watchdog(15000, lastIngestAt);
  return { hub: new SseHub(() => view, wd), wd };
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { done, value } = await reader.read();
  assert(!done, "stream ended unexpectedly");
  return new TextDecoder().decode(value);
}

Deno.test("connect sends full state + status and does NOT replay history", async () => {
  const { hub } = mkHub({ player: "Cole", memorial: [] });
  // events broadcast BEFORE connect must never reach a new subscriber
  hub.broadcastGame({ event: "pokemon_lost", pokemon: { species: "eevee" } });
  hub.broadcastGame({ event: "capture" });

  const res = hub.connect();
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("cache-control"), "no-store");
  const reader = res.body!.getReader();
  const first = await readChunk(reader);
  assertStringIncludes(first, "event: state");
  assertStringIncludes(first, '"player":"Cole"');
  assertStringIncludes(first, "event: status");
  assertStringIncludes(first, '"live":false');
  assert(!first.includes("event: game"), "no event-history replay on connect");
  await reader.cancel();
});

Deno.test("live broadcasts reach connected subscribers", async () => {
  const { hub } = mkHub();
  const res = hub.connect();
  const reader = res.body!.getReader();
  await readChunk(reader); // initial state+status

  hub.broadcastGame({ event: "capture", pokemon: { species: "zubat" } });
  const game = await readChunk(reader);
  assertStringIncludes(game, "event: game");
  assertStringIncludes(game, '"capture"');

  hub.broadcastState({ player: "Cole", updated: true });
  const state = await readChunk(reader);
  assertStringIncludes(state, "event: state");
  assertStringIncludes(state, '"updated":true');

  hub.keepalive();
  assertStringIncludes(await readChunk(reader), ": keepalive");

  await reader.cancel();
});

Deno.test("hub tick broadcasts status exactly once per transition", async () => {
  let last = 0;
  const { hub } = mkHub({ x: 1 }, () => last);
  const res = hub.connect();
  const reader = res.body!.getReader();
  await readChunk(reader);

  last = 1000;
  hub.tick(2000); // → live (fires)
  hub.tick(3000); // still live (no fire)
  hub.tick(16000); // → stale (fires)
  hub.tick(17000); // still stale (no fire)
  hub.keepalive(); // marker so we know no further status frames were sent

  let collected = "";
  while (!collected.includes(": keepalive")) {
    collected += await readChunk(reader);
  }
  const statusFrames = collected.split("\n\n").filter((f) => f.includes("event: status"));
  assertEquals(statusFrames.length, 2, "one live + one stale transition only");
  assertStringIncludes(statusFrames[0], '"live":true');
  assertStringIncludes(statusFrames[1], '"live":false');
  await reader.cancel();
});

Deno.test("cancelled subscribers are dropped from the hub", async () => {
  const { hub } = mkHub();
  const res = hub.connect();
  const reader = res.body!.getReader();
  await readChunk(reader);
  assertEquals(hub.size, 1);
  await reader.cancel();
  assertEquals(hub.size, 0);
  // broadcasting to nobody is a no-op, not an error
  hub.broadcastState({ ok: true });
});
