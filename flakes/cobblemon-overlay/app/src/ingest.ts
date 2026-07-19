// POST /ingest — the mod-facing endpoint. ZERO external imports.
//
// Gate order: token (timing-safe compare) → body size cap (413) → JSON parse
// (400) → protocol validation incl. version check (400) → per-session seq
// dedup ({ok,dup} 2xx, no re-broadcast) → state.apply + SSE broadcasts.

import { parseMessage } from "./protocol.ts";
import type { OverlayState } from "./state.ts";
import type { SseHub } from "./sse.ts";
import { json, log, parseBearerToken, timingSafeEqual } from "./util.ts";

export interface IngestDeps {
  state: OverlayState;
  hub: Pick<SseHub, "broadcastState" | "broadcastGame">;
  token: string; // "" = no auth configured
  maxBodyBytes: number;
  now?: () => number; // injectable clock for tests
}

// Read at most `maxBytes` of the request body as text; null = over the cap.
export async function readBodyLimited(req: Request, maxBytes: number): Promise<string | null> {
  const cl = req.headers.get("content-length");
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
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
    log("warn", "ingest rejected: invalid JSON", { body: body.slice(0, 200) });
    return json({ error: "invalid JSON" }, 400);
  }

  const parsed = parseMessage(raw);
  if (!parsed.ok) {
    log("warn", "ingest rejected", { error: parsed.error, body: body.slice(0, 300) });
    return json({ error: parsed.error }, 400);
  }

  const now = (deps.now ?? Date.now)();
  const result = deps.state.apply(parsed.msg, now);
  if (result.dup) return json({ ok: true, dup: true });

  if (parsed.msg.type === "snapshot") {
    if (result.newAttempt) {
      // Synthetic toast-page event — the mod never sends this; the service
      // derives it from the worldId/counter-based attempt detection.
      deps.hub.broadcastGame({ event: "new_attempt", ts: now, attempt: deps.state.attempt });
    }
    deps.hub.broadcastState(deps.state.view(now));
  } else {
    if (result.gameView) deps.hub.broadcastGame(result.gameView);
    if (result.stateChanged) deps.hub.broadcastState(deps.state.view(now));
  }
  return json({ ok: true });
}
