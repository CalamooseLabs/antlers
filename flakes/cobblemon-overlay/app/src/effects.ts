// Channel-point effect queue: the durable hand-off between multichat (Twitch
// redemptions, over loopback) and The Cobblemon Initiative mod (which claims
// and executes them on its own poll thread). ZERO external imports.
//
// Wire protocol v1 gains nothing for this — the mod's pusher wedges on any
// 4xx, so there are no new ingest event names and no `v` bump (an event name
// /ingest doesn't know is acked + ignored). Effects ride their own routes (all
// JSON, Cache-Control: no-store):
//
//   multichat-facing — the TCP peer MUST be loopback, plus
//   `Authorization: Bearer <effectsToken>` when one is configured:
//     POST /effects              enqueue {id, effect, params?, viewer, viewerLogin?,
//                                reward, cost?, simulated?, ttlSec?}
//     GET  /effects?ids=a,b,…    status lookup (≤50 ids; unknown ids omitted)
//     POST /effects/<id>/cancel  {reason?} — undelivered pending → canceled; otherwise → cancelRequested
//     GET  /effects/health       {enabled, accepting, lastPollAgoMs, ready, open, pending}
//   mod-facing — the ingest token rule (Bearer or X-Overlay-Token; open when
//   no token is configured), NOT loopback-gated (the mod is on battlestation):
//     POST /effects/claim        heartbeat + lease up to `max` pending effects
//     POST /effects/<id>/result  accepted | applied | armed | rejected | expired
//   EVERY /effects route first refuses a browser page (an Origin header, or a
//   Sec-Fetch-Site other than none/same-origin) with 403 forbidden — neither
//   caller ever sends those.
//
// The idempotency key end-to-end is the Twitch redemption id. State machine:
//
//   pending ──claim──▶ leased ──result:accepted──▶ accepted ──result:final──▶ applied|armed|rejected|expired
//      ▲                 │   (a leased — or re-pended — record also takes a result directly)
//      └─lease expiry────┘   (leaseSec; redelivered, the mod dedups by id)
//   pending (never delivered) ──cancel──▶ canceled;  leased|accepted — or pending again after a
//   lapsed lease/restart — + cancel → cancelRequested (sent in claim.cancels, never re-leased)
//   (pending|leased|accepted) and now > expiresAt + 60s grace ──sweeper──▶ expired ("timeout")
//
// Final states never change: a result for a FINAL record (or an unknown id)
// is a 200 {ignored} — never a 4xx, so the mod's results outbox can't wedge.
// Finals are kept 24h (multichat's lookup + /status), then pruned; hard cap
// MAX_RECORDS (oldest finals first — open records are never dropped).
//
// Durability: every transition is written through to stateDir/effects.json
// (util.ts SerialWriter: serialized, unique tmp + fsync + rename) and AWAITED
// before the HTTP reply, so an acked enqueue/claim/result/cancel survives a
// crash. A write that FAILS (disk full, EIO) rolls the in-memory queue back to
// exactly the last durable state and fails the request (500 persist_failed):
// memory never runs ahead of disk, so a lookup/claim can't act on a transition
// a restart would forget, and the caller's retry redoes the transition — SSE
// broadcast included — from scratch. Lookups wait until what they report is
// durable. On boot, leased records go back to pending (redelivered; the mod
// dedups by id). The mod's heartbeat (lastPollAt/ready) is in-memory only —
// after a restart the overlay is "game_offline" until the mod polls again.

import { readBodyLimited } from "./ingest.ts";
import type { SseHub } from "./sse.ts";
import { checkToken, isBrowserCrossOrigin, isError, isLoopbackIp, json, log, SerialWriter } from "./util.ts";

export const EFFECT_STATUSES = [
  "pending",
  "leased",
  "accepted",
  "applied",
  "armed",
  "rejected",
  "expired",
  "canceled",
] as const;
export type EffectStatus = typeof EFFECT_STATUSES[number];

// applied/armed ⇒ Twitch FULFILLED; rejected/expired/canceled ⇒ CANCELED (refund).
const FINAL_STATUSES: ReadonlySet<string> = new Set(["applied", "armed", "rejected", "expired", "canceled"]);
// The finals where nothing ran (the effect_result carries a cancel's reason).
const UNRUN_STATUSES: ReadonlySet<string> = new Set(["rejected", "expired", "canceled"]);
// What the mod may report via /effects/<id>/result.
const RESULT_STATUSES: ReadonlySet<string> = new Set(["accepted", "applied", "armed", "rejected", "expired"]);

export function isFinal(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

// Why multichat canceled (POST /effects/<id>/cancel {reason?}): `refunded` (a
// Twitch-queue reject — also the default), `fulfilled_externally` (a Twitch-
// queue COMPLETE: the viewer's points are spent and nothing runs — the memo
// reads CLOSED, never REFUNDED), `manual` (`multichat rewards refund`),
// `timeout` (multichat's own deadline).
export const CANCEL_REASONS = ["refunded", "fulfilled_externally", "manual", "timeout"] as const;
export type CancelReason = typeof CANCEL_REASONS[number];

function isCancelReason(v: unknown): v is CancelReason {
  return typeof v === "string" && (CANCEL_REASONS as readonly string[]).includes(v);
}

export const EXPIRY_GRACE_MS = 60_000; // sweeper backstop past expiresAt
export const FINAL_RETAIN_MS = 24 * 3600_000;
export const MAX_RECORDS = 1000;
export const MAX_LOOKUP_IDS = 50;
export const SWEEP_INTERVAL_MS = 5000;
export const TTL_MIN_SEC = 30;
export const TTL_MAX_SEC = 3600;

// Redemption ids are Twitch UUIDs (simulated: "sim-<uuid>") — they appear in
// URL path segments, so keep them to a charset that never needs encoding.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Wire effect ids (drop_held_item, potion, …). The MOD is the authority on
// which exist (unknown → rejected "unknown_effect" → refund); this is shape only.
const EFFECT_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface EffectRecord {
  id: string; // Twitch redemption id — the idempotency key
  effect: string;
  params: Record<string, unknown>; // passed through to the mod verbatim
  viewer: string; // Twitch display name — VIEWER CONTROLLED, escape it
  viewerLogin: string;
  reward: string; // reward title — escape it
  cost: number;
  simulated: boolean; // `multichat rewards simulate` — runs for real, never billed
  createdAt: number; // server clock
  expiresAt: number; // server clock (the mod gets a RELATIVE expiresInMs)
  status: EffectStatus;
  leaseUntil?: number; // leased only
  deliveries: number; // how many times a claim handed it to the mod
  reason?: string; // mod / sweeper reason code — escape it
  detail?: string; // mod-provided human detail — escape it
  updatedAt: number;
  cancelRequested?: boolean;
  cancelReason?: CancelReason; // set by the first cancel; the effect_result's reason if nothing ran
}

// ---- request parsing (pure; unit-tested) ----

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function err<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

// Strip control characters, trim, and cap — for every free-text field that
// ends up in logs, /status, and the on-stream memo cards.
function clean(s: string, max: number): string {
  // deno-lint-ignore no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function isEffectId(s: unknown): s is string {
  return typeof s === "string" && ID_RE.test(s);
}

export interface EnqueueInput {
  id: string;
  effect: string;
  params: Record<string, unknown>;
  viewer: string;
  viewerLogin: string;
  reward: string;
  cost: number;
  simulated: boolean;
  ttlSec: number | null; // null = the configured default
}

export function parseEnqueue(raw: unknown): Parsed<EnqueueInput> {
  const o = asObject(raw);
  if (!o) return err("body must be a JSON object");
  if (!isEffectId(o.id)) return err("id must match [A-Za-z0-9_-]{1,128}");
  if (typeof o.effect !== "string" || !EFFECT_RE.test(o.effect)) {
    return err("effect must be a lowercase effect id");
  }
  let params: Record<string, unknown> = {};
  if (o.params !== undefined && o.params !== null) {
    const p = asObject(o.params);
    if (!p) return err("params must be a JSON object");
    params = p;
  }
  const viewer = typeof o.viewer === "string" ? clean(o.viewer, 64) : "";
  if (!viewer) return err("viewer is required");
  const reward = typeof o.reward === "string" ? clean(o.reward, 100) : "";
  if (!reward) return err("reward is required");
  if (o.viewerLogin !== undefined && typeof o.viewerLogin !== "string") {
    return err("viewerLogin must be a string");
  }
  if (o.cost !== undefined && (typeof o.cost !== "number" || !Number.isFinite(o.cost) || o.cost < 0)) {
    return err("cost must be a number >= 0");
  }
  if (o.simulated !== undefined && typeof o.simulated !== "boolean") {
    return err("simulated must be a boolean");
  }
  if (o.ttlSec !== undefined && o.ttlSec !== null && (typeof o.ttlSec !== "number" || !Number.isFinite(o.ttlSec))) {
    return err("ttlSec must be a number");
  }
  return {
    ok: true,
    value: {
      id: o.id,
      effect: o.effect,
      params,
      viewer,
      viewerLogin: typeof o.viewerLogin === "string" ? clean(o.viewerLogin, 64) : "",
      reward,
      cost: typeof o.cost === "number" ? Math.floor(o.cost) : 0,
      simulated: o.simulated === true,
      ttlSec: typeof o.ttlSec === "number" ? o.ttlSec : null,
    },
  };
}

export interface ClaimInput {
  max: number; // 1..10
  ready: boolean;
  modVersion: string;
}

// Lenient by design (the mod's poll must never wedge on a 4xx): an absent or
// out-of-range `max` clamps to 1..10 (default 3), a non-true `ready` is false.
export function parseClaim(raw: unknown): Parsed<ClaimInput> {
  const o = asObject(raw);
  if (!o) return err("body must be a JSON object");
  const m = typeof o.max === "number" && Number.isFinite(o.max) ? Math.floor(o.max) : 3;
  return {
    ok: true,
    value: {
      max: Math.min(10, Math.max(1, m)),
      ready: o.ready === true,
      modVersion: typeof o.modVersion === "string" ? clean(o.modVersion, 64) : "",
    },
  };
}

export interface ResultInput {
  status: "accepted" | "applied" | "armed" | "rejected" | "expired";
  reason: string; // ≤64
  detail: string; // ≤160
}

// Only a missing/unknown status is malformed (400). An over-long reason/detail
// is TRUNCATED, not refused — a 4xx would make the mod drop an applied result.
export function parseResult(raw: unknown): Parsed<ResultInput> {
  const o = asObject(raw);
  if (!o) return err("body must be a JSON object");
  if (typeof o.status !== "string" || !RESULT_STATUSES.has(o.status)) {
    return err("status must be one of accepted|applied|armed|rejected|expired");
  }
  return {
    ok: true,
    value: {
      status: o.status as ResultInput["status"],
      reason: typeof o.reason === "string" ? clean(o.reason, 64) : "",
      detail: typeof o.detail === "string" ? clean(o.detail, 160) : "",
    },
  };
}

// The cancel body, parsed LENIENTLY: an absent/empty/oversized (null) body,
// invalid JSON, a non-object, or an unknown reason all mean "refunded" — a
// cancel is NEVER refused over its body (a refused cancel could let a refunded
// effect run on stream).
export function parseCancelReason(body: string | null): CancelReason {
  if (!body) return "refunded";
  try {
    const reason = asObject(JSON.parse(body))?.reason;
    return isCancelReason(reason) ? reason : "refunded";
  } catch {
    return "refunded";
  }
}

// ---- SSE `game` events (the /overlay/redeems memo cards) ----

export function redeemEvent(rec: EffectRecord, ts: number): Record<string, unknown> {
  return {
    event: "redeem",
    ts,
    id: rec.id,
    viewer: rec.viewer,
    reward: rec.reward,
    effect: rec.effect,
    cost: rec.cost,
    simulated: rec.simulated,
  };
}

// A canceled record — outright, or cancel-requested and then rejected by the
// mod / expired by the sweeper — carries the CANCEL's reason, so the memo can
// tell a refund from a Twitch-side completion (`fulfilled_externally` → CLOSED).
// One that ran anyway (applied/armed) keeps the mod's own reason.
export function effectResultEvent(rec: EffectRecord, ts: number): Record<string, unknown> {
  const reason = rec.cancelReason && UNRUN_STATUSES.has(rec.status) ? rec.cancelReason : rec.reason ?? "";
  return {
    event: "effect_result",
    ts,
    id: rec.id,
    viewer: rec.viewer,
    reward: rec.reward,
    effect: rec.effect,
    status: rec.status,
    reason,
    detail: rec.detail ?? "",
    simulated: rec.simulated,
  };
}

// ---- the queue ----

export interface EffectQueueOpts {
  stateDir: string; // "" = persistence disabled (dev/test only)
  enabled: boolean;
  leaseSec: number;
  ttlSec: number; // default when an enqueue carries no ttlSec
  acceptWindowSec: number;
  maxOpen: number;
}

export interface EffectHealth {
  ok: true;
  enabled: boolean;
  accepting: boolean;
  lastPollAgoMs: number | null;
  ready: boolean;
  open: number;
  pending: number;
}

export type EnqueueOutcome =
  | { kind: "new" | "dup"; record: EffectRecord }
  | { kind: "disabled" | "game_offline" | "queue_full" };

export interface ClaimedEffect {
  id: string;
  effect: string;
  params: Record<string, unknown>;
  viewer: string;
  reward: string;
  simulated: boolean;
  expiresInMs: number; // RELATIVE — the two hosts' clocks differ
}

export interface ClaimOutcome {
  effects: ClaimedEffect[];
  cancels: string[];
}

export interface ResultOutcome {
  status: string; // the record's status after the call ("unknown" for an unknown id)
  ignored: boolean;
  final: EffectRecord | null; // set when THIS call made the record final (→ broadcast)
}

export type CancelOutcome =
  | { kind: "unknown" }
  | { kind: "canceled" | "requested" | "final"; record: EffectRecord };

export interface EffectLookup {
  id: string;
  status: EffectStatus;
  reason?: string;
  detail?: string;
  updatedAt: number;
}

function copy(rec: EffectRecord): EffectRecord {
  return { ...rec, params: { ...rec.params } };
}

function posNum(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : def;
}

function num(v: unknown, def = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

// Tolerant restore of one persisted record; null = unusable (skipped).
function coerceRecord(raw: unknown): EffectRecord | null {
  const o = asObject(raw);
  if (!o || !isEffectId(o.id) || typeof o.effect !== "string") return null;
  const status = o.status;
  if (typeof status !== "string" || !(EFFECT_STATUSES as readonly string[]).includes(status)) return null;
  const rec: EffectRecord = {
    id: o.id,
    effect: o.effect,
    params: asObject(o.params) ?? {},
    viewer: typeof o.viewer === "string" ? o.viewer : "",
    viewerLogin: typeof o.viewerLogin === "string" ? o.viewerLogin : "",
    reward: typeof o.reward === "string" ? o.reward : "",
    cost: num(o.cost),
    simulated: o.simulated === true,
    createdAt: num(o.createdAt),
    expiresAt: num(o.expiresAt),
    status: status as EffectStatus,
    deliveries: Math.max(0, Math.floor(num(o.deliveries))),
    updatedAt: num(o.updatedAt),
  };
  if (typeof o.leaseUntil === "number") rec.leaseUntil = o.leaseUntil;
  if (typeof o.reason === "string" && o.reason) rec.reason = o.reason;
  if (typeof o.detail === "string" && o.detail) rec.detail = o.detail;
  if (o.cancelRequested === true) rec.cancelRequested = true;
  if (isCancelReason(o.cancelReason)) rec.cancelReason = o.cancelReason;
  return rec;
}

// An effects.json document → its usable records, in file (= FIFO) order.
// Throws on invalid JSON (load() reports that as a corrupt file).
function parseDoc(text: string): EffectRecord[] {
  const doc = asObject(JSON.parse(text));
  const out: EffectRecord[] = [];
  for (const raw of doc && Array.isArray(doc.effects) ? doc.effects : []) {
    const rec = coerceRecord(raw);
    if (rec) out.push(rec);
  }
  return out;
}

export class EffectQueue {
  #opts: EffectQueueOpts;
  #leaseMs: number;
  #ttlSec: number;
  #acceptWindowMs: number;
  #maxOpen: number;

  // insertion order = enqueue order = the FIFO claims lease from
  #records = new Map<string, EffectRecord>();

  // the mod's heartbeat (in-memory only)
  #lastPollAt = 0;
  #ready = false;
  #modVersion = "";

  #writer: SerialWriter;
  // effects.json as of the last write that LANDED (or as restored at boot; ""
  // = empty) — what a failed write-through rolls memory back to.
  #durable = "";
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #sweeping = false;

  constructor(opts: EffectQueueOpts) {
    this.#opts = opts;
    // config.json is merged unvalidated — clamp to sane values here.
    this.#leaseMs = posNum(opts.leaseSec, 30) * 1000;
    this.#ttlSec = Math.min(TTL_MAX_SEC, Math.max(TTL_MIN_SEC, posNum(opts.ttlSec, 600)));
    this.#acceptWindowMs = posNum(opts.acceptWindowSec, 45) * 1000;
    this.#maxOpen = Math.floor(posNum(opts.maxOpen, 100));
    this.#writer = new SerialWriter(this.path, () => this.#render(), {
      onSaved: (text) => {
        this.#durable = text;
      },
      onFailed: (e) => this.#rollback(e),
    });
  }

  #render(): string {
    return JSON.stringify({ version: 1, savedAt: Date.now(), effects: [...this.#records.values()] });
  }

  get path(): string {
    return this.#opts.stateDir ? `${this.#opts.stateDir}/effects.json` : "";
  }

  get enabled(): boolean {
    return this.#opts.enabled;
  }

  get modVersion(): string {
    return this.#modVersion;
  }

  // Enqueues are accepted only while the mod is demonstrably polling.
  accepting(now: number): boolean {
    return this.#opts.enabled && this.#lastPollAt > 0 && now - this.#lastPollAt <= this.#acceptWindowMs;
  }

  health(now: number): EffectHealth {
    let open = 0;
    let pending = 0;
    for (const r of this.#records.values()) {
      if (!isFinal(r.status)) open++;
      if (r.status === "pending") pending++;
    }
    const accepting = this.accepting(now);
    return {
      ok: true,
      enabled: this.#opts.enabled,
      accepting,
      lastPollAgoMs: this.#lastPollAt > 0 ? Math.max(0, now - this.#lastPollAt) : null,
      // the mod's last-reported readiness, only while its heartbeat is fresh
      ready: this.#ready && this.#lastPollAt > 0 && now - this.#lastPollAt <= this.#acceptWindowMs,
      open,
      pending,
    };
  }

  get(id: string): EffectRecord | undefined {
    const r = this.#records.get(id);
    return r ? copy(r) : undefined;
  }

  // Every record, newest first (the /status table).
  list(): EffectRecord[] {
    return [...this.#records.values()].reverse().map(copy);
  }

  // multichat's status poll. The answer is taken NOW and returned only once
  // everything in it is durable (it waits out an in-flight write-through; a
  // failed one throws → 500, after the rollback) — so multichat never fulfils
  // or refunds on a transition a restart would forget.
  async lookup(ids: string[]): Promise<EffectLookup[]> {
    const out: EffectLookup[] = [];
    for (const id of new Set(ids)) {
      const r = this.#records.get(id);
      if (!r) continue;
      out.push({
        id: r.id,
        status: r.status,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.detail ? { detail: r.detail } : {}),
        updatedAt: r.updatedAt,
      });
    }
    await this.#writer.flush();
    return out;
  }

  // multichat → queue. A KNOWN id is always a dup (checked before the gates,
  // so a retried POST whose reply was lost can never be refused and refunded
  // while the original is still queued).
  async enqueue(input: EnqueueInput, now: number): Promise<EnqueueOutcome> {
    const known = this.#records.get(input.id);
    if (known) {
      const record = copy(known);
      await this.#writer.flush(); // a racing first POST's write must be durable before we ack
      return { kind: "dup", record };
    }
    if (!this.#opts.enabled) return { kind: "disabled" };
    if (!this.accepting(now)) return { kind: "game_offline" };
    if (this.#openCount() >= this.#maxOpen) return { kind: "queue_full" };
    const ttlSec = input.ttlSec === null
      ? this.#ttlSec
      : Math.min(TTL_MAX_SEC, Math.max(TTL_MIN_SEC, input.ttlSec));
    const rec: EffectRecord = {
      id: input.id,
      effect: input.effect,
      params: input.params,
      viewer: input.viewer,
      viewerLogin: input.viewerLogin,
      reward: input.reward,
      cost: input.cost,
      simulated: input.simulated,
      createdAt: now,
      expiresAt: now + ttlSec * 1000,
      status: "pending",
      deliveries: 0,
      updatedAt: now,
    };
    this.#records.set(rec.id, rec);
    this.#prune(now);
    log("info", "effect enqueued", {
      id: rec.id,
      effect: rec.effect,
      viewer: rec.viewer,
      reward: rec.reward,
      simulated: rec.simulated,
      ttlSec,
    });
    const record = copy(rec);
    await this.#commit();
    return { kind: "new", record };
  }

  // mod → queue: heartbeat + lease. Leases are persisted BEFORE the reply
  // hands them over (a failed write rolls them back and hands out nothing — the
  // heartbeat, in-memory only, still counts); cancels are always included,
  // even when not ready.
  async claim(input: ClaimInput, now: number): Promise<ClaimOutcome> {
    this.#lastPollAt = now;
    this.#ready = input.ready;
    if (input.modVersion) this.#modVersion = input.modVersion;
    const leased: EffectRecord[] = [];
    if (input.ready && this.#opts.enabled) {
      for (const rec of this.#records.values()) {
        if (leased.length >= input.max) break;
        // never hand out what multichat asked to cancel (a re-pended record
        // whose cancel is still being relayed via `cancels`)
        if (rec.status !== "pending" || rec.cancelRequested || now > rec.expiresAt) continue;
        rec.status = "leased";
        rec.leaseUntil = now + this.#leaseMs;
        rec.deliveries += 1;
        rec.updatedAt = now;
        leased.push(rec);
      }
    }
    if (leased.length) {
      log("info", "effects leased", {
        ids: leased.map((r) => r.id),
        redeliveries: leased.filter((r) => r.deliveries > 1).length,
      });
      await this.#commit();
    }
    const cancels: string[] = [];
    for (const rec of this.#records.values()) {
      if (rec.cancelRequested && !isFinal(rec.status)) cancels.push(rec.id);
    }
    return {
      effects: leased.map((r) => ({
        id: r.id,
        effect: r.effect,
        params: { ...r.params },
        viewer: r.viewer,
        reward: r.reward,
        simulated: r.simulated,
        expiresInMs: Math.max(0, r.expiresAt - now),
      })),
      cancels,
    };
  }

  // mod → queue: one result. Any OPEN record takes it (a late result after a
  // lease expiry still lands); a final record or an unknown id is ignored.
  async result(id: string, input: ResultInput, now: number): Promise<ResultOutcome> {
    const rec = this.#records.get(id);
    if (!rec) {
      log("warn", "effect result for an unknown id ignored", { id, status: input.status });
      return { status: "unknown", ignored: true, final: null };
    }
    if (isFinal(rec.status)) {
      const status = rec.status;
      await this.#writer.flush(); // the ack lets the mod drop it from its outbox
      return { status, ignored: true, final: null };
    }
    if (input.status === "accepted") {
      if (rec.status === "accepted") {
        await this.#writer.flush();
        return { status: "accepted", ignored: false, final: null };
      }
      rec.status = "accepted";
      delete rec.leaseUntil;
      rec.updatedAt = now;
      log("info", "effect accepted by the mod", { id });
      await this.#commit();
      return { status: "accepted", ignored: false, final: null };
    }
    rec.status = input.status;
    delete rec.leaseUntil;
    if (input.reason) rec.reason = input.reason;
    if (input.detail) rec.detail = input.detail;
    rec.updatedAt = now;
    log("info", "effect resolved", {
      id,
      effect: rec.effect,
      status: rec.status,
      reason: rec.reason ?? "",
      detail: rec.detail ?? "",
    });
    const final = copy(rec);
    await this.#commit();
    return { status: final.status, ignored: false, final };
  }

  // multichat → queue: cancel (a Twitch-side cancel/fulfil or a manual refund).
  // Only a NEVER-delivered pending record is canceled outright. One the mod may
  // hold — leased, accepted, or pending again after a lapsed lease / a restart
  // (deliveries > 0) — gets cancelRequested instead: it is relayed in every
  // claim's `cancels`, never re-leased, and made final by the mod's own
  // rejection (or the sweeper), so it can't be applied on stream after its
  // cancel was acked as final. The FIRST cancel's `reason` sticks (a retried
  // cancel is idempotent) and becomes the effect_result's reason if nothing ran.
  async cancel(id: string, now: number, reason: CancelReason = "refunded"): Promise<CancelOutcome> {
    const rec = this.#records.get(id);
    if (!rec) return { kind: "unknown" };
    if (isFinal(rec.status)) {
      const record = copy(rec);
      await this.#writer.flush();
      return { kind: "final", record };
    }
    if (rec.status === "pending" && rec.deliveries === 0) {
      rec.status = "canceled";
      rec.reason = "canceled";
      rec.cancelReason = reason;
      delete rec.leaseUntil;
      rec.updatedAt = now;
      log("info", "effect canceled", { id, reason });
      const record = copy(rec);
      await this.#commit();
      return { kind: "canceled", record };
    }
    // possibly held by the mod — ask it to stand down (claim.cancels)
    if (!rec.cancelRequested || !rec.cancelReason) {
      rec.cancelRequested = true;
      rec.cancelReason ??= reason; // (a record persisted before cancel reasons existed takes this one)
      rec.updatedAt = now;
      log("info", "effect cancel requested", { id, status: rec.status, reason: rec.cancelReason });
      const record = copy(rec);
      await this.#commit();
      return { kind: "requested", record };
    }
    const record = copy(rec);
    await this.#writer.flush();
    return { kind: "requested", record };
  }

  // Timed transitions (the 5s timer; tests call it with an injected clock):
  // lease expiry → pending, open past expiresAt + grace → expired "timeout",
  // then prune. Returns the records that just went final (for the SSE
  // effect_result broadcast). A persist failure is logged, not thrown: the
  // sweep's transitions are rolled back with the rest of the non-durable state
  // and nothing is returned (no broadcast) — the next tick redoes them.
  async sweep(now: number): Promise<EffectRecord[]> {
    const finals: EffectRecord[] = [];
    let changed = false;
    for (const rec of this.#records.values()) {
      if (isFinal(rec.status)) continue;
      if (now > rec.expiresAt + EXPIRY_GRACE_MS) {
        rec.status = "expired";
        rec.reason = "timeout";
        delete rec.leaseUntil;
        rec.updatedAt = now;
        finals.push(copy(rec));
        changed = true;
        log("warn", "effect expired unresolved", { id: rec.id, effect: rec.effect, deliveries: rec.deliveries });
      } else if (rec.status === "leased" && rec.leaseUntil !== undefined && now >= rec.leaseUntil) {
        rec.status = "pending";
        delete rec.leaseUntil;
        rec.updatedAt = now;
        changed = true;
        log("warn", "effect lease expired — back to pending", { id: rec.id, deliveries: rec.deliveries });
      }
    }
    if (this.#prune(now)) changed = true;
    if (changed) {
      try {
        await this.#commit();
      } catch {
        return []; // (#rollback logged it and rolled back)
      }
    }
    return finals;
  }

  startTimers(onFinal: (rec: EffectRecord) => void, intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.#sweepTimer !== null) return;
    this.#sweepTimer = setInterval(() => {
      if (this.#sweeping) return; // a slow disk must not stack sweeps
      this.#sweeping = true;
      this.sweep(Date.now())
        .then((finals) => {
          for (const rec of finals) onFinal(rec);
        })
        .catch((e) => log("error", "effects sweep failed", { err: isError(e) ? e.message : String(e) }))
        .finally(() => {
          this.#sweeping = false;
        });
    }, intervalMs);
  }

  stopTimers(): void {
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
  }

  // Wait until everything mutated so far is on disk (the SIGTERM/SIGINT path).
  async flush(): Promise<void> {
    await this.#writer.flush();
  }

  // Restore from effects.json. Leased records go back to pending: the overlay
  // can't know whether the mod got the claim reply, so they're redelivered
  // (the mod dedups by id). A corrupt file means an empty queue (multichat's
  // own deadline then refunds whatever was in flight).
  async load(): Promise<void> {
    const path = this.path;
    if (!path) return;
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      return; // fresh boot — nothing persisted yet
    }
    try {
      let requeued = 0;
      for (const rec of parseDoc(text)) {
        if (this.#records.has(rec.id)) continue;
        if (rec.status === "leased") {
          rec.status = "pending";
          delete rec.leaseUntil;
          requeued++;
        }
        this.#records.set(rec.id, rec);
      }
      log("info", "effects restored", { path, records: this.#records.size, open: this.#openCount(), requeued });
    } catch (e) {
      log("error", "corrupt effects.json ignored (starting empty)", {
        path,
        err: isError(e) ? e.message : String(e),
      });
    }
    // the rollback baseline: what a restart right now would come back up with
    this.#durable = this.#render();
  }

  #openCount(): number {
    let n = 0;
    for (const r of this.#records.values()) if (!isFinal(r.status)) n++;
    return n;
  }

  // Drop finals older than FINAL_RETAIN_MS, then (hard cap) the oldest finals
  // until at most MAX_RECORDS remain. Open records are never dropped — each is
  // still owed an outcome. Returns whether anything was removed.
  #prune(now: number): boolean {
    let removed = false;
    for (const [id, rec] of this.#records) {
      if (isFinal(rec.status) && now - rec.updatedAt > FINAL_RETAIN_MS) {
        this.#records.delete(id);
        removed = true;
      }
    }
    if (this.#records.size > MAX_RECORDS) {
      for (const [id, rec] of this.#records) {
        if (this.#records.size <= MAX_RECORDS) break;
        if (isFinal(rec.status)) {
          this.#records.delete(id);
          removed = true;
        }
      }
    }
    return removed;
  }

  // Write-through: make THIS mutation durable before the caller replies (touch
  // and flush in one synchronous step — exact attribution, see SerialWriter).
  // It rejects (→ 500) exactly when a failed write dropped this mutation in the
  // rollback below — never because of a failure after it landed.
  async #commit(): Promise<void> {
    await this.#writer.flush(this.#writer.touch());
  }

  // The writer's onFailed hook: a write-through FAILED. It runs synchronously
  // inside that write's rejection — before any request can mutate or start a
  // write again — and puts memory back to exactly the last durable state. Every
  // mutation it drops (incl. one made while the write was in flight) belongs to
  // a caller the writer then fails, and a request landing right after it is
  // written on its own, so nothing acked is ever lost and disk never holds a
  // transition whose caller got a 500; each failed caller's retry redoes its
  // transition — broadcast included — from scratch. Memory == disk again, so
  // lookups keep answering through an outage. (Rolling back the whole queue,
  // not one record, stays correct when several in-flight transitions touched
  // the same record.)
  #rollback(e: unknown): void {
    this.#records.clear();
    for (const rec of this.#durable ? parseDoc(this.#durable) : []) this.#records.set(rec.id, rec);
    log("error", "effects write-through failed — queue rolled back to the last durable state", {
      err: isError(e) ? e.message : String(e),
      records: this.#records.size,
    });
  }
}

// ---- HTTP (router.ts dispatches every /effects path here) ----

export interface EffectsDeps {
  queue: EffectQueue;
  hub: Pick<SseHub, "broadcastGame">;
  token: string; // the ingest token ("" = none) — gates the mod-facing routes
  effectsToken: string; // "" = loopback alone gates the multichat-facing routes
  maxBodyBytes: number;
  peerIp: string; // RAW socket peer (Deno.serve info.remoteAddr); "" = unknown → refused
  now?: () => number; // injectable clock for tests
}

const NO_STORE = { "cache-control": "no-store" };

function reply(data: unknown, status = 200): Response {
  return json(data, status, NO_STORE);
}

function fail(status: number, reason: string, error?: string): Response {
  return reply({ ok: false, reason, ...(error ? { error } : {}) }, status);
}

// Body cap (413) → JSON parse (400). The parsed value, or the error Response.
async function readJson(req: Request, deps: EffectsDeps, what: string): Promise<{ raw: unknown } | Response> {
  const body = await readBodyLimited(req, deps.maxBodyBytes);
  if (body === null) return fail(413, "too_large", "body too large");
  try {
    return { raw: JSON.parse(body) };
  } catch {
    log("warn", `${what} rejected: invalid JSON`, { body: body.slice(0, 200) });
    return fail(400, "bad_request", "invalid JSON");
  }
}

// A queue call whose write-through failed (disk full, EIO) → 500
// persist_failed. The queue already rolled memory back to the last durable
// state, so the caller's retry (multichat and the mod both retry a 5xx) redoes
// the transition — and the SSE broadcast this attempt skipped.
async function persisted<T>(what: string, op: Promise<T>): Promise<T | Response> {
  try {
    return await op;
  } catch (e) {
    log("error", `${what} failed: effects.json not written`, { err: isError(e) ? e.message : String(e) });
    return fail(500, "persist_failed");
  }
}

export async function handleEffects(req: Request, url: URL, deps: EffectsDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const rest = url.pathname === "/effects" ? "" : url.pathname.slice("/effects/".length);
  const parts = rest === "" ? [] : rest.split("/");

  // Browser-origin hardening, ahead of every other check on EVERY route:
  // neither caller (multichat's Deno fetch, the mod's Java HttpClient) sends
  // Origin or Sec-Fetch-Site, while a page in a browser on this host always
  // sends Origin on a cross-site POST — the loopback gate alone can't tell.
  if (isBrowserCrossOrigin(req)) {
    log("warn", "effects route refused: browser origin", {
      path: url.pathname,
      origin: (req.headers.get("origin") ?? "").slice(0, 100),
      site: (req.headers.get("sec-fetch-site") ?? "").slice(0, 32),
    });
    return fail(403, "forbidden");
  }

  // ---- mod-facing: POST /effects/claim, POST /effects/<id>/result ----
  const isClaim = parts.length === 1 && parts[0] === "claim";
  const isResult = parts.length === 2 && parts[1] === "result";
  if (isClaim || isResult) {
    if (req.method !== "POST") return fail(405, "method_not_allowed");
    if (!checkToken(req, deps.token)) return fail(401, "unauthorized");
    const got = await readJson(req, deps, isClaim ? "effects claim" : "effect result");
    if (got instanceof Response) return got;
    if (isClaim) {
      const parsed = parseClaim(got.raw);
      if (!parsed.ok) return fail(400, "bad_request", parsed.error);
      const out = await persisted("effects claim", deps.queue.claim(parsed.value, now));
      if (out instanceof Response) return out;
      return reply({ ok: true, effects: out.effects, cancels: out.cancels });
    }
    const parsed = parseResult(got.raw);
    if (!parsed.ok) {
      log("warn", "effect result rejected", { id: parts[0], error: parsed.error });
      return fail(400, "bad_request", parsed.error);
    }
    // An id that can't exist is just another unknown id: ignored, never a 4xx.
    if (!isEffectId(parts[0])) return reply({ ok: true, ignored: true, status: "unknown" });
    const out = await persisted("effect result", deps.queue.result(parts[0], parsed.value, now));
    if (out instanceof Response) return out;
    if (out.final) deps.hub.broadcastGame(effectResultEvent(out.final, now));
    return reply(out.ignored ? { ok: true, ignored: true, status: out.status } : { ok: true, status: out.status });
  }

  // ---- multichat-facing: /effects, /effects/health, /effects/<id>/cancel ----
  const isRoot = parts.length === 0;
  const isHealth = parts.length === 1 && parts[0] === "health";
  const isCancel = parts.length === 2 && parts[1] === "cancel";
  if (!isRoot && !isHealth && !isCancel) return fail(404, "not_found");
  const methodOk = isRoot
    ? req.method === "POST" || req.method === "GET"
    : req.method === (isHealth ? "GET" : "POST");
  if (!methodOk) return fail(405, "method_not_allowed");
  // multichat lives on this host: the RAW socket peer must be loopback (the
  // broadcast host's LAN firewall pin does not cover these routes).
  if (!isLoopbackIp(deps.peerIp)) {
    log("warn", "effects route refused: non-loopback peer", { path: url.pathname, peer: deps.peerIp });
    return fail(403, "forbidden");
  }
  if (!checkToken(req, deps.effectsToken, { bearerOnly: true })) return fail(401, "unauthorized");

  if (isHealth) return reply(deps.queue.health(now));

  if (isCancel) {
    // {reason?} — lenient: no body / a bad one / an unknown reason = "refunded"
    // (never a 4xx: a refused cancel could let a refunded effect run)
    const reason = parseCancelReason(await readBodyLimited(req, deps.maxBodyBytes).catch(() => null));
    if (!isEffectId(parts[0])) return fail(404, "unknown");
    const out = await persisted("effect cancel", deps.queue.cancel(parts[0], now, reason));
    if (out instanceof Response) return out;
    if (out.kind === "unknown") return fail(404, "unknown");
    if (out.kind === "canceled") {
      deps.hub.broadcastGame(effectResultEvent(out.record, now));
      return reply({ ok: true, status: out.record.status });
    }
    if (out.kind === "requested") return reply({ ok: true, status: out.record.status, cancelRequested: true });
    return reply({ ok: true, status: out.record.status });
  }

  if (req.method === "GET") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > MAX_LOOKUP_IDS) return fail(400, "bad_request", `at most ${MAX_LOOKUP_IDS} ids`);
    const effects = await persisted("effects lookup", deps.queue.lookup(ids));
    if (effects instanceof Response) return effects;
    return reply({ ok: true, effects });
  }

  // POST /effects — enqueue
  const got = await readJson(req, deps, "effect enqueue");
  if (got instanceof Response) return got;
  const parsed = parseEnqueue(got.raw);
  if (!parsed.ok) {
    log("warn", "effect enqueue rejected", { error: parsed.error });
    return fail(400, "bad_request", parsed.error);
  }
  const out = await persisted("effect enqueue", deps.queue.enqueue(parsed.value, now));
  if (out instanceof Response) return out;
  switch (out.kind) {
    case "dup":
      return reply({ ok: true, dup: true, status: out.record.status });
    case "new":
      deps.hub.broadcastGame(redeemEvent(out.record, now));
      return reply({ ok: true, status: "pending" }, 202);
    case "queue_full":
      log("warn", "effect enqueue refused", { id: parsed.value.id, reason: out.kind });
      return fail(429, "queue_full");
    default:
      log("warn", "effect enqueue refused", { id: parsed.value.id, reason: out.kind });
      return fail(503, out.kind);
  }
}
