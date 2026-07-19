// Event hub: keep the two upstream Protect subscriptions alive, remember recent events
// per camera (for the timeline strip), and fan everything out to browser /ws/events
// sockets. The Integration API has no recorded-video endpoint, so these motion /
// smart-detect / ring events (with snapshots) ARE the "timeline". ZERO external imports.

import { Config } from "./config.ts";
import { ProtectClient, ProtectEvent } from "./protect.ts";
import { log } from "./util.ts";

interface DeviceMessage {
  type?: string;
  item?: { id?: string; modelKey?: string; state?: string; isMotionDetected?: boolean } & Record<string, unknown>;
}

export class EventHub {
  #cfg: Config;
  #client: ProtectClient;
  #recent = new Map<string, ProtectEvent[]>(); // cameraId -> ring (oldest..newest)
  #subscribers = new Set<WebSocket>();

  constructor(cfg: Config, client: ProtectClient) {
    this.#cfg = cfg;
    this.#client = client;
  }

  // Launch the upstream subscriptions (each self-reconnects until `signal` aborts).
  start(signal: AbortSignal): void {
    this.#client.subscribeEvents((e) => this.#onEvent(e), signal).catch((err) =>
      log("error", "events subscription ended", { err: String(err) })
    );
    this.#client.subscribeDevices((m) => this.#onDevice(m as DeviceMessage), signal).catch((err) =>
      log("error", "devices subscription ended", { err: String(err) })
    );
  }

  #onEvent(e: ProtectEvent): void {
    const ring = this.#recent.get(e.cameraId) ?? [];
    const idx = ring.findIndex((x) => x.id === e.id);
    if (idx >= 0) ring[idx] = { ...ring[idx], ...e };
    else {
      ring.push(e);
      if (ring.length > this.#cfg.eventBufferPerCamera) ring.shift();
    }
    this.#recent.set(e.cameraId, ring);
    this.#broadcast({ type: "event", event: e });
  }

  #onDevice(msg: DeviceMessage): void {
    const item = msg.item;
    if (!item || item.modelKey !== "camera" || typeof item.id !== "string") return;
    // Forward only the fields the UI cares about (online state / motion flag).
    const patch: Record<string, unknown> = {};
    if (typeof item.state === "string") patch.state = item.state;
    if (typeof item.isMotionDetected === "boolean") patch.isMotionDetected = item.isMotionDetected;
    if (Object.keys(patch).length === 0) return;
    this.#broadcast({ type: "device", cameraId: item.id, patch });
  }

  // Flatten recent events across cameras, newest first, capped — the snapshot a
  // newly-connected browser receives to seed its timelines.
  recentSnapshot(limit = 500): ProtectEvent[] {
    const all: ProtectEvent[] = [];
    for (const ring of this.#recent.values()) all.push(...ring);
    all.sort((a, b) => b.start - a.start);
    return all.slice(0, limit);
  }

  addSubscriber(sock: WebSocket): void {
    const register = () => {
      this.#subscribers.add(sock);
      try {
        sock.send(JSON.stringify({ type: "snapshot", events: this.recentSnapshot() }));
      } catch { /* closed already */ }
    };
    if (sock.readyState === WebSocket.OPEN) register();
    else sock.onopen = () => register();
    sock.onclose = () => this.#subscribers.delete(sock);
    sock.onerror = () => this.#subscribers.delete(sock);
  }

  #broadcast(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const sock of this.#subscribers) {
      if (sock.readyState !== WebSocket.OPEN) continue;
      try {
        sock.send(data);
      } catch { /* drop */ }
    }
  }
}
