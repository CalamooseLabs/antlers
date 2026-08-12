// POST /control — the operator-facing control endpoint. ZERO external imports;
// a thin mirror of ingest.ts (same gate order, same reusable helpers).
//
// Two actions, both DESTRUCTIVE to the on-stream state, so the route shares the
// ingest token gate:
//   { "action": "set", "attempt": <int ≥ 1>, "bank"?: boolean }
//       Pin the attempt number (the button-authoritative sync: tci-run pushes
//       the absolute run number after every `new`). `bank` banks the previous
//       save's deaths into the campaign totals — set on a real new run, omitted
//       on the reconcile re-assert.
//   { "action": "reset" }
//       Wipe the campaign (attempt → 1, cemetery/counters cleared) — the overlay
//       half of "reset it all".
//
// Gate order (identical to /ingest): method (405) → token (401) → body cap (413)
// → JSON parse (400) → action validation (400) → mutate + broadcast state.

import { readBodyLimited } from "./ingest.ts";
import type { OverlayState } from "./state.ts";
import type { SseHub } from "./sse.ts";
import { json, log, parseBearerToken, timingSafeEqual } from "./util.ts";

export interface ControlDeps {
  state: OverlayState;
  hub: Pick<SseHub, "broadcastState">;
  token: string; // "" = no auth configured
  maxBodyBytes: number;
  now?: () => number; // injectable clock for tests
}

export async function handleControl(req: Request, deps: ControlDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (deps.token) {
    const presented = parseBearerToken(req.headers.get("authorization")) ||
      req.headers.get("x-overlay-token") || "";
    if (!timingSafeEqual(presented, deps.token)) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  const body = await readBodyLimited(req, deps.maxBodyBytes);
  if (body === null) return json({ error: "body too large" }, 413);

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    log("warn", "control rejected: invalid JSON", { body: body.slice(0, 200) });
    return json({ error: "invalid JSON" }, 400);
  }

  const o = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};

  let mutated = true;
  if (o.action === "set") {
    const attempt = o.attempt;
    if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt < 1) {
      return json({ error: "set requires an attempt number >= 1" }, 400);
    }
    mutated = deps.state.setAttempt(attempt, { bank: o.bank === true });
  } else if (o.action === "reset") {
    deps.state.resetCampaign();
    await deps.state.flush(); // a wipe must survive an instant crash — skip the debounce
  } else {
    return json({ error: `unknown action ${JSON.stringify(o.action ?? null)}` }, 400);
  }

  // Skip the broadcast + log on an idempotent no-op set (the reconcile re-assert),
  // so the overlays only see a `state` event when something actually changed.
  if (mutated) {
    const now = (deps.now ?? Date.now)();
    deps.hub.broadcastState(deps.state.view(now));
    log("info", "control applied", { action: o.action, attempt: deps.state.attempt });
  }
  return json({ ok: true, attempt: deps.state.attempt });
}
