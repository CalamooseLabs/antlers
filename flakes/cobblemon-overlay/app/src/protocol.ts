// protocol.ts — THE v1 WIRE CONTRACT with the mod's streamsync subsystem.
// KEEP IN SYNC with the-cobblemon-initiative's `streamsync` (Part A of the plan).
//
// One JSON document per POST /ingest. Envelope: `v:1`, `type:"snapshot"|"event"`,
// `session` (UUID minted per SERVER_STARTED), `seq` (monotonic long per session),
// `t` (mod-side epoch ms — INFORMATIONAL ONLY: staleness always uses the server's
// receive time, never `t`). The overlay dedups on per-session lastSeq; a new
// session id resets tracking.
//
// Validation is STRICT on the envelope and the event discriminator, and
// TOLERANT of unknown fields (ignored) and missing inner fields (defaulted) —
// the mod may drop individual fields (unverified Cobblemon accessors) and that
// must never break ingest. ZERO external imports.

export const PROTOCOL_VERSION = 1;

export type LossCause = "faint" | "sacrifice" | "duplicate_release";
export type WhiteoutReason = "faint" | "flee" | "forfeit";

const LOSS_CAUSES: readonly string[] = ["faint", "sacrifice", "duplicate_release"];
const WHITEOUT_REASONS: readonly string[] = ["faint", "flee", "forfeit"];

export type EventName =
  | "pokemon_lost"
  | "capture"
  | "whiteout"
  | "badge"
  | "trainer_defeated"
  | "level_cap"
  | "session_start"
  | "session_stop";

const EVENT_NAMES: readonly string[] = [
  "pokemon_lost",
  "capture",
  "whiteout",
  "badge",
  "trainer_defeated",
  "level_cap",
  "session_start",
  "session_stop",
];

export interface WorldInfo {
  day: number;
  timeOfDay: number;
  playtimeTicks: number;
}

export interface QuestInfo {
  name: string;
  stage: string;
}

export interface ProgressInfo {
  badges: number;
  levelCap: number;
  nextLevelCap: number;
  trainersDefeated: number;
}

export interface DeathCounters {
  total: number;
  whiteouts: number;
  sacrifices: number;
  duplicateReleases: number;
}

export interface PartyMember {
  slot: number;
  uuid: string;
  species: string; // e.g. "cobblemon:pikachu" or "pikachu" — sprites.ts maps it
  dex: number; // national dex number (sprite fallback key); 0 = unknown
  name: string; // nickname — PLAYER CONTROLLED, must be escaped before HTML
  level: number;
  hp: number;
  maxHp: number;
  fainted: boolean;
  shiny: boolean;
  gender: string;
  heldItem: string; // "" = none/unknown
}

// The pokemon reference carried by pokemon_lost / capture events.
export interface PokemonRef {
  species: string;
  dex: number;
  name: string; // nickname — PLAYER CONTROLLED
  level: number;
  shiny: boolean;
}

export interface BaseMsg {
  v: 1;
  session: string;
  seq: number;
  t: number; // mod clock, informational only
}

export interface SnapshotMsg extends BaseMsg {
  type: "snapshot";
  player: string;
  worldId: string | null; // UUID minted once per save; null on old-protocol pushes
  world: WorldInfo | null;
  location: string; // zone name — PLAYER/DATA CONTROLLED, escape it
  party: PartyMember[]; // ≤ 6
  deaths: DeathCounters; // per-SAVE counters (the mod is source of truth here)
  progress: ProgressInfo;
  quest: QuestInfo | null;
}

export interface EventMsg extends BaseMsg {
  type: "event";
  event: EventName;
  // pokemon_lost
  cause?: LossCause;
  deathsTotal?: number;
  // pokemon_lost / capture
  pokemon?: PokemonRef;
  // whiteout
  reason?: WhiteoutReason;
  // badge
  badgeId?: string;
  badges?: number;
  // trainer_defeated
  trainerId?: string;
  trainerName?: string;
  category?: string;
  // level_cap
  cap?: number;
  // session_start
  modVersion?: string;
  protocol?: number;
}

export type Message = SnapshotMsg | EventMsg;

export type ParseResult = { ok: true; msg: Message } | { ok: false; error: string };

// ---- tolerant coercers (exported for reuse in state.ts restore) ----

export function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}

export function bool(v: unknown, d = false): boolean {
  return typeof v === "boolean" ? v : d;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function zeroDeaths(): DeathCounters {
  return { total: 0, whiteouts: 0, sacrifices: 0, duplicateReleases: 0 };
}

export function zeroProgress(): ProgressInfo {
  return { badges: 0, levelCap: 0, nextLevelCap: 0, trainersDefeated: 0 };
}

export function coerceDeaths(v: unknown): DeathCounters {
  const d = obj(v) ?? {};
  return {
    total: num(d.total),
    whiteouts: num(d.whiteouts),
    sacrifices: num(d.sacrifices),
    duplicateReleases: num(d.duplicateReleases),
  };
}

export function coerceProgress(v: unknown): ProgressInfo {
  const p = obj(v) ?? {};
  return {
    badges: num(p.badges),
    levelCap: num(p.levelCap),
    nextLevelCap: num(p.nextLevelCap),
    trainersDefeated: num(p.trainersDefeated),
  };
}

export function coercePartyMember(v: unknown, index = 0): PartyMember | null {
  const m = obj(v);
  if (!m) return null;
  const species = str(m.species);
  if (!species) return null; // species is the one required member field
  return {
    slot: num(m.slot, index),
    uuid: str(m.uuid),
    species,
    dex: num(m.dex),
    name: str(m.name),
    level: num(m.level),
    hp: num(m.hp),
    maxHp: num(m.maxHp),
    fainted: bool(m.fainted),
    shiny: bool(m.shiny),
    gender: str(m.gender),
    heldItem: str(m.heldItem),
  };
}

function coercePokemonRef(v: unknown): PokemonRef | null {
  const m = obj(v);
  if (!m) return null;
  const species = str(m.species);
  if (!species) return null;
  return { species, dex: num(m.dex), name: str(m.name), level: num(m.level), shiny: bool(m.shiny) };
}

function err(error: string): ParseResult {
  return { ok: false, error };
}

// ---- the validator ----

export function parseMessage(raw: unknown): ParseResult {
  const o = obj(raw);
  if (!o) return err("body is not a JSON object");
  if (o.v !== PROTOCOL_VERSION) {
    return err(`unsupported protocol version ${JSON.stringify(o.v ?? null)} (want ${PROTOCOL_VERSION})`);
  }
  const session = str(o.session);
  if (!session) return err("missing/invalid session");
  if (typeof o.seq !== "number" || !Number.isFinite(o.seq) || o.seq < 0) {
    return err("missing/invalid seq");
  }
  const base = { v: PROTOCOL_VERSION as 1, session, seq: o.seq, t: num(o.t) };

  if (o.type === "snapshot") {
    const party: PartyMember[] = [];
    if (Array.isArray(o.party)) {
      for (const rawMember of o.party) {
        const m = coercePartyMember(rawMember, party.length);
        if (m) party.push(m);
        if (party.length >= 6) break; // party[≤6] per contract
      }
    }
    const w = obj(o.world);
    const q = obj(o.quest);
    const questName = q ? str(q.name) : "";
    const msg: SnapshotMsg = {
      ...base,
      type: "snapshot",
      player: str(o.player),
      worldId: str(o.worldId) || null,
      world: w ? { day: num(w.day), timeOfDay: num(w.timeOfDay), playtimeTicks: num(w.playtimeTicks) } : null,
      location: str(o.location),
      party,
      deaths: coerceDeaths(o.deaths),
      progress: coerceProgress(o.progress),
      quest: questName
        ? { name: questName, stage: typeof q!.stage === "number" ? String(q!.stage) : str(q!.stage) }
        : null,
    };
    return { ok: true, msg };
  }

  if (o.type === "event") {
    const name = str(o.event);
    if (!EVENT_NAMES.includes(name)) return err(`unknown event ${JSON.stringify(o.event ?? null)}`);
    const event = name as EventName;
    const msg: EventMsg = { ...base, type: "event", event };

    switch (event) {
      case "pokemon_lost": {
        const cause = o.cause === undefined || o.cause === null ? "faint" : o.cause;
        if (typeof cause !== "string" || !LOSS_CAUSES.includes(cause)) {
          return err(`invalid pokemon_lost cause ${JSON.stringify(o.cause)}`);
        }
        const pokemon = coercePokemonRef(o.pokemon);
        if (!pokemon) return err("pokemon_lost missing pokemon.species");
        msg.cause = cause as LossCause;
        msg.pokemon = pokemon;
        if (typeof o.deathsTotal === "number" && Number.isFinite(o.deathsTotal) && o.deathsTotal >= 0) {
          msg.deathsTotal = o.deathsTotal;
        }
        break;
      }
      case "capture": {
        const pokemon = coercePokemonRef(o.pokemon);
        if (!pokemon) return err("capture missing pokemon.species");
        msg.pokemon = pokemon;
        break;
      }
      case "whiteout": {
        const reason = o.reason === undefined || o.reason === null ? "faint" : o.reason;
        if (typeof reason !== "string" || !WHITEOUT_REASONS.includes(reason)) {
          return err(`invalid whiteout reason ${JSON.stringify(o.reason)}`);
        }
        msg.reason = reason as WhiteoutReason;
        break;
      }
      case "badge": {
        msg.badgeId = str(o.badgeId);
        if (typeof o.badges === "number" && Number.isFinite(o.badges)) msg.badges = o.badges;
        break;
      }
      case "trainer_defeated": {
        msg.trainerId = str(o.trainerId);
        msg.trainerName = str(o.trainerName);
        msg.category = str(o.category);
        break;
      }
      case "level_cap": {
        if (typeof o.cap !== "number" || !Number.isFinite(o.cap)) {
          return err("level_cap missing/invalid cap");
        }
        msg.cap = o.cap;
        break;
      }
      case "session_start": {
        msg.modVersion = str(o.modVersion);
        msg.protocol = num(o.protocol, PROTOCOL_VERSION);
        break;
      }
      case "session_stop":
        break;
    }
    return { ok: true, msg };
  }

  return err(`unknown type ${JSON.stringify(o.type ?? null)}`);
}
