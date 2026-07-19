// UniFi Protect Integration API client (per docs/protect-openapi.json, v7.1.87).
//
// Auth: every request carries the `X-API-KEY` header. REST goes over `fetch`;
// the two /v1/subscribe/* streams go over the hand-rolled WS client (ws.ts) so the
// header can be sent. TLS to a local self-signed console is accepted because the
// compiled binary bakes `--unsafely-ignore-certificate-errors` (see package.nix /
// README) — the API key is the security boundary on the LAN. ZERO external imports.

import { Quality } from "./config.ts";
import { connectWs } from "./ws.ts";
import { errMsg, log, sleep } from "./util.ts";

export interface Camera {
  id: string;
  name: string;
  state: string; // CONNECTED | CONNECTING | DISCONNECTED
  isMicEnabled: boolean;
  hasPackageCamera: boolean;
  hasMic: boolean;
  hasSpeaker: boolean;
}

export type RtspsStreams = Partial<Record<Quality, string | null>>;

// A camera-scoped, UI-facing event (motion / smart detections / ring).
export interface ProtectEvent {
  id: string;
  kind: string; // motion | smartDetectZone | smartDetectLine | smartDetectLoiter | ring | ...
  cameraId: string;
  start: number; // unix ms
  end: number | null; // unix ms or null while ongoing
  action: "add" | "update";
}

interface RawCamera {
  id: string;
  name: string | null;
  state: string;
  isMicEnabled?: boolean;
  hasPackageCamera?: boolean;
  featureFlags?: { hasMic?: boolean; hasSpeaker?: boolean };
}

function toCamera(r: RawCamera): Camera {
  return {
    id: r.id,
    name: r.name ?? r.id,
    state: r.state,
    isMicEnabled: !!r.isMicEnabled,
    hasPackageCamera: !!r.hasPackageCamera,
    hasMic: !!r.featureFlags?.hasMic,
    hasSpeaker: !!r.featureFlags?.hasSpeaker,
  };
}

export class ProtectClient {
  #base: string;
  #apiKey: string;
  // (camera:quality) -> { url, exp } — RTSPS URLs are stable; refresh every few minutes.
  #rtspsCache = new Map<string, { url: string; exp: number }>();
  #rtspsTtlMs = 5 * 60 * 1000;

  constructor(consoleUrl: string, apiKey: string) {
    this.#base = consoleUrl.replace(/\/+$/, "");
    this.#apiKey = apiKey;
  }

  #headers(extra: Record<string, string> = {}): HeadersInit {
    return { "X-API-KEY": this.#apiKey, ...extra };
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers: this.#headers(
        body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      ),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}${txt ? `: ${txt.slice(0, 300)}` : ""}`);
    }
    return (await res.json()) as T;
  }

  // GET /v1/meta/info — cheap health/auth check; returns the Protect app version.
  async metaInfo(): Promise<{ applicationVersion: string }> {
    return await this.#request("GET", "/v1/meta/info");
  }

  // GET /v1/cameras
  async listCameras(): Promise<Camera[]> {
    const raw = await this.#request<RawCamera[]>("GET", "/v1/cameras");
    return raw.map(toCamera);
  }

  // GET /v1/cameras/{id}
  async getCamera(id: string): Promise<Camera> {
    return toCamera(await this.#request<RawCamera>("GET", `/v1/cameras/${encodeURIComponent(id)}`));
  }

  // GET /v1/cameras/{id}/snapshot -> JPEG bytes.
  async getSnapshot(
    id: string,
    opts: { channel?: "main" | "package"; highQuality?: boolean } = {},
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
    const qs = new URLSearchParams();
    qs.set("channel", opts.channel ?? "main");
    qs.set("highQuality", opts.highQuality ? "true" : "false");
    const res = await fetch(`${this.#base}/v1/cameras/${encodeURIComponent(id)}/snapshot?${qs}`, {
      headers: this.#headers({ accept: "image/jpeg" }),
    });
    if (!res.ok) throw new Error(`snapshot ${id} -> ${res.status} ${res.statusText}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, contentType: res.headers.get("content-type") ?? "image/jpeg" };
  }

  // GET /v1/cameras/{id}/rtsps-stream
  async getRtspsStreams(id: string): Promise<RtspsStreams> {
    return await this.#request<RtspsStreams>("GET", `/v1/cameras/${encodeURIComponent(id)}/rtsps-stream`);
  }

  // POST /v1/cameras/{id}/rtsps-stream — create/enable the given qualities.
  async createRtspsStreams(id: string, qualities: Quality[]): Promise<RtspsStreams> {
    return await this.#request<RtspsStreams>(
      "POST",
      `/v1/cameras/${encodeURIComponent(id)}/rtsps-stream`,
      { qualities },
    );
  }

  // Resolve a playable RTSPS URL for (camera, quality): use an existing stream, else
  // create the requested set on the console. `wanted` is the full quality set to enable
  // if creation is needed (so we don't churn one quality at a time). Cached with a TTL.
  async ensureRtspsUrl(id: string, quality: Quality, wanted: Quality[]): Promise<string | null> {
    const cacheKey = `${id}:${quality}`;
    const now = Date.now();
    const hit = this.#rtspsCache.get(cacheKey);
    if (hit && hit.exp > now) return hit.url;

    let streams = await this.getRtspsStreams(id).catch(() => ({} as RtspsStreams));
    let url = streams[quality] ?? null;
    if (!url) {
      streams = await this.createRtspsStreams(id, wanted);
      url = streams[quality] ?? null;
    }
    if (url) this.#rtspsCache.set(cacheKey, { url, exp: now + this.#rtspsTtlMs });
    return url;
  }

  #wsUrl(path: string): string {
    return this.#base.replace(/^http/, "ws") + path;
  }

  // Long-lived WS with auto-reconnect. Runs until `signal` aborts. Delivers normalized
  // camera events from /v1/subscribe/events.
  async subscribeEvents(onEvent: (e: ProtectEvent) => void, signal: AbortSignal): Promise<void> {
    await this.#subscribeLoop("/v1/subscribe/events", (raw) => {
      try {
        const msg = JSON.parse(raw) as { type: "add" | "update"; item: Record<string, unknown> };
        const item = msg.item;
        if (!item || typeof item.device !== "string" || typeof item.id !== "string") return;
        onEvent({
          id: item.id as string,
          kind: String(item.type ?? "event"),
          cameraId: item.device as string,
          start: Number(item.start ?? Date.now()),
          end: item.end == null ? null : Number(item.end),
          action: msg.type === "update" ? "update" : "add",
        });
      } catch (e) {
        log("debug", "bad event message", { err: errMsg(e) });
      }
    }, signal);
  }

  // /v1/subscribe/devices — raw device update messages (state/motion). Parsed leniently.
  async subscribeDevices(onDevice: (msg: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
    await this.#subscribeLoop("/v1/subscribe/devices", (raw) => {
      try {
        onDevice(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        log("debug", "bad device message", { err: errMsg(e) });
      }
    }, signal);
  }

  async #subscribeLoop(path: string, onText: (raw: string) => void, signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      let opened = false;
      await connectWs(
        this.#wsUrl(path),
        { "X-API-KEY": this.#apiKey },
        {
          onOpen: () => {
            opened = true;
            backoff = 1000;
            log("info", "subscription open", { path });
          },
          onMessage: onText,
          onClose: (code, reason) => log("debug", "subscription closed", { path, code, reason }),
        },
        signal,
      );
      if (signal.aborted) break;
      // If we never opened, back off harder (auth/network issue) up to 30s.
      backoff = opened ? 1000 : Math.min(backoff * 2, 30000);
      await sleep(backoff, signal);
    }
  }
}
