// Server-Sent-Events hub for the overlay pages. ZERO external imports.
//
// Contract (the OBS-refresh-safe part of the design):
//  - on connect a client gets ONE chunk containing the full `state` event plus
//    the current `status` (live/stale) — and NOTHING else. There is NO event-
//    history replay on connect, so refreshing an OBS browser source can never
//    re-fire old toasts.
//  - every accepted snapshot broadcasts `state` (a full replacement view);
//    every newly-accepted game event broadcasts `game` (exactly once).
//  - a `: keepalive` comment goes out every ~15s so idle proxies don't drop
//    the stream.
//  - the live→stale watchdog (server receive-time based, never the mod's `t`)
//    broadcasts a `status` event EXACTLY ONCE per transition, each way.
//
// Timers live behind startTimers()/stopTimers() (main.ts wires them) so tests
// can drive the hub and the watchdog with a fake clock and no leaking ops.

export function formatSse(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  return `event: ${event}\n` + json.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
}

// Live/stale edge detector. `check(now)` returns the NEW liveness only on a
// transition (true = went live, false = went stale) and null otherwise — so a
// caller broadcasting on non-null fires exactly once each way.
export class Watchdog {
  #live = false;
  #staleAfterMs: number;
  #getLastIngestAt: () => number;

  constructor(staleAfterMs: number, getLastIngestAt: () => number) {
    this.#staleAfterMs = staleAfterMs;
    this.#getLastIngestAt = getLastIngestAt;
  }

  get live(): boolean {
    return this.#live;
  }

  check(now: number): boolean | null {
    const last = this.#getLastIngestAt();
    const live = last > 0 && now - last < this.#staleAfterMs;
    if (live === this.#live) return null;
    this.#live = live;
    return live;
  }
}

export class SseHub {
  #subs = new Set<ReadableStreamDefaultController<Uint8Array>>();
  #enc = new TextEncoder();
  #getState: () => unknown;
  #watchdog: Watchdog;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(getState: () => unknown, watchdog: Watchdog) {
    this.#getState = getState;
    this.#watchdog = watchdog;
  }

  get size(): number {
    return this.#subs.size;
  }

  // New SSE subscriber: full current state + current status, no history.
  connect(): Response {
    const subs = this.#subs;
    const enc = this.#enc;
    const initial = formatSse("state", this.#getState()) +
      formatSse("status", { live: this.#watchdog.live });
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        ctl = controller;
        controller.enqueue(enc.encode(initial));
        subs.add(controller);
      },
      cancel() {
        if (ctl) subs.delete(ctl);
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "connection": "keep-alive",
      },
    });
  }

  #send(payload: string): void {
    const data = this.#enc.encode(payload);
    for (const ctl of [...this.#subs]) {
      try {
        ctl.enqueue(data);
      } catch {
        this.#subs.delete(ctl); // client gone
      }
    }
  }

  broadcastState(view: unknown): void {
    this.#send(formatSse("state", view));
  }

  broadcastGame(ev: unknown): void {
    this.#send(formatSse("game", ev));
  }

  keepalive(): void {
    this.#send(": keepalive\n\n");
  }

  // Run the watchdog once; broadcast `status` only on a transition.
  tick(now: number = Date.now()): void {
    const transition = this.#watchdog.check(now);
    if (transition !== null) {
      this.#send(formatSse("status", { live: transition }));
    }
  }

  startTimers(): void {
    if (this.#tickTimer === null) {
      this.#tickTimer = setInterval(() => this.tick(), 1000);
    }
    if (this.#keepaliveTimer === null) {
      this.#keepaliveTimer = setInterval(() => this.keepalive(), 15000);
    }
  }

  stopTimers(): void {
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    if (this.#keepaliveTimer !== null) {
      clearInterval(this.#keepaliveTimer);
      this.#keepaliveTimer = null;
    }
  }
}
