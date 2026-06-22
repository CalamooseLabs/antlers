// Live Claude plan-usage — the SAME server-authoritative data the interactive
// `/usage` command shows (5-hour session window + weekly windows + reset times),
// fetched from Anthropic's OAuth usage endpoint. ZERO external imports (Deno's
// built-in fetch + Deno.readTextFile only).
//
// Source of truth: `claude` itself calls `GET https://api.anthropic.com/api/oauth/usage`
// (the `api_usage_fetch` span) with the subscription OAuth bearer token. This is
// UNDOCUMENTED and aggressively rate-limited:
//   - it 429s readily (often with no Retry-After), so we NEVER poll it faster than
//     MIN_REFRESH_MS and cache the result; browsers poll our cache, not the endpoint;
//   - it requires a `User-Agent: claude-code/<version>` (a wrong/absent UA lands in a
//     punitive bucket), so we mirror the installed CLI's version.
// Token handling is READ-ONLY: we read the access token from .credentials.json but
// never refresh/rewrite it (that would race `claude`'s own token rotation). If the
// token is expired we say so and let a running session refresh it.

import type { ServerConfig } from "./config.ts";
import { buildEnv, configDir } from "./claude.ts";
import { isError, log } from "./util.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_VERSION = "2023-06-01";
const FALLBACK_VERSION = "2.1.177"; // used for the UA if `claude --version` can't be read
const FETCH_TIMEOUT_MS = 8000;
const MIN_REFRESH_MS = 180_000; // hard floor: never hit the endpoint faster than this

// One usage window (a rate-limit bucket) as the UI consumes it.
export interface UsageWindow {
  key: string; // five_hour | seven_day | seven_day_sonnet | seven_day_opus | extra_usage
  label: string;
  utilization: number; // percent used, 0-100
  resetsAt: number | null; // epoch ms, or null if unknown
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  extraEnabled: boolean; // whether pay-as-you-go "extra usage" credits are turned on
}

// What the GET /api/usage route returns. `available` means we have (or just got) a
// usable snapshot; `stale` means we're showing the last good one because the latest
// fetch failed (rate-limited / timed out). `error` is a human note for either case.
export interface UsageState {
  enabled: boolean;
  available: boolean;
  fetchedAt: number | null; // epoch ms of the snapshot being shown
  stale: boolean;
  error?: string;
  subscriptionType?: string; // max | team | pro (from the credentials file)
  snapshot?: UsageSnapshot;
}

// Window keys → display labels, in the order the UI renders them. (UI labels are
// taken verbatim from the claude binary's own strings.)
const WINDOW_DEFS: { key: string; label: string }[] = [
  { key: "five_hour", label: "Session (5h)" },
  { key: "seven_day", label: "Week (all models)" },
  { key: "seven_day_sonnet", label: "Week (Sonnet)" },
  { key: "seven_day_opus", label: "Week (Opus)" },
];

// Pure: a window's percent-used. The raw endpoint uses `utilization`; the statusline
// variant uses `used_percentage` — accept either and clamp to [0,100].
function pickUtilization(w: Record<string, unknown>): number | null {
  const v = typeof w.utilization === "number"
    ? w.utilization
    : typeof w.used_percentage === "number"
    ? w.used_percentage
    : null;
  if (v === null || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

// Pure: normalize a reset timestamp to epoch ms. The OAuth endpoint sends ISO8601;
// the statusline variant sends unix-epoch-SECONDS — distinguish by magnitude.
export function normResetsAt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Pure: parse the /api/oauth/usage JSON into a normalized snapshot. Tolerates
// surrounding noise (falls back to the first {...} block). Returns null when the
// body isn't an object at all; an object with no recognizable windows yields an
// empty `windows` array.
export function parseUsage(raw: string): UsageSnapshot | null {
  let obj: unknown = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        obj = JSON.parse(raw.slice(a, b + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const windows: UsageWindow[] = [];
  for (const def of WINDOW_DEFS) {
    const w = o[def.key];
    if (!w || typeof w !== "object" || Array.isArray(w)) continue;
    const wr = w as Record<string, unknown>;
    const util = pickUtilization(wr);
    if (util === null) continue;
    windows.push({ key: def.key, label: def.label, utilization: util, resetsAt: normResetsAt(wr.resets_at) });
  }

  // Pay-as-you-go overage credits — only surface when enabled with a real number.
  let extraEnabled = false;
  const ex = o.extra_usage;
  if (ex && typeof ex === "object" && !Array.isArray(ex)) {
    const er = ex as Record<string, unknown>;
    extraEnabled = er.is_enabled === true;
    if (extraEnabled) {
      const util = pickUtilization(er);
      if (util !== null) {
        windows.push({ key: "extra_usage", label: "Extra usage", utilization: util, resetsAt: normResetsAt(er.resets_at) });
      }
    }
  }

  return { windows, extraEnabled };
}

// ---- credentials (read-only) ----

interface Creds {
  token: string;
  expiresAt: number; // epoch ms, 0 if unknown
  subscriptionType?: string;
}

async function readCredentials(): Promise<Creds | null> {
  try {
    const obj = JSON.parse(await Deno.readTextFile(`${configDir()}/.credentials.json`));
    const o = obj && typeof obj === "object" ? (obj as Record<string, unknown>).claudeAiOauth : null;
    if (!o || typeof o !== "object") return null;
    const c = o as Record<string, unknown>;
    if (typeof c.accessToken !== "string" || !c.accessToken) return null;
    return {
      token: c.accessToken,
      expiresAt: typeof c.expiresAt === "number" ? c.expiresAt : 0,
      subscriptionType: typeof c.subscriptionType === "string" ? c.subscriptionType : undefined,
    };
  } catch {
    return null;
  }
}

// ---- User-Agent (mirror the installed CLI version) ----

let cachedUserAgent: string | null = null;

async function claudeUserAgent(config: ServerConfig): Promise<string> {
  if (cachedUserAgent) return cachedUserAgent;
  let version = FALLBACK_VERSION;
  try {
    const out = await new Deno.Command("claude", {
      args: ["--version"],
      env: buildEnv(config),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const m = new TextDecoder().decode(out.stdout).match(/(\d+\.\d+\.\d+)/);
    if (m) version = m[1];
  } catch { /* fall back to the pinned version */ }
  cachedUserAgent = `claude-code/${version}`;
  return cachedUserAgent;
}

// ---- one network fetch ----

function unavailable(error: string, subscriptionType?: string): UsageState {
  return { enabled: true, available: false, fetchedAt: null, stale: false, error, subscriptionType };
}

async function fetchFromApi(config: ServerConfig): Promise<UsageState> {
  const creds = await readCredentials();
  if (!creds) return unavailable("not logged in to Claude (no OAuth credentials)");
  // Read-only: don't refresh a stale token (that races `claude`'s own rotation).
  if (creds.expiresAt && Date.now() + 60_000 >= creds.expiresAt) {
    return unavailable("Claude token expired — a running session will refresh it", creds.subscriptionType);
  }

  const ua = await claudeUserAgent(config);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${creds.token}`,
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
        "User-Agent": ua,
      },
      signal: ac.signal,
    });
    if (r.status === 429) {
      await r.body?.cancel().catch(() => {});
      return unavailable("rate limited by Anthropic — will retry shortly", creds.subscriptionType);
    }
    if (r.status === 401 || r.status === 403) {
      await r.body?.cancel().catch(() => {});
      return unavailable("Claude authorization rejected (token may need a refresh)", creds.subscriptionType);
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return unavailable(`usage endpoint returned HTTP ${r.status}`, creds.subscriptionType);
    }
    const snap = parseUsage(await r.text());
    if (!snap || !snap.windows.length) return unavailable("usage data unavailable", creds.subscriptionType);
    return {
      enabled: true,
      available: true,
      fetchedAt: Date.now(),
      stale: false,
      subscriptionType: creds.subscriptionType,
      snapshot: snap,
    };
  } catch (e) {
    if (ac.signal.aborted) return unavailable("usage request timed out", creds.subscriptionType);
    log("warn", "usage fetch failed", { err: isError(e) ? e.message : String(e) });
    return unavailable("usage request failed", creds.subscriptionType);
  } finally {
    clearTimeout(timer);
  }
}

// ---- cache + single-flight throttle ----
//
// The endpoint is rate-limited, so we hit it at most once per `refreshInterval`
// (floored at MIN_REFRESH_MS) regardless of how many browsers are polling. A failed
// fetch keeps the last good snapshot visible, marked stale. One in-flight fetch is
// shared across concurrent callers.

let lastGood: { snapshot: UsageSnapshot; subscriptionType?: string; fetchedAt: number } | null = null;
let cached: UsageState | null = null;
let cachedAt = 0;
let inflight: Promise<UsageState> | null = null;

export async function getUsage(config: ServerConfig): Promise<UsageState> {
  if (!config.usageEnabled) {
    return { enabled: false, available: false, fetchedAt: null, stale: false };
  }
  const interval = Math.max(MIN_REFRESH_MS, (config.usageRefreshSec || 0) * 1000);
  if (cached && Date.now() - cachedAt < interval) return cached;
  if (inflight) return inflight;

  const p = (async (): Promise<UsageState> => {
    const fresh = await fetchFromApi(config);
    if (fresh.available && fresh.snapshot && fresh.fetchedAt) {
      lastGood = { snapshot: fresh.snapshot, subscriptionType: fresh.subscriptionType, fetchedAt: fresh.fetchedAt };
      cached = fresh;
    } else if (lastGood) {
      // Keep the last good data on screen, flagged stale with the new reason.
      cached = {
        enabled: true,
        available: true,
        fetchedAt: lastGood.fetchedAt,
        stale: true,
        error: fresh.error,
        subscriptionType: fresh.subscriptionType ?? lastGood.subscriptionType,
        snapshot: lastGood.snapshot,
      };
    } else {
      cached = fresh; // never had data — surface the unavailable reason
    }
    cachedAt = Date.now();
    return cached;
  })();
  inflight = p;
  p.finally(() => {
    inflight = null;
  });
  return p;
}
