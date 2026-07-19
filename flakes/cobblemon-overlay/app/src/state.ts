// In-memory overlay state + campaign persistence. ZERO external imports.
//
// Responsibilities:
//  - per-session seq dedup (new session id resets tracking);
//  - the current snapshot (party, counters, progress, …) + `lastIngestAt`,
//    which is ALWAYS the server receive time (never the mod's `t` field) —
//    staleness derives from it;
//  - ATTEMPT TRACKING: each distinct `worldId` is one hardcore attempt. A new
//    worldId banks the previous save's death counters into the campaign totals
//    and increments `attempt`; a counter DECREASE is the fallback detector for
//    old-protocol pushes that carry no worldId;
//  - the MEMORIAL list (the cemetery's data): every NEWLY-accepted pokemon_lost
//    appends {kind:"pokemon", name, species, dex, level, cause, attempt, ts} and
//    every NEWLY-accepted whiteout appends a {kind:"player"} grave for the
//    TRAINER (name from the latest snapshot, cause = the whiteout reason) —
//    persisted forever across saves and restarts. Dedup'd events never
//    double-append (the seq gate runs before any mutation). Entries persisted
//    before "kind" existed load as kind:"pokemon" (backward compat);
//  - debounced (~2s) ATOMIC persistence to stateDir/state.json (tmp file +
//    Deno.rename), flushed on SIGTERM/SIGINT by main.ts; restored on boot with
//    lastIngestAt = 0, so the overlay is stale until the mod pushes again.

import {
  bool,
  coerceDeaths,
  coercePartyMember,
  coerceProgress,
  type DeathCounters,
  type EventMsg,
  type LossCause,
  type Message,
  num,
  type PartyMember,
  type ProgressInfo,
  type QuestInfo,
  type SnapshotMsg,
  str,
  type WhiteoutReason,
  type WorldInfo,
  zeroDeaths,
  zeroProgress,
} from "./protocol.ts";
import { isError, log } from "./util.ts";

// "pokemon" = a fallen party member (pokemon_lost); "player" = the TRAINER's own
// grave, appended on every newly-accepted whiteout.
export type MemorialKind = "pokemon" | "player";

export interface MemorialEntry {
  kind: MemorialKind;
  name: string; // nickname (falls back to species) / player name — PLAYER CONTROLLED, escape it
  species: string; // "" for kind:"player"
  dex: number; // 0 for kind:"player"
  level: number; // 0 for kind:"player"
  cause: LossCause | WhiteoutReason; // player graves carry the whiteout reason
  attempt: number;
  ts: number; // server receive time
}

// The broadcast/ring view of one accepted game event (envelope stripped).
export interface GameView {
  [k: string]: unknown;
  event: string;
  ts: number;
  attempt: number;
}

export interface ApplyResult {
  accepted: boolean;
  dup: boolean;
  newAttempt: boolean;
  // Whether derived overlay state (counters/progress/memorial/snapshot) changed —
  // drives an extra `state` SSE broadcast after events.
  stateChanged: boolean;
  gameView: GameView | null;
}

// What /api/state.json and the SSE `state` event carry.
export interface PublicState {
  live: boolean;
  lastIngestAt: number;
  updatedAt: number;
  attempt: number;
  session: string | null;
  player: string;
  location: string;
  world: WorldInfo | null;
  party: PartyMember[];
  deaths: DeathCounters; // current save
  campaign: DeathCounters; // banked previous attempts + current save
  progress: ProgressInfo;
  quest: QuestInfo | null;
  memorial: MemorialEntry[];
}

export interface StateOpts {
  stateDir: string; // "" = persistence disabled
  eventLogSize: number;
  staleAfterSec: number;
  persistDebounceMs: number;
}

function buildGameView(msg: EventMsg, ts: number, attempt: number): GameView {
  const v: GameView = { event: msg.event, ts, attempt };
  switch (msg.event) {
    case "pokemon_lost":
      v.cause = msg.cause;
      v.pokemon = msg.pokemon;
      if (msg.deathsTotal !== undefined) v.deathsTotal = msg.deathsTotal;
      break;
    case "capture":
      v.pokemon = msg.pokemon;
      break;
    case "whiteout":
      v.reason = msg.reason;
      break;
    case "badge":
      v.badgeId = msg.badgeId;
      if (msg.badges !== undefined) v.badges = msg.badges;
      break;
    case "trainer_defeated":
      v.trainerId = msg.trainerId;
      v.trainerName = msg.trainerName;
      v.category = msg.category;
      break;
    case "level_cap":
      v.cap = msg.cap;
      break;
    case "session_start":
      v.modVersion = msg.modVersion;
      v.protocol = msg.protocol;
      break;
    case "session_stop":
      break;
  }
  return v;
}

export class OverlayState {
  #opts: StateOpts;

  // per-session dedup
  #session: string | null = null;
  #lastSeq = -1;

  // liveness (server clock; 0 = never / restored-from-disk → stale)
  #lastIngestAt = 0;

  // campaign (survives saves + restarts)
  #attempt = 1;
  #worldId: string | null = null;
  #campaign: DeathCounters = zeroDeaths();
  #memorial: MemorialEntry[] = [];

  // current snapshot
  #seeded = false; // true once any snapshot data exists (live or restored)
  #player = "";
  #location = "";
  #world: WorldInfo | null = null;
  #party: PartyMember[] = [];
  #deaths: DeathCounters = zeroDeaths();
  #progress: ProgressInfo = zeroProgress();
  #quest: QuestInfo | null = null;
  #updatedAt = 0;

  // rolling event ring (debug/status only — never replayed over SSE)
  #events: GameView[] = [];

  // debounced persist
  #persistTimer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;

  constructor(opts: StateOpts) {
    this.#opts = opts;
  }

  get attempt(): number {
    return this.#attempt;
  }

  get lastIngestAt(): number {
    return this.#lastIngestAt;
  }

  get statePath(): string {
    return this.#opts.stateDir ? `${this.#opts.stateDir}/state.json` : "";
  }

  // ---- ingest ----

  apply(msg: Message, receivedAt: number): ApplyResult {
    // Per-session seq dedup BEFORE any mutation, so a duplicated pokemon_lost
    // can never double-append a headstone.
    if (this.#session === msg.session && msg.seq <= this.#lastSeq) {
      this.#lastIngestAt = receivedAt; // a dup still proves the mod is alive
      return { accepted: false, dup: true, newAttempt: false, stateChanged: false, gameView: null };
    }
    this.#session = msg.session; // new session id resets tracking
    this.#lastSeq = msg.seq;
    this.#lastIngestAt = receivedAt;

    if (msg.type === "snapshot") {
      const newAttempt = this.#maybeBankAttempt(msg);
      this.#player = msg.player;
      this.#location = msg.location;
      this.#world = msg.world;
      this.#party = msg.party;
      this.#deaths = msg.deaths;
      this.#progress = msg.progress;
      this.#quest = msg.quest;
      this.#seeded = true;
      this.#updatedAt = receivedAt;
      if (newAttempt) {
        this.#pushEvent({ event: "new_attempt", ts: receivedAt, attempt: this.#attempt });
      }
      this.#schedulePersist();
      return { accepted: true, dup: false, newAttempt, stateChanged: true, gameView: null };
    }

    // event — merge the small counter hints it carries so overlays react between
    // snapshots (the next snapshot overwrites with the mod's authoritative values).
    let stateChanged = false;
    switch (msg.event) {
      case "pokemon_lost": {
        const p = msg.pokemon!;
        this.#memorial.push({
          kind: "pokemon",
          name: p.name || p.species,
          species: p.species,
          dex: p.dex,
          level: p.level,
          cause: msg.cause!,
          attempt: this.#attempt,
          ts: receivedAt,
        });
        if (msg.deathsTotal !== undefined) this.#deaths.total = msg.deathsTotal;
        else this.#deaths.total += 1;
        if (msg.cause === "sacrifice") this.#deaths.sacrifices += 1;
        if (msg.cause === "duplicate_release") this.#deaths.duplicateReleases += 1;
        stateChanged = true;
        break;
      }
      case "whiteout":
        // The TRAINER's own headstone: named from the latest snapshot (fallback
        // "Trainer"), cause = the whiteout reason. The seq gate above already
        // guarantees a dup'd whiteout can never double-append.
        this.#memorial.push({
          kind: "player",
          name: this.#player || "Trainer",
          species: "",
          dex: 0,
          level: 0,
          cause: msg.reason ?? "faint",
          attempt: this.#attempt,
          ts: receivedAt,
        });
        this.#deaths.whiteouts += 1;
        stateChanged = true;
        break;
      case "badge":
        if (msg.badges !== undefined) this.#progress.badges = msg.badges;
        else this.#progress.badges += 1;
        stateChanged = true;
        break;
      case "level_cap":
        this.#progress.levelCap = msg.cap!;
        stateChanged = true;
        break;
      case "trainer_defeated":
        this.#progress.trainersDefeated += 1;
        stateChanged = true;
        break;
      case "capture":
      case "session_start":
      case "session_stop":
        break;
    }
    const gameView = buildGameView(msg, receivedAt, this.#attempt);
    this.#pushEvent(gameView);
    if (stateChanged) {
      this.#updatedAt = receivedAt;
      this.#schedulePersist();
    }
    return { accepted: true, dup: false, newAttempt: false, stateChanged, gameView };
  }

  // Distinct worldId = one hardcore attempt. Returns true when this snapshot
  // starts a NEW attempt (previous save's counters banked, attempt incremented).
  #maybeBankAttempt(snap: SnapshotMsg): boolean {
    let isNew = false;
    if (snap.worldId) {
      if (this.#worldId && snap.worldId !== this.#worldId) isNew = true;
    } else if (this.#seeded && snap.deaths.total < this.#deaths.total) {
      // Old-protocol fallback (no worldId): a counter decrease means a fresh save.
      isNew = true;
    }
    if (isNew) {
      this.#campaign.total += this.#deaths.total;
      this.#campaign.whiteouts += this.#deaths.whiteouts;
      this.#campaign.sacrifices += this.#deaths.sacrifices;
      this.#campaign.duplicateReleases += this.#deaths.duplicateReleases;
      this.#attempt += 1;
      log("info", "new hardcore attempt detected", {
        attempt: this.#attempt,
        worldId: snap.worldId,
        bankedDeaths: this.#deaths.total,
      });
    }
    if (snap.worldId) this.#worldId = snap.worldId;
    else if (isNew) this.#worldId = null;
    return isNew;
  }

  #pushEvent(view: GameView): void {
    this.#events.push(view);
    while (this.#events.length > this.#opts.eventLogSize) this.#events.shift();
  }

  // ---- views ----

  view(now: number): PublicState {
    const staleAfterMs = this.#opts.staleAfterSec * 1000;
    return {
      live: this.#lastIngestAt > 0 && now - this.#lastIngestAt < staleAfterMs,
      lastIngestAt: this.#lastIngestAt,
      updatedAt: this.#updatedAt,
      attempt: this.#attempt,
      session: this.#session,
      player: this.#player,
      location: this.#location,
      world: this.#world,
      party: this.#party.map((m) => ({ ...m })),
      deaths: { ...this.#deaths },
      campaign: {
        total: this.#campaign.total + this.#deaths.total,
        whiteouts: this.#campaign.whiteouts + this.#deaths.whiteouts,
        sacrifices: this.#campaign.sacrifices + this.#deaths.sacrifices,
        duplicateReleases: this.#campaign.duplicateReleases + this.#deaths.duplicateReleases,
      },
      progress: { ...this.#progress },
      quest: this.#quest ? { ...this.#quest } : null,
      memorial: this.#memorial.map((m) => ({ ...m })),
    };
  }

  recentEvents(): GameView[] {
    return this.#events.slice().reverse(); // newest first
  }

  // ---- persistence ----

  #schedulePersist(): void {
    this.#dirty = true;
    if (!this.#opts.stateDir) return;
    if (this.#persistTimer !== null) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#persist().catch((e) =>
        log("error", "state persist failed", { err: isError(e) ? e.message : String(e) })
      );
    }, this.#opts.persistDebounceMs);
  }

  // Cancel any pending debounce timer and persist NOW (SIGTERM/SIGINT path).
  async flush(): Promise<void> {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    if (!this.#opts.stateDir || !this.#dirty) return;
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const doc = {
      version: 1,
      savedAt: Date.now(),
      attempt: this.#attempt,
      worldId: this.#worldId,
      campaign: this.#campaign,
      memorial: this.#memorial,
      seeded: this.#seeded,
      player: this.#player,
      location: this.#location,
      world: this.#world,
      party: this.#party,
      deaths: this.#deaths,
      progress: this.#progress,
      quest: this.#quest,
    };
    // Atomic: write a tmp file in the same directory, then rename over.
    const path = this.statePath;
    const tmp = `${path}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(doc));
    await Deno.rename(tmp, path);
    this.#dirty = false;
  }

  // Restore campaign + last snapshot from disk. lastIngestAt stays 0, so the
  // overlay boots STALE until the mod pushes again; session/seq tracking resets.
  async load(): Promise<void> {
    const path = this.statePath;
    if (!path) return;
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      return; // fresh boot — nothing persisted yet
    }
    try {
      const doc = JSON.parse(text) as Record<string, unknown>;
      this.#attempt = Math.max(1, num(doc.attempt, 1));
      this.#worldId = str(doc.worldId) || null;
      this.#campaign = coerceDeaths(doc.campaign);
      this.#memorial = Array.isArray(doc.memorial)
        ? doc.memorial.flatMap((raw): MemorialEntry[] => {
          if (typeof raw !== "object" || raw === null) return [];
          const m = raw as Record<string, unknown>;
          const cause = str(m.cause, "faint");
          if (str(m.kind) === "player") {
            return [{
              kind: "player",
              name: str(m.name) || "Trainer",
              species: "",
              dex: 0,
              level: 0,
              cause: (["faint", "flee", "forfeit"].includes(cause) ? cause : "faint") as WhiteoutReason,
              attempt: Math.max(1, num(m.attempt, 1)),
              ts: num(m.ts),
            }];
          }
          // no/unknown "kind" = a pre-"kind" persisted entry → pokemon grave
          const species = str(m.species);
          if (!species) return [];
          return [{
            kind: "pokemon",
            name: str(m.name) || species,
            species,
            dex: num(m.dex),
            level: num(m.level),
            cause: (["faint", "sacrifice", "duplicate_release"].includes(cause) ? cause : "faint") as LossCause,
            attempt: Math.max(1, num(m.attempt, 1)),
            ts: num(m.ts),
          }];
        })
        : [];
      this.#seeded = bool(doc.seeded, false);
      this.#player = str(doc.player);
      this.#location = str(doc.location);
      const w = doc.world;
      this.#world = typeof w === "object" && w !== null
        ? {
          day: num((w as Record<string, unknown>).day),
          timeOfDay: num((w as Record<string, unknown>).timeOfDay),
          playtimeTicks: num((w as Record<string, unknown>).playtimeTicks),
        }
        : null;
      this.#party = Array.isArray(doc.party)
        ? doc.party.flatMap((raw, i) => {
          const m = coercePartyMember(raw, i);
          return m ? [m] : [];
        }).slice(0, 6)
        : [];
      this.#deaths = coerceDeaths(doc.deaths);
      this.#progress = coerceProgress(doc.progress);
      const q = doc.quest;
      const qname = typeof q === "object" && q !== null ? str((q as Record<string, unknown>).name) : "";
      this.#quest = qname ? { name: qname, stage: str((q as Record<string, unknown>).stage) } : null;
      this.#updatedAt = num(doc.savedAt);
      this.#lastIngestAt = 0; // restored state is STALE until the mod pushes
      log("info", "state restored", {
        path,
        attempt: this.#attempt,
        memorial: this.#memorial.length,
        campaignDeaths: this.#campaign.total + this.#deaths.total,
      });
    } catch (e) {
      log("error", "corrupt state.json ignored (starting fresh)", {
        path,
        err: isError(e) ? e.message : String(e),
      });
    }
  }
}
