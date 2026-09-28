// Channel-point effect queue tests: request parsing, every state transition,
// lease + TTL expiry with an injected clock, idempotent results, the cancel
// paths (+ the cancel reason), the 503/429 enqueue gates, pruning, the
// /effects HTTP contract, and durable persistence (round-trip, leased →
// pending on boot, the concurrent write serialization regression, and the
// write-through rollback when the disk fails — incl. the rollback-window race
// and SerialWriter's onFailed / no-onFailed semantics).

import {
  EffectQueue,
  type EffectQueueOpts,
  type EffectRecord,
  effectResultEvent,
  EXPIRY_GRACE_MS,
  FINAL_RETAIN_MS,
  handleEffects,
  MAX_RECORDS,
  parseCancelReason,
  parseClaim,
  parseEnqueue,
  parseResult,
  redeemEvent,
} from "../src/effects.ts";
import { isError, SerialWriter } from "../src/util.ts";
import { assert, assertEquals } from "./assert.ts";

const T0 = 1_000_000_000;

function mkQueue(opts: Partial<EffectQueueOpts> = {}): EffectQueue {
  return new EffectQueue({
    stateDir: "",
    enabled: true,
    leaseSec: 30,
    ttlSec: 600,
    acceptWindowSec: 45,
    maxOpen: 100,
    ...opts,
  });
}

function input(id: string, extra: Record<string, unknown> = {}) {
  const r = parseEnqueue({ id, effect: "force_jump", viewer: "Alice", reward: "Hop To It", cost: 150, ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

// A heartbeat-only poll (ready=false leases nothing) — makes enqueues accepted.
async function heartbeat(q: EffectQueue, now = T0): Promise<void> {
  await q.claim({ max: 1, ready: false, modVersion: "test" }, now);
}

async function enqueueNew(q: EffectQueue, id: string, now = T0, extra: Record<string, unknown> = {}): Promise<void> {
  const out = await q.enqueue(input(id, extra), now);
  assertEquals(out.kind, "new", `enqueue ${id}`);
}

// ---- parsing ----

Deno.test("parseEnqueue: shape validation, defaults, control chars stripped + caps", () => {
  const bad: Record<string, unknown>[] = [
    {},
    { id: "a/b", effect: "potion", viewer: "v", reward: "r" },
    { id: "x".repeat(129), effect: "potion", viewer: "v", reward: "r" },
    { id: "ok", effect: "Force-Jump", viewer: "v", reward: "r" },
    { id: "ok", effect: "potion", params: [1], viewer: "v", reward: "r" },
    { id: "ok", effect: "potion", viewer: "  ", reward: "r" },
    { id: "ok", effect: "potion", viewer: "v" },
    { id: "ok", effect: "potion", viewer: "v", reward: "r", cost: -1 },
    { id: "ok", effect: "potion", viewer: "v", reward: "r", simulated: "yes" },
    { id: "ok", effect: "potion", viewer: "v", reward: "r", ttlSec: "10" },
    { id: "ok", effect: "potion", viewer: "v", reward: "r", viewerLogin: 5 },
  ];
  for (const raw of bad) assert(!parseEnqueue(raw).ok, `must reject ${JSON.stringify(raw)}`);
  assert(!parseEnqueue([]).ok);
  assert(!parseEnqueue(null).ok);

  const min = parseEnqueue({ id: "sim-0f8c", effect: "potion", viewer: "v", reward: "r" });
  assert(min.ok);
  assertEquals(min.value.params, {});
  assertEquals(min.value.viewerLogin, "");
  assertEquals(min.value.cost, 0);
  assertEquals(min.value.simulated, false);
  assertEquals(min.value.ttlSec, null);

  const full = parseEnqueue({
    id: "6a1b2c3d-0000-4000-8000-000000000001",
    effect: "potion",
    params: { effect: "slowness", amplifier: 1, seconds: 45 },
    viewer: "Evil\u0000\nName" + "x".repeat(100),
    viewerLogin: "evilname",
    reward: "  Budget Cuts  ",
    cost: 750.9,
    simulated: true,
    ttlSec: 120,
  });
  assert(full.ok);
  assertEquals(full.value.params, { effect: "slowness", amplifier: 1, seconds: 45 });
  assert(!/\p{Cc}/u.test(full.value.viewer), "control characters stripped");
  assertEquals(full.value.viewer.length, 64, "viewer capped at 64");
  assertEquals(full.value.reward, "Budget Cuts");
  assertEquals(full.value.cost, 750);
  assertEquals(full.value.simulated, true);
  assertEquals(full.value.ttlSec, 120);
});

Deno.test("parseClaim clamps max to 1..10 (default 3); ready is strictly true", () => {
  const d = parseClaim({});
  assert(d.ok);
  assertEquals(d.value, { max: 3, ready: false, modVersion: "" });
  const hi = parseClaim({ max: 99, ready: true, modVersion: "1.2.3" });
  assert(hi.ok);
  assertEquals(hi.value, { max: 10, ready: true, modVersion: "1.2.3" });
  const lo = parseClaim({ max: 0, ready: "true" });
  assert(lo.ok);
  assertEquals(lo.value.max, 1);
  assertEquals(lo.value.ready, false, "a non-boolean ready never leases");
  assert(!parseClaim("nope").ok);
});

Deno.test("parseResult: unknown status is malformed; over-long reason/detail are truncated, not refused", () => {
  assert(!parseResult({}).ok);
  assert(!parseResult({ status: "leased" }).ok, "the mod cannot report a non-result status");
  assert(!parseResult({ status: "canceled" }).ok, "canceled is multichat's, not the mod's");
  const r = parseResult({ status: "rejected", reason: "r".repeat(100), detail: "d".repeat(500) });
  assert(r.ok);
  assertEquals(r.value.reason.length, 64);
  assertEquals(r.value.detail.length, 160);
  const plain = parseResult({ status: "applied" });
  assert(plain.ok);
  assertEquals(plain.value, { status: "applied", reason: "", detail: "" });
});

Deno.test("parseCancelReason: the four reasons pass; anything else is \"refunded\" — never an error", () => {
  for (const r of ["refunded", "fulfilled_externally", "manual", "timeout"]) {
    assertEquals(parseCancelReason(JSON.stringify({ reason: r })), r);
  }
  const odd = [null, "", "{}", "{not json", "[]", "null", "42", '"manual"'];
  for (const body of [...odd, '{"reason":"vibes"}', '{"reason":7}', '{"reason":"MANUAL"}']) {
    assertEquals(parseCancelReason(body), "refunded", `body ${JSON.stringify(body)}`);
  }
});

// ---- queue transitions ----

Deno.test("enqueue: new → pending (expiresAt = now + ttl, clamped 30..3600); a known id is a dup", async () => {
  const q = mkQueue();
  await heartbeat(q);
  await enqueueNew(q, "a");
  let rec = q.get("a")!;
  assertEquals(rec.status, "pending");
  assertEquals(rec.expiresAt, T0 + 600_000, "default ttl");
  assertEquals(rec.deliveries, 0);
  assertEquals(rec.createdAt, T0);

  await enqueueNew(q, "short", T0, { ttlSec: 1 });
  assertEquals(q.get("short")!.expiresAt, T0 + 30_000, "ttlSec clamps up to 30");
  await enqueueNew(q, "long", T0, { ttlSec: 99999 });
  assertEquals(q.get("long")!.expiresAt, T0 + 3_600_000, "ttlSec clamps down to 3600");

  const dup = await q.enqueue(input("a", { viewer: "Mallory" }), T0 + 5);
  assertEquals(dup.kind, "dup");
  rec = q.get("a")!;
  assertEquals(rec.viewer, "Alice", "a dup never overwrites the original");
});

Deno.test("enqueue gates: disabled, game_offline until the mod polls (and after the window), queue_full", async () => {
  const off = mkQueue({ enabled: false });
  await heartbeat(off);
  assertEquals((await off.enqueue(input("x"), T0)).kind, "disabled");

  const q = mkQueue({ maxOpen: 2 });
  assertEquals((await q.enqueue(input("x"), T0)).kind, "game_offline", "no poll yet");
  await heartbeat(q, T0);
  assertEquals((await q.enqueue(input("x"), T0 + 46_000)).kind, "game_offline", "poll older than the 45s window");
  await enqueueNew(q, "x", T0 + 45_000); // exactly at the window edge is still accepting
  await enqueueNew(q, "y", T0 + 45_000);
  assertEquals((await q.enqueue(input("z"), T0 + 45_000)).kind, "queue_full");

  // A retried POST for a KNOWN id is a dup even when the gates would refuse it
  // (refunding a still-queued redemption would double-resolve it).
  assertEquals((await q.enqueue(input("x"), T0 + 999_000)).kind, "dup");

  // finals don't count toward maxOpen
  await q.claim({ max: 10, ready: true, modVersion: "" }, T0 + 45_000);
  await q.result("x", { status: "applied", reason: "", detail: "" }, T0 + 45_001);
  await enqueueNew(q, "z", T0 + 45_002);
});

Deno.test("claim: ready=false only heartbeats; ready=true leases FIFO up to max, skips expired, relative expiresInMs", async () => {
  const q = mkQueue();
  await heartbeat(q);
  for (const id of ["e1", "e2", "e3", "e4"]) await enqueueNew(q, id, T0, { ttlSec: 60 });
  await enqueueNew(q, "old", T0 - 500_000, {}); // enqueued "long ago" (heartbeat is fresh at T0)

  const idle = await q.claim({ max: 10, ready: false, modVersion: "" }, T0 + 1000);
  assertEquals(idle.effects.length, 0, "not ready → nothing leased");
  assertEquals(q.get("e1")!.status, "pending");

  // T0+61s: e1..e4 (ttl 60s) are expired-but-unswept → skipped; "old" (ttl 600
  // from T0-500s) is still live
  const late = await q.claim({ max: 10, ready: true, modVersion: "" }, T0 + 61_000);
  assertEquals(late.effects.map((e) => e.id), ["old"]);
  assertEquals(late.effects[0].expiresInMs, (T0 - 500_000 + 600_000) - (T0 + 61_000));

  const q2 = mkQueue();
  await heartbeat(q2);
  for (const id of ["a", "b", "c", "d"]) await enqueueNew(q2, id, T0, { params: { n: id } });
  const got = await q2.claim({ max: 3, ready: true, modVersion: "1.0" }, T0 + 10);
  assertEquals(got.effects.map((e) => e.id), ["a", "b", "c"], "oldest first, capped at max");
  assertEquals(got.effects[0], {
    id: "a",
    effect: "force_jump",
    params: { n: "a" },
    viewer: "Alice",
    reward: "Hop To It",
    simulated: false,
    expiresInMs: 600_000 - 10,
  });
  const a = q2.get("a")!;
  assertEquals(a.status, "leased");
  assertEquals(a.leaseUntil, T0 + 10 + 30_000);
  assertEquals(a.deliveries, 1);
  assertEquals(q2.modVersion, "1.0");
  const next = await q2.claim({ max: 3, ready: true, modVersion: "1.0" }, T0 + 20);
  assertEquals(next.effects.map((e) => e.id), ["d"], "leased records are not handed out again");
});

Deno.test("results: leased → accepted → applied; leased → armed directly; finals are sticky; unknown id ignored", async () => {
  const q = mkQueue();
  await heartbeat(q);
  await enqueueNew(q, "a");
  await enqueueNew(q, "b");
  await q.claim({ max: 5, ready: true, modVersion: "" }, T0 + 1);

  const acc = await q.result("a", { status: "accepted", reason: "", detail: "" }, T0 + 2);
  assertEquals(acc, { status: "accepted", ignored: false, final: null });
  assertEquals(q.get("a")!.leaseUntil, undefined, "accepted clears the lease");
  const acc2 = await q.result("a", { status: "accepted", reason: "", detail: "" }, T0 + 3);
  assertEquals(acc2.ignored, false, "a repeated accepted is an idempotent no-op");

  const done = await q.result("a", { status: "applied", reason: "", detail: "Dropped a Diamond Pickaxe" }, T0 + 4);
  assertEquals(done.status, "applied");
  assertEquals(done.final!.detail, "Dropped a Diamond Pickaxe");

  const armed = await q.result("b", { status: "armed", reason: "", detail: "3 turns owed" }, T0 + 5);
  assertEquals(armed.status, "armed", "leased may skip accepted");
  assert(armed.final !== null);

  // idempotent re-report + a conflicting late report: both ignored, state kept
  const again = await q.result("a", { status: "applied", reason: "", detail: "" }, T0 + 6);
  assertEquals(again, { status: "applied", ignored: true, final: null });
  const flip = await q.result("a", { status: "rejected", reason: "error", detail: "" }, T0 + 7);
  assertEquals(flip, { status: "applied", ignored: true, final: null });
  assertEquals(q.get("a")!.detail, "Dropped a Diamond Pickaxe");
  assertEquals(q.get("a")!.updatedAt, T0 + 4, "a final record never changes");

  const unknown = await q.result("nope", { status: "applied", reason: "", detail: "" }, T0 + 8);
  assertEquals(unknown, { status: "unknown", ignored: true, final: null });
});

Deno.test("lease expiry (injected clock): leased → pending → redelivered; a late result on it still lands", async () => {
  const q = mkQueue({ leaseSec: 30 });
  await heartbeat(q);
  await enqueueNew(q, "a");
  await q.claim({ max: 1, ready: true, modVersion: "" }, T0);

  assertEquals((await q.sweep(T0 + 29_999)).length, 0);
  assertEquals(q.get("a")!.status, "leased", "still inside the lease");
  const finals = await q.sweep(T0 + 30_000);
  assertEquals(finals.length, 0, "a lease expiry is not a final transition");
  assertEquals(q.get("a")!.status, "pending");
  assertEquals(q.get("a")!.leaseUntil, undefined);

  const again = await q.claim({ max: 1, ready: true, modVersion: "" }, T0 + 31_000);
  assertEquals(again.effects.map((e) => e.id), ["a"], "redelivered");
  assertEquals(q.get("a")!.deliveries, 2);

  // lease lapses again, then the mod's (late) accepted + applied arrive
  await q.sweep(T0 + 62_000);
  assertEquals(q.get("a")!.status, "pending");
  await q.result("a", { status: "accepted", reason: "", detail: "" }, T0 + 62_500);
  assertEquals(q.get("a")!.status, "accepted", "pending takes a late accepted (no redelivery)");
  assertEquals((await q.sweep(T0 + 200_000)).length, 0, "accepted is not lease-bound");
  assertEquals((await q.claim({ max: 5, ready: true, modVersion: "" }, T0 + 200_001)).effects.length, 0);
  await q.result("a", { status: "applied", reason: "", detail: "" }, T0 + 200_002);
  assertEquals(q.get("a")!.status, "applied");
});

Deno.test("sweeper expiry: open past expiresAt + 60s grace → expired \"timeout\", returned for broadcast", async () => {
  const q = mkQueue();
  await heartbeat(q);
  await enqueueNew(q, "l", T0, { ttlSec: 60 }); // leased
  await enqueueNew(q, "c", T0, { ttlSec: 60 }); // accepted
  await enqueueNew(q, "f", T0, { ttlSec: 60 }); // final before expiry
  await q.claim({ max: 3, ready: true, modVersion: "" }, T0); // l, c, f leased (FIFO)
  await enqueueNew(q, "p", T0, { ttlSec: 60 }); // stays pending
  await q.result("c", { status: "accepted", reason: "", detail: "" }, T0 + 1);
  await q.result("f", { status: "rejected", reason: "empty_hand", detail: "" }, T0 + 2);
  assertEquals(q.get("l")!.status, "leased");
  assertEquals(q.get("p")!.status, "pending");

  const edge = T0 + 60_000 + EXPIRY_GRACE_MS;
  const none = await q.sweep(edge);
  assertEquals(none.length, 0, "not before expiresAt + grace");
  assertEquals(q.get("l")!.status, "pending", "(the lease itself lapsed meanwhile)");
  const expired = await q.sweep(edge + 1);
  assertEquals(expired.map((r) => r.id).sort(), ["c", "l", "p"]);
  for (const r of expired) {
    assertEquals(r.status, "expired");
    assertEquals(r.reason, "timeout");
  }
  assertEquals(q.get("f")!.status, "rejected", "finals are untouched");
  assertEquals(q.get("f")!.reason, "empty_hand");
  assertEquals((await q.sweep(edge + 2)).length, 0, "expired exactly once");
});

Deno.test("cancel: undelivered pending → canceled; held (leased/accepted/re-pended) → cancelRequested, relayed, never re-leased", async () => {
  const q = mkQueue();
  const ok = { reason: "", detail: "" };
  await heartbeat(q);
  for (const id of ["r", "a", "f"]) await enqueueNew(q, id);
  await q.claim({ max: 3, ready: true, modVersion: "" }, T0); // r, a, f leased until T0+30s
  await q.result("a", { status: "accepted", ...ok }, T0 + 1);
  await q.result("f", { status: "applied", ...ok }, T0 + 2);
  await enqueueNew(q, "l", T0 + 10_000);
  await q.claim({ max: 5, ready: true, modVersion: "" }, T0 + 10_000); // l leased until T0+40s
  await enqueueNew(q, "p", T0 + 10_001); // never delivered
  await q.sweep(T0 + 35_000); // r's lease lapses: pending again, but the mod may hold it
  assertEquals(q.get("r")!.status, "pending");
  assertEquals(q.get("r")!.deliveries, 1);
  assertEquals(q.get("l")!.status, "leased");

  const c1 = await q.cancel("p", T0 + 35_001);
  assertEquals(c1.kind, "canceled");
  assertEquals(q.get("p")!.status, "canceled");
  assertEquals(q.get("p")!.reason, "canceled");

  for (const [id, status] of [["l", "leased"], ["a", "accepted"], ["r", "pending"]]) {
    const c = await q.cancel(id, T0 + 35_002);
    assertEquals(c.kind, "requested", `${id} may be held by the mod`);
    assertEquals(q.get(id)!.status, status, `${id} is not yanked — the mod is asked`);
    assertEquals(q.get(id)!.cancelRequested, true);
  }
  assertEquals((await q.cancel("r", T0 + 35_003)).kind, "requested", "idempotent");

  const ready = await q.claim({ max: 10, ready: true, modVersion: "" }, T0 + 35_004);
  assertEquals(ready.effects.length, 0, "a cancel-requested record is never re-leased");
  assertEquals(ready.cancels.sort(), ["a", "l", "r"]);
  const idle = await q.claim({ max: 10, ready: false, modVersion: "" }, T0 + 35_005);
  assertEquals(idle.cancels.sort(), ["a", "l", "r"], "cancels ride every claim, even not-ready ones");

  // the mod stands down → its rejected result makes it final; no longer listed
  await q.result("l", { status: "rejected", reason: "canceled", detail: "" }, T0 + 35_006);
  assertEquals((await q.claim({ max: 5, ready: false, modVersion: "" }, T0 + 35_007)).cancels.sort(), ["a", "r"]);
  // one the mod never got just times out (→ refund) — it is never delivered again
  const swept = await q.sweep(T0 + 600_000 + EXPIRY_GRACE_MS + 1);
  assertEquals(swept.map((r) => r.id).sort(), ["a", "r"]);
  assertEquals((await q.claim({ max: 5, ready: false, modVersion: "" }, T0 + 700_000)).cancels, []);

  const c4 = await q.cancel("f", T0 + 700_001);
  assertEquals(c4.kind, "final");
  assertEquals(q.get("f")!.status, "applied", "cancel never rewrites a final");
  assertEquals((await q.cancel("ghost", T0)).kind, "unknown");
});

Deno.test("cancel reason: stored, first one sticks, carried by an UNRUN final (outright / stand-down / sweeper)", async () => {
  const q = mkQueue();
  await heartbeat(q);
  for (const id of ["held", "late", "raced"]) await enqueueNew(q, id);
  await q.claim({ max: 3, ready: true, modVersion: "" }, T0); // all three leased
  await enqueueNew(q, "p1");
  await enqueueNew(q, "p2");

  // never delivered → canceled outright
  const c1 = await q.cancel("p1", T0 + 1, "fulfilled_externally");
  assert(c1.kind === "canceled");
  assertEquals(c1.record.cancelReason, "fulfilled_externally");
  assertEquals(q.get("p1")!.reason, "canceled", "the record's (lookup) reason is unchanged");
  assertEquals(effectResultEvent(c1.record, 1).reason, "fulfilled_externally");
  assertEquals((await q.cancel("p2", T0 + 1)).kind, "canceled");
  assertEquals(q.get("p2")!.cancelReason, "refunded", "no reason = refunded");

  // held by the mod → cancelRequested; a second cancel never rewrites the reason
  await q.cancel("held", T0 + 2, "fulfilled_externally");
  await q.cancel("held", T0 + 3, "manual");
  assertEquals(q.get("held")!.cancelReason, "fulfilled_externally");
  const rej = await q.result("held", { status: "rejected", reason: "canceled", detail: "" }, T0 + 4);
  assertEquals(effectResultEvent(rej.final!, 4).reason, "fulfilled_externally", "the mod's stand-down carries it");

  // the cancel lost the race — the mod had already run it: APPROVED, the mod's own reason
  await q.cancel("raced", T0 + 5, "refunded");
  const ran = await q.result("raced", { status: "applied", reason: "", detail: "Spun around" }, T0 + 6);
  const ev = effectResultEvent(ran.final!, 6);
  assertEquals([ev.status, ev.reason, ev.detail], ["applied", "", "Spun around"]);

  // one the mod never answers is swept expired — still the cancel's reason
  await q.cancel("late", T0 + 7, "timeout");
  const swept = await q.sweep(T0 + 600_000 + EXPIRY_GRACE_MS + 1);
  assertEquals(swept.map((r) => [r.id, r.status, effectResultEvent(r, 9).reason]), [["late", "expired", "timeout"]]);
  assertEquals(q.get("late")!.reason, "timeout", "(the record keeps the sweeper's own reason)");
});

Deno.test("health: lastPollAgoMs null before a poll, accepting window, ready only while fresh, counts", async () => {
  const q = mkQueue();
  assertEquals(q.health(T0), {
    ok: true,
    enabled: true,
    accepting: false,
    lastPollAgoMs: null,
    ready: false,
    open: 0,
    pending: 0,
  });
  await q.claim({ max: 1, ready: true, modVersion: "" }, T0);
  await enqueueNew(q, "a", T0 + 1);
  await enqueueNew(q, "b", T0 + 1);
  await q.claim({ max: 1, ready: true, modVersion: "" }, T0 + 2); // a leased
  const h = q.health(T0 + 10_002);
  assertEquals(h.accepting, true);
  assertEquals(h.lastPollAgoMs, 10_000);
  assertEquals(h.ready, true);
  assertEquals(h.open, 2);
  assertEquals(h.pending, 1);
  const stale = q.health(T0 + 2 + 45_001);
  assertEquals(stale.accepting, false, "no poll within the window");
  assertEquals(stale.ready, false, "a stale heartbeat is never reported ready");
  assertEquals(mkQueue({ enabled: false }).health(T0).enabled, false);
});

Deno.test("prune: finals dropped after 24h, open never; the hard cap drops the OLDEST finals first", async () => {
  const q = mkQueue({ maxOpen: 5000 });
  await heartbeat(q);
  await enqueueNew(q, "open-old");
  await enqueueNew(q, "final-old");
  await q.claim({ max: 10, ready: true, modVersion: "" }, T0);
  await q.result("final-old", { status: "applied", reason: "", detail: "" }, T0);
  await q.sweep(T0 + 1); // nothing old enough yet
  assert(q.get("final-old") !== undefined);
  // (open-old expired at T0+660s → it's a final "expired" from then on)
  await q.sweep(T0 + FINAL_RETAIN_MS + 1);
  assertEquals(q.get("final-old"), undefined, "a final older than 24h is pruned");
  assert(q.get("open-old") !== undefined, "open-old only just went final (expired) — kept");

  const cap = mkQueue({ maxOpen: 5000 });
  const t = T0 + 10;
  await heartbeat(cap, t);
  for (let i = 0; i < MAX_RECORDS; i++) await enqueueNew(cap, `f${i}`, t);
  await cap.claim({ max: 10, ready: true, modVersion: "" }, t);
  for (let i = 0; i < 10; i++) await cap.result(`f${i}`, { status: "applied", reason: "", detail: "" }, t);
  for (let i = 0; i < 5; i++) await enqueueNew(cap, `n${i}`, t);
  assertEquals(cap.list().length, MAX_RECORDS, "capped");
  for (let i = 0; i < 5; i++) assertEquals(cap.get(`f${i}`), undefined, `oldest final f${i} dropped`);
  assert(cap.get("f5") !== undefined, "only as many finals as needed are dropped");
  assert(cap.get("f10") !== undefined, "open records are never dropped");
  assert(cap.get("n4") !== undefined);
});

Deno.test("lookup: ≤50 ids, unknown omitted, reason/detail only when set", async () => {
  const q = mkQueue();
  await heartbeat(q);
  await enqueueNew(q, "a");
  await enqueueNew(q, "b");
  await q.claim({ max: 5, ready: true, modVersion: "" }, T0 + 1);
  await q.result("b", { status: "rejected", reason: "empty_hand", detail: "Nothing to drop" }, T0 + 2);
  assertEquals(await q.lookup(["a", "ghost", "b", "a"]), [
    { id: "a", status: "leased", updatedAt: T0 + 1 },
    { id: "b", status: "rejected", reason: "empty_hand", detail: "Nothing to drop", updatedAt: T0 + 2 },
  ]);
});

Deno.test("SSE events: redeem + effect_result carry the memo card's fields", async () => {
  const q = mkQueue();
  await heartbeat(q);
  await enqueueNew(q, "a", T0, { simulated: true });
  const rec = q.get("a") as EffectRecord;
  assertEquals(redeemEvent(rec, 5), {
    event: "redeem",
    ts: 5,
    id: "a",
    viewer: "Alice",
    reward: "Hop To It",
    effect: "force_jump",
    cost: 150,
    simulated: true,
  });
  const res = effectResultEvent({ ...rec, status: "rejected", reason: "airborne" }, 6);
  assertEquals(res.event, "effect_result");
  assertEquals(res.status, "rejected");
  assertEquals(res.reason, "airborne");
  assertEquals(res.detail, "", "absent detail is an empty string, never undefined");
});

// ---- persistence ----

async function tmpFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".tmp")) out.push(e.name);
  return out;
}

Deno.test("persistence round-trip: records survive a restart, leased → pending on boot, heartbeat does not", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-effects" });
  try {
    const q = mkQueue({ stateDir: dir });
    await heartbeat(q);
    await enqueueNew(q, "pend", T0, { params: { turns: 3 }, simulated: true });
    await enqueueNew(q, "lease");
    await enqueueNew(q, "acc");
    await enqueueNew(q, "done");
    await q.claim({ max: 3, ready: true, modVersion: "" }, T0 + 1); // pend, lease, acc leased
    await q.sweep(T0 + 31_000); // … back to pending
    await q.claim({ max: 3, ready: true, modVersion: "" }, T0 + 31_001); // FIFO: pend, lease, acc again (deliveries 2)
    await q.result("pend", { status: "accepted", reason: "", detail: "" }, T0 + 31_002);
    await q.cancel("pend", T0 + 31_003, "manual"); // accepted + cancelRequested
    await q.result("acc", { status: "accepted", reason: "", detail: "" }, T0 + 31_004);
    await q.claim({ max: 3, ready: true, modVersion: "" }, T0 + 31_005); // done leased
    await q.result("done", { status: "armed", reason: "", detail: "3 turns owed" }, T0 + 31_006);
    // no explicit flush: every transition is written through before it returns

    const doc = JSON.parse(await Deno.readTextFile(`${dir}/effects.json`));
    assertEquals(doc.version, 1);
    assertEquals(doc.effects.length, 4);
    assertEquals(await tmpFiles(dir), [], "no tmp file left behind");

    const q2 = mkQueue({ stateDir: dir });
    await q2.load();
    const pend = q2.get("pend")!;
    assertEquals(pend.status, "accepted");
    assertEquals(pend.cancelRequested, true);
    assertEquals(pend.cancelReason, "manual", "the cancel reason survives a restart");
    assertEquals(pend.params, { turns: 3 });
    assertEquals(pend.simulated, true);
    assertEquals(q2.get("lease")!.status, "pending", "leased reloads as pending (redelivered)");
    assertEquals(q2.get("lease")!.leaseUntil, undefined);
    assertEquals(q2.get("lease")!.deliveries, 2, "delivery count survives");
    assertEquals(q2.get("acc")!.status, "accepted");
    assertEquals(q2.get("done")!.status, "armed");
    assertEquals(q2.get("done")!.detail, "3 turns owed");
    assertEquals(q2.health(T0 + 31_010).lastPollAgoMs, null, "the heartbeat is in-memory only");
    assertEquals(q2.list().map((r) => r.id), ["done", "acc", "lease", "pend"], "FIFO order survives");

    // the reloaded pending one is claimable again once the mod polls
    const again = await q2.claim({ max: 5, ready: true, modVersion: "" }, T0 + 31_020);
    assertEquals(again.effects.map((e) => e.id), ["lease"]);
    assertEquals(again.cancels, ["pend"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("persistence: a corrupt effects.json is ignored (empty queue); bad records are skipped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-effects" });
  try {
    await Deno.writeTextFile(`${dir}/effects.json`, "{not json");
    const q = mkQueue({ stateDir: dir });
    await q.load();
    assertEquals(q.list().length, 0);

    await Deno.writeTextFile(
      `${dir}/effects.json`,
      JSON.stringify({
        version: 1,
        effects: [
          {
            id: "ok",
            effect: "potion",
            status: "pending",
            viewer: "v",
            reward: "r",
            createdAt: 1,
            expiresAt: 2,
            cancelReason: "vibes",
          },
          { id: "bad/id", effect: "potion", status: "pending" },
          { id: "bad-status", effect: "potion", status: "exploded" },
          "garbage",
        ],
      }),
    );
    const q2 = mkQueue({ stateDir: dir });
    await q2.load();
    assertEquals(q2.list().map((r) => r.id), ["ok"]);
    assertEquals(q2.get("ok")!.cancelReason, undefined, "an unknown cancelReason is dropped, not trusted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("persistence: concurrent write-through transitions serialize (no tmp rename race, nothing lost)", async () => {
  // Regression for the reproduced state.json races: many overlapping awaited
  // writes must all succeed (no NotFound on a shared .tmp) and the file must
  // end up with EVERY mutation (none dropped by a stale dirty flag).
  const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-effects" });
  try {
    const q = mkQueue({ stateDir: dir, maxOpen: 500 });
    await heartbeat(q);
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    const enq = await Promise.allSettled(ids.map((id) => q.enqueue(input(id), T0)));
    assertEquals(enq.filter((r) => r.status === "rejected").length, 0, "no overlapping write may fail");

    // interleave claims, results, cancels and duplicate enqueues — all in flight at once
    await q.claim({ max: 10, ready: true, modVersion: "" }, T0 + 1); // id-0..id-9 leased
    const mixed = await Promise.allSettled([
      ...ids.slice(0, 10).map((id, i) =>
        q.result(id, { status: i % 2 ? "applied" : "rejected", reason: "r", detail: "" }, T0 + 2)
      ),
      ...ids.slice(10, 20).map((id) => q.cancel(id, T0 + 3)),
      ...ids.slice(20, 30).map((id) => q.enqueue(input(id), T0 + 4)),
      q.claim({ max: 10, ready: true, modVersion: "" }, T0 + 5),
      q.sweep(T0 + 6),
    ]);
    assertEquals(mixed.filter((r) => r.status === "rejected").length, 0);
    await q.flush();

    const q2 = mkQueue({ stateDir: dir });
    await q2.load();
    assertEquals(q2.list().length, 60, "every enqueue is on disk");
    for (let i = 0; i < 10; i++) assertEquals(q2.get(`id-${i}`)!.status, i % 2 ? "applied" : "rejected");
    for (let i = 10; i < 20; i++) assertEquals(q2.get(`id-${i}`)!.status, "canceled");
    // id-20..29 were leased by the in-flight claim → reload as pending
    for (let i = 20; i < 30; i++) assertEquals(q2.get(`id-${i}`)!.status, "pending");
    assertEquals(await tmpFiles(dir), [], "no tmp file left behind");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- write-through failure (disk full / EIO) → rollback ----

// A stateDir whose "disk" can be pulled: moving the directory aside makes every
// write-through fail (NotFound on the tmp file) while the last durable
// effects.json sits untouched next door; heal() plugs it back in.
async function flakyDisk() {
  const root = await Deno.makeTempDir({ prefix: "cobblemon-overlay-effects" });
  const dir = `${root}/state`;
  await Deno.mkdir(dir);
  return {
    dir,
    fail: () => Deno.renameSync(dir, `${dir}.off`),
    heal: () => Deno.renameSync(`${dir}.off`, dir),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

async function rejects(p: Promise<unknown>, what: string): Promise<void> {
  try {
    await p;
  } catch {
    return;
  }
  throw new Error(`${what}: expected the write-through to fail`);
}

Deno.test("write-through failure: every transition rolls back — memory never runs ahead of disk", async () => {
  const disk = await flakyDisk();
  try {
    const q = mkQueue({ stateDir: disk.dir });
    const none = { reason: "", detail: "" };
    await heartbeat(q);
    await enqueueNew(q, "held");
    await enqueueNew(q, "fresh");
    await q.claim({ max: 1, ready: true, modVersion: "" }, T0); // held leased (durable)

    disk.fail();
    await rejects(q.enqueue(input("new1"), T0 + 1), "enqueue");
    assertEquals(q.get("new1"), undefined, "a new enqueue that isn't durable is gone again");
    await rejects(q.result("held", { status: "applied", reason: "", detail: "done" }, T0 + 2), "final result");
    await rejects(q.result("held", { status: "accepted", ...none }, T0 + 2), "accepted");
    assertEquals(q.get("held")!.status, "leased");
    assertEquals(q.get("held")!.detail, undefined);
    await rejects(q.cancel("fresh", T0 + 3, "manual"), "outright cancel");
    assertEquals(q.get("fresh")!.status, "pending", "a cancel that isn't durable is never reported");
    assertEquals(q.get("fresh")!.cancelReason, undefined);
    await rejects(q.cancel("held", T0 + 4, "fulfilled_externally"), "cancel request");
    assertEquals(q.get("held")!.cancelRequested, undefined);
    await rejects(q.claim({ max: 5, ready: true, modVersion: "" }, T0 + 5), "claim");
    assertEquals(q.get("fresh")!.status, "pending", "a lease that isn't durable is never handed out");
    assertEquals(q.get("fresh")!.deliveries, 0);
    assertEquals(q.health(T0 + 5).lastPollAgoMs, 0, "the (in-memory) heartbeat still counts");
    assertEquals(await q.sweep(T0 + 40_000), [], "a lapsed lease can't be persisted either");
    assertEquals(q.get("held")!.status, "leased");
    assertEquals(await q.sweep(T0 + 700_000), [], "no expiry is broadcast unless it is durable");
    assertEquals(q.get("fresh")!.status, "pending");
    // memory IS the durable state again, so reads keep answering through the outage
    const look = await q.lookup(["held", "fresh", "new1"]);
    assertEquals(look.map((e) => [e.id, e.status]), [["held", "leased"], ["fresh", "pending"]]);
    assertEquals((await q.enqueue(input("fresh"), T0 + 6)).kind, "dup");

    disk.heal();
    const q2 = mkQueue({ stateDir: disk.dir });
    await q2.load();
    assertEquals(
      q2.list().map((r) => [r.id, r.status, r.deliveries, r.cancelRequested ?? false]),
      [["fresh", "pending", 0, false], ["held", "pending", 1, false]],
      "the file never saw any of it (held: leased → pending on boot)",
    );
    // once the disk is back, every retry redoes its transition from scratch
    const fin = await q.result("held", { status: "applied", reason: "", detail: "done" }, T0 + 7);
    assert(fin.final !== null && !fin.ignored, "the retried result is a NEW final (→ broadcast), not ignored");
    const can = await q.cancel("fresh", T0 + 8, "manual");
    assert(can.kind === "canceled");
    assertEquals(can.record.cancelReason, "manual");
    assertEquals((await q.enqueue(input("new1"), T0 + 9)).kind, "new", "the retried enqueue is NEW (→ redeem memo)");
  } finally {
    await disk.cleanup();
  }
});

Deno.test("write-through failure: overlapping transitions on ONE record unwind to the durable state", async () => {
  // A per-record undo would restore the SECOND transition's pre-image
  // ("accepted") after the first restored "leased" — memory ahead of disk.
  const disk = await flakyDisk();
  try {
    const q = mkQueue({ stateDir: disk.dir });
    await heartbeat(q);
    await enqueueNew(q, "a");
    await q.claim({ max: 1, ready: true, modVersion: "" }, T0); // a leased (durable)
    disk.fail();
    const all = await Promise.allSettled([
      q.result("a", { status: "accepted", reason: "", detail: "" }, T0 + 1), // leased → accepted
      q.result("a", { status: "applied", reason: "", detail: "done" }, T0 + 2), // accepted → applied
      q.cancel("a", T0 + 3, "manual"), // (already final in memory: waits on the same write)
    ]);
    assertEquals(all.map((r) => r.status), ["rejected", "rejected", "rejected"]);
    const a = q.get("a")!;
    assertEquals([a.status, a.detail, a.cancelRequested], ["leased", undefined, undefined]);
    disk.heal();
  } finally {
    await disk.cleanup();
  }
});

Deno.test("lookup never vouches for a transition whose write is still in flight (and then fails)", async () => {
  const disk = await flakyDisk();
  try {
    const q = mkQueue({ stateDir: disk.dir });
    await heartbeat(q);
    await enqueueNew(q, "a");
    await q.claim({ max: 1, ready: true, modVersion: "" }, T0); // a leased (durable)
    disk.fail();
    const result = q.result("a", { status: "applied", reason: "", detail: "" }, T0 + 1); // in flight, will fail
    const look = q.lookup(["a"]); // taken while "applied" exists only in memory
    const [r1, r2] = await Promise.allSettled([result, look]);
    assertEquals(r1.status, "rejected");
    assertEquals(r2.status, "rejected", "multichat must not fulfil on a state that never landed");
    assertEquals((await q.lookup(["a"])).map((e) => e.status), ["leased"]);
    disk.heal();
  } finally {
    await disk.cleanup();
  }
});

Deno.test("write-through failure: a request landing just after the failure keeps its mutation (rollback race regression)", async () => {
  // Reproduced against the old code, where the rollback ran in #commit's catch
  // several microtask hops AFTER the writer went idle: an enqueue landing in
  // between started a NEW write carrying the doomed "A" plus its own "E", was
  // acked — then lost "E" to the rollback (memory [p], disk [p, A, E] with A's
  // caller failed). Pin the failure (the next open fails; its tmp cleanup parks
  // until released) and sweep E's landing point across it, one hop at a time.
  const fns = Deno as unknown as Record<string, unknown>;
  const realOpen = Deno.open;
  const realRemove = Deno.remove;
  const kinds = new Set<string>();
  for (let k = 0; k <= 14; k++) {
    const dir = await Deno.makeTempDir({ prefix: "cobblemon-overlay-effects" });
    try {
      const q = mkQueue({ stateDir: dir });
      await heartbeat(q);
      await enqueueNew(q, "p"); // durable before the failure
      const gate: { failOpen: boolean; release: (() => void) | null } = { failOpen: true, release: null };
      fns.open = (path: string | URL, options?: Deno.OpenOptions) => {
        if (!gate.failOpen) return realOpen(path, options);
        gate.failOpen = false;
        return Promise.reject(new Error("EIO (injected)"));
      };
      fns.remove = (path: string | URL, options?: Deno.RemoveOptions) => {
        if (gate.release !== null) return realRemove(path, options);
        return new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      };
      const kind = (p: Promise<{ kind: string }>) => p.then((o) => o.kind, (e) => `err:${isError(e) ? e.message : e}`);
      const a = kind(q.enqueue(input("A"), T0));
      for (let i = 0; i < 50 && gate.release === null; i++) await Promise.resolve();
      const release = gate.release;
      assert(release !== null, "A's failing write reached its tmp cleanup");
      release(); // A's write now finishes failing → the writer's rejection handler (rollback)
      let e = Promise.resolve("not run");
      let hop = Promise.resolve();
      for (let i = 0; i < k; i++) hop = hop.then(() => {});
      await hop.then(() => {
        e = kind(q.enqueue(input("E"), T0));
      });
      const [ra, re] = [await a, await e];
      fns.open = realOpen;
      fns.remove = realRemove;
      await q.flush();
      const mem = q.list().map((r) => r.id).reverse();
      const disk = JSON.parse(await Deno.readTextFile(`${dir}/effects.json`)).effects.map((r: EffectRecord) => r.id);
      assertEquals(ra, "err:EIO (injected)", `k=${k}: A's write failed → A's caller fails`);
      if (re === "new") assertEquals(mem, ["p", "E"], `k=${k}: E was acked → E is kept`);
      else assertEquals([re, mem], ["err:EIO (injected)", ["p"]], `k=${k}: E landed before the rollback → dropped + failed`);
      assertEquals(disk, mem, `k=${k}: disk == memory (never a failed caller's mutation on disk)`);
      const q2 = mkQueue({ stateDir: dir });
      await q2.load();
      assertEquals(q2.list().map((r) => r.id).reverse(), mem, `k=${k}: a restart comes back to the same queue`);
      kinds.add(re);
    } finally {
      fns.open = realOpen;
      fns.remove = realRemove;
      await Deno.remove(dir, { recursive: true });
    }
  }
  assertEquals([...kinds].sort(), ["err:EIO (injected)", "new"], "the sweep landed E on both sides of the failure");
});

Deno.test("SerialWriter.flush(upTo): a committer is failed only by the write that carries its generation", async () => {
  const disk = await flakyDisk();
  try {
    let renders = 0;
    let rollbacks = 0;
    const saved: string[] = [];
    const w = new SerialWriter(`${disk.dir}/doc.json`, () => {
      renders++;
      if (renders === 2) disk.fail(); // the disk dies just as the SECOND write starts
      return `render-${renders}`;
    }, { onSaved: (text) => saved.push(text), onFailed: () => rollbacks++ });
    const g1 = w.touch();
    const p1 = w.flush(g1); // write #1 (carries g1) in flight
    const g2 = w.touch(); // lands while #1 is in flight
    const p2 = w.flush(g2); // waits out #1, then write #2 (carries g2) — which fails
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    assertEquals(r1.status, "fulfilled", "g1 landed with write #1 — write #2's failure is not its failure");
    assertEquals(r2.status, "rejected");
    assertEquals(saved, ["render-1"], "onSaved sees exactly the text that landed");
    assertEquals(rollbacks, 1, "one failed write, one rollback");
    assert(!w.dirty, "(the owner rolled its state back to render-1) memory == disk again");
    await w.flush(); // nothing unsaved → no write, no failure on the dead disk
    assertEquals(renders, 2);
    disk.heal();
    w.touch();
    await w.flush();
    assertEquals(saved, ["render-1", "render-3"]);
    assertEquals(await Deno.readTextFile(`${disk.dir}/doc.json`), "render-3");
  } finally {
    await disk.cleanup();
  }
});

// A SerialWriter "disk" the test drives by hand: each write parks until the
// test lands it (ok) or fails it — so a failure's exact moment is pinned.
function heldWrites() {
  const io = {
    writes: [] as { text: string; ok: () => void; fail: (e: Error) => void }[],
    disk: "",
    write: (_path: string, text: string) =>
      new Promise<void>((resolve, reject) => {
        io.writes.push({
          text,
          ok: () => {
            io.disk = text;
            resolve();
          },
          fail: reject,
        });
      }),
  };
  return io;
}

// Let pending promise continuations run.
async function ticks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// "ok" / "err:<message>" — so a whole scenario settles before we assert.
function settled(p: Promise<unknown>): Promise<string> {
  return p.then(() => "ok", (e) => `err:${isError(e) ? e.message : String(e)}`);
}

Deno.test("SerialWriter onFailed: the rollback drops exactly the unsaved generations — never a request made after it", async () => {
  // An EffectQueue-shaped owner: memory = the committed mutations, and the
  // onFailed rollback restores the last text onSaved reported. Sweep the new
  // request `e` across every continuation slot after the failure (k = 0 is
  // the very first one — before the dropped callers have even looked).
  for (let k = 0; k <= 8; k++) {
    const io = heldWrites();
    const o = { mem: [] as string[], durable: "[]", rollbacks: 0 };
    const w = new SerialWriter("doc.json", () => JSON.stringify(o.mem), {
      onSaved: (text) => {
        o.durable = text;
      },
      onFailed: () => {
        o.rollbacks++;
        o.mem = JSON.parse(o.durable);
      },
      write: io.write,
    });
    const commit = (m: string) => {
      o.mem.push(m);
      return settled(w.flush(w.touch()));
    };
    const p = commit("p"); // write #1 ["p"] in flight
    const a = commit("a"); // waits it out, then write #2 carries it
    io.writes[0].ok();
    await ticks();
    assertEquals(io.writes.map((x) => x.text), ['["p"]', '["p","a"]'], `k=${k}: write #2 in flight`);
    const b = commit("b"); // touched while #2 is in flight — never rendered by it
    io.writes[1].fail(new Error("EIO"));
    let hop = Promise.resolve();
    for (let i = 0; i < k; i++) hop = hop.then(() => {});
    let e = Promise.resolve("not run");
    let late = Promise.resolve(["not run"]);
    await hop.then(() => {
      e = commit("e");
      if (k === 0) {
        // the dropped range is (1, 3]: p's generation is its lower bound —
        // saved before the failure → resolves; a's is inside → rejects
        late = Promise.all([settled(w.flush(1)), settled(w.flush(2))]);
      }
    });
    await ticks();
    assertEquals(io.writes.length, 3, `k=${k}: e gets a fresh write of its own (no retry of #2)`);
    assertEquals(io.writes[2].text, '["p","e"]', `k=${k}: …rendered from the rolled-back memory`);
    io.writes[2].ok();
    assertEquals(await p, "ok", `k=${k}: p was saved before the failure`);
    assertEquals([await a, await b], ["err:EIO", "err:EIO"], `k=${k}: every dropped caller fails`);
    assertEquals(await e, "ok", `k=${k}: the request after the rollback keeps its mutation`);
    if (k === 0) assertEquals(await late, ["ok", "err:EIO"]);
    assertEquals(o.mem, ["p", "e"], `k=${k}: memory`);
    assertEquals(JSON.parse(io.disk), o.mem, `k=${k}: disk == memory`);
    assertEquals(o.durable, io.disk, `k=${k}: the rollback baseline is what's on disk`);
    assertEquals(o.rollbacks, 1);
    assert(!w.dirty);
  }
});

Deno.test("SerialWriter without onFailed (state.json): a failed write rejects its waiters, stays dirty, no retry", async () => {
  const io = heldWrites();
  let doc = "v1";
  const w = new SerialWriter("doc.json", () => doc, { write: io.write });
  w.touch();
  const p1 = settled(w.flush()); // write #1 "v1" in flight
  doc = "v2";
  w.touch(); // lands mid-write
  const p2 = settled(w.flush()); // waits on #1
  io.writes[0].fail(new Error("EIO"));
  assertEquals([await p1, await p2], ["err:EIO", "err:EIO"], "every waiter sees the failed write");
  await ticks();
  assertEquals(io.writes.length, 1, "no hot retry: nothing is rewritten until the next flush");
  assert(w.dirty, "no rollback: everything stays dirty");
  const p3 = settled(w.flush());
  await ticks();
  assertEquals(io.writes.map((x) => x.text), ["v1", "v2"], "the next flush writes the latest state");
  io.writes[1].ok();
  assertEquals(await p3, "ok");
  assert(!w.dirty);
  assertEquals(io.disk, "v2");
});

Deno.test("sweeper timer: broadcasts expired records via onFinal, stops cleanly", async () => {
  const q = mkQueue();
  const past = Date.now() - 3_600_000;
  await heartbeat(q, past);
  await enqueueNew(q, "stale", past, { ttlSec: 30 });
  const finals: EffectRecord[] = [];
  const done = new Promise<void>((resolve) => {
    q.startTimers((rec) => {
      finals.push(rec);
      resolve();
    }, 5);
  });
  await done;
  q.stopTimers();
  assertEquals(finals.map((r) => [r.id, r.status, r.reason]), [["stale", "expired", "timeout"]]);
});

// ---- the HTTP contract (handleEffects; router auth/loopback lives in router_test.ts) ----

interface HubSpy {
  games: Record<string, unknown>[];
  broadcastGame(v: unknown): void;
}

function mkHub(): HubSpy {
  const spy: HubSpy = {
    games: [],
    broadcastGame(v) {
      spy.games.push(v as Record<string, unknown>);
    },
  };
  return spy;
}

function mkDeps(queue = mkQueue(), hub = mkHub(), now = T0) {
  return { queue, hub, token: "", effectsToken: "", maxBodyBytes: 65536, peerIp: "127.0.0.1", now: () => now };
}

function call(
  deps: ReturnType<typeof mkDeps>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`http://overlay.test${path}`);
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return handleEffects(new Request(url, init), url, deps);
}

const ENQ = { id: "r-1", effect: "potion", params: { effect: "darkness" }, viewer: "Alice", reward: "Lights Out", cost: 1000 };

Deno.test("HTTP POST /effects: 202 new (+ redeem broadcast), 200 dup, 503 disabled/game_offline, 429, 400, no-store", async () => {
  const hub = mkHub();
  const q = mkQueue({ maxOpen: 1 });
  const deps = mkDeps(q, hub);

  const offline = await call(deps, "POST", "/effects", ENQ);
  assertEquals(offline.status, 503);
  assertEquals(await offline.json(), { ok: false, reason: "game_offline" });
  assertEquals(offline.headers.get("cache-control"), "no-store");

  await heartbeat(q);
  const created = await call(deps, "POST", "/effects", ENQ);
  assertEquals(created.status, 202);
  assertEquals(await created.json(), { ok: true, status: "pending" });
  assertEquals(created.headers.get("cache-control"), "no-store");
  assertEquals(hub.games.length, 1);
  assertEquals(hub.games[0].event, "redeem");
  assertEquals(hub.games[0].viewer, "Alice");
  assertEquals(hub.games[0].reward, "Lights Out");

  const dup = await call(deps, "POST", "/effects", ENQ);
  assertEquals(dup.status, 200);
  assertEquals(await dup.json(), { ok: true, dup: true, status: "pending" });
  assertEquals(hub.games.length, 1, "a dup never re-broadcasts");

  const full = await call(deps, "POST", "/effects", { ...ENQ, id: "r-2" });
  assertEquals(full.status, 429);
  assertEquals(await full.json(), { ok: false, reason: "queue_full" });

  const bad = await call(deps, "POST", "/effects", { ...ENQ, viewer: "" });
  assertEquals(bad.status, 400);
  const badBody = await bad.json();
  assertEquals(badBody.ok, false);
  assertEquals(badBody.reason, "bad_request");
  assert(typeof badBody.error === "string" && badBody.error.length > 0);

  const notJson = await call(deps, "POST", "/effects", "{nope");
  assertEquals(notJson.status, 400);
  await notJson.body?.cancel();

  const big = await call({ ...deps, maxBodyBytes: 64 }, "POST", "/effects", { ...ENQ, pad: "x".repeat(500) });
  assertEquals(big.status, 413);
  await big.body?.cancel();

  const disabledQ = mkQueue({ enabled: false });
  await heartbeat(disabledQ);
  const disabled = await call(mkDeps(disabledQ), "POST", "/effects", ENQ);
  assertEquals(disabled.status, 503);
  assertEquals(await disabled.json(), { ok: false, reason: "disabled" });
});

Deno.test("HTTP claim + result: lease reply shape, final → effect_result broadcast, final/unknown → 200 ignored", async () => {
  const hub = mkHub();
  const q = mkQueue();
  const deps = mkDeps(q, hub);
  await heartbeat(q);
  await call(deps, "POST", "/effects", ENQ).then((r) => r.body?.cancel());

  const claim = await call(deps, "POST", "/effects/claim", { max: 3, ready: true, modVersion: "0.9" });
  assertEquals(claim.status, 200);
  assertEquals(claim.headers.get("cache-control"), "no-store");
  assertEquals(await claim.json(), {
    ok: true,
    effects: [{
      id: "r-1",
      effect: "potion",
      params: { effect: "darkness" },
      viewer: "Alice",
      reward: "Lights Out",
      simulated: false,
      expiresInMs: 600_000,
    }],
    cancels: [],
  });

  const acc = await call(deps, "POST", "/effects/r-1/result", { status: "accepted" });
  assertEquals(await acc.json(), { ok: true, status: "accepted" });
  assertEquals(hub.games.length, 1, "accepted is not a final transition (only the redeem so far)");

  const fin = await call(deps, "POST", "/effects/r-1/result", { status: "applied", detail: "Lights out for 20s" });
  assertEquals(await fin.json(), { ok: true, status: "applied" });
  assertEquals(hub.games.length, 2);
  assertEquals(hub.games[1].event, "effect_result");
  assertEquals(hub.games[1].status, "applied");
  assertEquals(hub.games[1].detail, "Lights out for 20s");
  assertEquals(hub.games[1].viewer, "Alice");

  const again = await call(deps, "POST", "/effects/r-1/result", { status: "rejected", reason: "error" });
  assertEquals(again.status, 200, "a result for a final record is NEVER a 4xx");
  assertEquals(await again.json(), { ok: true, ignored: true, status: "applied" });
  assertEquals(hub.games.length, 2);

  const unknown = await call(deps, "POST", "/effects/ghost/result", { status: "applied" });
  assertEquals(unknown.status, 200);
  assertEquals(await unknown.json(), { ok: true, ignored: true, status: "unknown" });
  const weird = await call(deps, "POST", "/effects/bad.id/result", { status: "applied" });
  assertEquals(await weird.json(), { ok: true, ignored: true, status: "unknown" });

  const malformed = await call(deps, "POST", "/effects/r-1/result", { status: "done" });
  assertEquals(malformed.status, 400, "only a malformed body is a 400");
  await malformed.body?.cancel();
  const badClaim = await call(deps, "POST", "/effects/claim", "[");
  assertEquals(badClaim.status, 400);
  await badClaim.body?.cancel();
});

Deno.test("HTTP cancel / lookup / health + method and path errors", async () => {
  const hub = mkHub();
  const q = mkQueue();
  const deps = mkDeps(q, hub);
  await heartbeat(q);
  for (const id of ["a", "b"]) await call(deps, "POST", "/effects", { ...ENQ, id }).then((r) => r.body?.cancel());
  await q.claim({ max: 1, ready: true, modVersion: "" }, T0); // a leased

  const pend = await call(deps, "POST", "/effects/b/cancel");
  assertEquals(await pend.json(), { ok: true, status: "canceled" });
  assertEquals(hub.games.at(-1)!.event, "effect_result", "pending → canceled resolves the memo card");
  assertEquals(hub.games.at(-1)!.status, "canceled");
  const held = await call(deps, "POST", "/effects/a/cancel");
  assertEquals(await held.json(), { ok: true, status: "leased", cancelRequested: true });
  const fin = await call(deps, "POST", "/effects/b/cancel");
  assertEquals(await fin.json(), { ok: true, status: "canceled" });
  const unknown = await call(deps, "POST", "/effects/ghost/cancel");
  assertEquals(unknown.status, 404);
  assertEquals(await unknown.json(), { ok: false, reason: "unknown" });

  const look = await call(deps, "GET", "/effects?ids=a,b,ghost");
  assertEquals(look.headers.get("cache-control"), "no-store");
  const lj = await look.json();
  assertEquals(lj.ok, true);
  const pairs = lj.effects.map((e: { id: string; status: string }) => [e.id, e.status]);
  assertEquals(pairs, [["a", "leased"], ["b", "canceled"]], "unknown ids omitted");
  const none = await call(deps, "GET", "/effects");
  assertEquals(await none.json(), { ok: true, effects: [] });
  const tooMany = await call(deps, "GET", "/effects?ids=" + Array.from({ length: 51 }, (_, i) => `x${i}`).join(","));
  assertEquals(tooMany.status, 400);
  await tooMany.body?.cancel();

  const health = await call(deps, "GET", "/effects/health");
  assertEquals(await health.json(), {
    ok: true,
    enabled: true,
    accepting: true,
    lastPollAgoMs: 0,
    ready: true, // the last poll (the claim above) reported ready
    open: 1,
    pending: 0,
  });

  for (
    const [method, path, status] of [
      ["PUT", "/effects", 405],
      ["GET", "/effects/claim", 405],
      ["GET", "/effects/a/result", 405],
      ["GET", "/effects/a/cancel", 405],
      ["POST", "/effects/health", 405],
      ["GET", "/effects/a", 404],
      ["POST", "/effects/a/b/c", 404],
    ] as const
  ) {
    const r = await call(deps, method, path);
    assertEquals(r.status, status, `${method} ${path}`);
    await r.body?.cancel();
  }
});

Deno.test("HTTP cancel {reason?}: stored + carried by the effect_result; parsed leniently — a bad body is never a 4xx", async () => {
  const hub = mkHub();
  const q = mkQueue();
  const deps = mkDeps(q, hub);
  await heartbeat(q);
  const cases: [string, unknown, string][] = [
    ["x1", { reason: "fulfilled_externally" }, "fulfilled_externally"],
    ["x2", { reason: "manual" }, "manual"],
    ["x3", { reason: "timeout" }, "timeout"],
    ["x4", { reason: "refunded" }, "refunded"],
    ["x5", undefined, "refunded"], // no body at all
    ["x6", {}, "refunded"],
    ["x7", { reason: "vibes" }, "refunded"],
    ["x8", "{not json", "refunded"],
    ["x9", [1, 2], "refunded"],
  ];
  for (const [id] of cases) await call(deps, "POST", "/effects", { ...ENQ, id }).then((r) => r.body?.cancel());
  for (const [id, body, want] of cases) {
    const res = await call(deps, "POST", `/effects/${id}/cancel`, body);
    assertEquals(res.status, 200, `${id} ${JSON.stringify(body)}`);
    assertEquals(await res.json(), { ok: true, status: "canceled" });
    const ev = hub.games.at(-1)!;
    assertEquals([ev.event, ev.id, ev.status, ev.reason], ["effect_result", id, "canceled", want]);
    assertEquals(q.get(id)!.cancelReason, want);
  }
  // an oversized body is still a cancel ("refunded"), never a 413
  await call(deps, "POST", "/effects", { ...ENQ, id: "big" }).then((r) => r.body?.cancel());
  const bigBody = { reason: "manual", pad: "x".repeat(99) };
  const big = await call({ ...deps, maxBodyBytes: 16 }, "POST", "/effects/big/cancel", bigBody);
  assertEquals(big.status, 200);
  await big.body?.cancel();
  assertEquals(q.get("big")!.cancelReason, "refunded");
  // a cancel-requested record's eventual stand-down carries the reason too
  await call(deps, "POST", "/effects", { ...ENQ, id: "held" }).then((r) => r.body?.cancel());
  await q.claim({ max: 1, ready: true, modVersion: "" }, T0);
  const req = await call(deps, "POST", "/effects/held/cancel", { reason: "fulfilled_externally" });
  assertEquals(await req.json(), { ok: true, status: "leased", cancelRequested: true });
  const standDown = { status: "rejected", reason: "canceled" };
  await call(deps, "POST", "/effects/held/result", standDown).then((r) => r.body?.cancel());
  const ev = hub.games.at(-1)!;
  assertEquals([ev.id, ev.status, ev.reason], ["held", "rejected", "fulfilled_externally"]);
});

Deno.test("HTTP: a failed write-through is 500 persist_failed with no broadcast; the retry that lands broadcasts", async () => {
  const disk = await flakyDisk();
  try {
    const hub = mkHub();
    const q = mkQueue({ stateDir: disk.dir });
    const deps = mkDeps(q, hub);
    await heartbeat(q);

    // multichat's enqueue
    disk.fail();
    const enq = await call(deps, "POST", "/effects", ENQ);
    assertEquals(enq.status, 500);
    assertEquals(await enq.json(), { ok: false, reason: "persist_failed" });
    assertEquals(enq.headers.get("cache-control"), "no-store");
    assertEquals(hub.games.length, 0, "no memo for a redemption that isn't durable");
    assertEquals(await (await call(deps, "GET", "/effects?ids=r-1")).json(), { ok: true, effects: [] });
    disk.heal();
    const enq2 = await call(deps, "POST", "/effects", ENQ);
    assertEquals(enq2.status, 202, "the retry is NEW — not a dup that would skip the memo");
    await enq2.body?.cancel();
    assertEquals(hub.games.map((g) => g.event), ["redeem"]);

    // the mod's final result
    await call(deps, "POST", "/effects/claim", { ready: true }).then((r) => r.body?.cancel());
    disk.fail();
    const res = await call(deps, "POST", "/effects/r-1/result", { status: "applied", detail: "Lights out" });
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { ok: false, reason: "persist_failed" });
    assertEquals(hub.games.length, 1);
    disk.heal();
    const res2 = await call(deps, "POST", "/effects/r-1/result", { status: "applied", detail: "Lights out" });
    assertEquals(await res2.json(), { ok: true, status: "applied" }, "not ignored — the first attempt never landed");
    assertEquals(hub.games.map((g) => g.event), ["redeem", "effect_result"]);

    // multichat's cancel
    await call(deps, "POST", "/effects", { ...ENQ, id: "r-2" }).then((r) => r.body?.cancel());
    disk.fail();
    const can = await call(deps, "POST", "/effects/r-2/cancel", { reason: "manual" });
    assertEquals(can.status, 500);
    await can.body?.cancel();
    const lj = await (await call(deps, "GET", "/effects?ids=r-2")).json();
    const statuses = lj.effects.map((e: { status: string }) => e.status);
    assertEquals(statuses, ["pending"], "a cancel that isn't durable is never reported");
    disk.heal();
    const can2 = await call(deps, "POST", "/effects/r-2/cancel", { reason: "manual" });
    assertEquals(await can2.json(), { ok: true, status: "canceled" });
    const last = hub.games.at(-1)!;
    assertEquals([last.event, last.id, last.status, last.reason], ["effect_result", "r-2", "canceled", "manual"]);

    // the mod's claim: nothing is handed out unless the lease is durable
    await call(deps, "POST", "/effects", { ...ENQ, id: "r-3" }).then((r) => r.body?.cancel());
    disk.fail();
    const claim = await call(deps, "POST", "/effects/claim", { ready: true });
    assertEquals(claim.status, 500);
    await claim.body?.cancel();
    disk.heal();
    const claim2 = await call(deps, "POST", "/effects/claim", { ready: true });
    assertEquals((await claim2.json()).effects.map((e: { id: string }) => e.id), ["r-3"]);
    assertEquals(q.get("r-3")!.deliveries, 1, "the failed claim never counted as a delivery");
  } finally {
    await disk.cleanup();
  }
});
