// Live video: remux the camera's RTSPS stream to fragmented MP4 with ffmpeg and pipe
// it to the browser over a WebSocket, where it is fed to MediaSource Extensions (MSE).
//
// The Protect Integration API only exposes RTSPS (not browser-playable), so this is the
// bridge. One ffmpeg per client socket (simple + correct: each client gets its own init
// segment; no late-join box-replay). Protocol on /ws/live/<id>/<quality>:
//   1. server -> client  TEXT  {"type":"init","mime":"video/mp4; codecs=\"...\""}
//   2. server -> client  BINARY  fMP4 (ftyp+moov, then moof+mdat fragments)
// ffmpeg/ffprobe are Nix runtime deps on PATH (see module.nix). ZERO external imports.

import { Config, Quality } from "./config.ts";
import { ProtectClient } from "./protect.ts";
import { errMsg, log } from "./util.ts";

// Close the socket once its send buffer exceeds this — the client then reconnects and
// gets a FRESH init segment. We must NOT silently drop mid-stream chunks: fMP4 fragments
// span multiple stdout reads, so dropping bytes corrupts the SourceBuffer (which MSE
// cannot resync at the byte level). Closing → reconnect is the only clean recovery.
const MAX_BUFFERED = 16 * 1024 * 1024;

// ffmpeg args to remux one RTSPS input to MSE-friendly fragmented MP4 on stdout. Video is
// copied (no re-encode — cheap, many cameras). Audio is transcoded to AAC-LC (MSE needs
// it) ONLY when the source has an audio track; otherwise `-an`, so the advertised mime and
// the actual output stay in sync (advertising phantom audio stalls MSE). Exported for tests.
export function buildFfmpegArgs(rtspsUrl: string, hasAudio: boolean): string[] {
  return [
    "-nostdin",
    "-loglevel",
    "error",
    "-rtsp_transport",
    "tcp",
    "-i",
    rtspsUrl,
    "-c:v",
    "copy",
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-f",
    "mp4",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
    "-frag_duration",
    "500000",
    "pipe:1",
  ];
}

// H.264 profile name -> the profile_idc + constraint-flags nibble pair (PPCC in
// avc1.PPCCLL). The constraint byte differs by profile (e.g. Main is 4d40, High is
// 6400), so it's baked into the prefix rather than assumed zero.
const H264_PREFIX: Record<string, string> = {
  "Constrained Baseline": "42e0",
  Baseline: "4240",
  Main: "4d40",
  Extended: "5800",
  High: "6400",
  "High 10": "6e00",
  "High 4:2:2": "7a00",
  "High 4:4:4": "f400",
};

// Build an MSE codec string from ffprobe's video description. The audio part is included
// only when the source actually has audio (see buildFfmpegArgs). Falls back to H.264
// Main@4.1 — the common UniFi substream — when the profile/level can't be mapped.
// Exported (pure) for unit testing.
export function codecStringFromProbe(
  codecName: string | undefined,
  profile: string | undefined,
  level: number | undefined,
  hasAudio: boolean,
): string {
  const audio = hasAudio ? ", mp4a.40.2" : "";
  const name = (codecName ?? "").toLowerCase();
  if (name === "h264" || name === "avc1") {
    const prefix = H264_PREFIX[profile ?? ""] ?? "4d40";
    const ll = (typeof level === "number" && level > 0 ? level : 41).toString(16).padStart(2, "0");
    return `video/mp4; codecs="avc1.${prefix}${ll}${audio}"`;
  }
  if (name === "hevc" || name === "h265") {
    // HEVC in fMP4; MSE HEVC support is platform-dependent. Chromium accepts this generic
    // hvc1 form when the OS can decode; otherwise the client falls back to snapshots.
    return `video/mp4; codecs="hvc1.1.6.L120.B0${audio}"`;
  }
  return `video/mp4; codecs="avc1.4d4029${audio}"`;
}

interface ProbeResult {
  mime: string;
  hasAudio: boolean;
}

interface ProbeCacheEntry extends ProbeResult {
  exp: number;
}

export class StreamManager {
  #cfg: Config;
  #client: ProtectClient;
  #probeCache = new Map<string, ProbeCacheEntry>();
  #probeTtlMs = 10 * 60 * 1000;

  constructor(cfg: Config, client: ProtectClient) {
    this.#cfg = cfg;
    this.#client = client;
  }

  // ffprobe the RTSPS stream once to learn the video codec AND whether audio exists, so
  // the browser's SourceBuffer mime matches exactly what ffmpeg emits. Cached; falls back
  // to H.264 video-only on failure (dropping audio is safer than advertising a phantom
  // track, which stalls MSE).
  async #probe(key: string, rtspsUrl: string): Promise<ProbeResult> {
    const now = Date.now();
    const hit = this.#probeCache.get(key);
    if (hit && hit.exp > now) return { mime: hit.mime, hasAudio: hit.hasAudio };

    let result: ProbeResult = { mime: codecStringFromProbe(undefined, undefined, undefined, false), hasAudio: false };
    try {
      const cmd = new Deno.Command(this.#cfg.ffprobePath, {
        args: [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,codec_name,profile,level",
          "-of",
          "json",
          "-rtsp_transport",
          "tcp",
          rtspsUrl,
        ],
        stdout: "piped",
        stderr: "null",
        stdin: "null",
      });
      const out = await cmd.output();
      const parsed = JSON.parse(new TextDecoder().decode(out.stdout)) as {
        streams?: Array<{ codec_type?: string; codec_name?: string; profile?: string; level?: number }>;
      };
      const streams = parsed.streams ?? [];
      const video = streams.find((s) => s.codec_type === "video");
      const hasAudio = streams.some((s) => s.codec_type === "audio");
      result = { mime: codecStringFromProbe(video?.codec_name, video?.profile, video?.level, hasAudio), hasAudio };
    } catch (e) {
      log("debug", "ffprobe failed; using video-only default codec", { key, err: errMsg(e) });
    }
    this.#probeCache.set(key, { ...result, exp: now + this.#probeTtlMs });
    return result;
  }

  // Drive one browser live socket: resolve RTSPS, send the init message, spawn ffmpeg,
  // pump fMP4 to the socket, and reap ffmpeg when the socket (or stream) ends.
  serve(sock: WebSocket, cameraId: string, quality: Quality): void {
    let proc: Deno.ChildProcess | null = null;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      if (proc) {
        try {
          proc.kill("SIGKILL");
        } catch { /* already exited */ }
        // Consume the exit status so the child is actually reaped (kill() only signals);
        // otherwise the process handle/zombie leaks per socket.
        proc.status.catch(() => {});
      }
      try {
        if (sock.readyState === WebSocket.OPEN) sock.close();
      } catch { /* ignore */ }
    };

    sock.onclose = cleanup;
    sock.onerror = cleanup;

    const start = async () => {
      try {
        const url = await this.#client.ensureRtspsUrl(cameraId, quality, this.#cfg.streamQualities);
        if (!url) {
          sock.send(JSON.stringify({ type: "error", message: "no RTSPS stream available" }));
          return cleanup();
        }
        const probe = await this.#probe(`${cameraId}:${quality}`, url);
        if (done || sock.readyState !== WebSocket.OPEN) return cleanup();
        sock.send(JSON.stringify({ type: "init", mime: probe.mime }));

        proc = new Deno.Command(this.#cfg.ffmpegPath, {
          args: buildFfmpegArgs(url, probe.hasAudio),
          stdout: "piped",
          stderr: "piped",
          stdin: "null",
        }).spawn();

        // Log ffmpeg stderr (rate is low at -loglevel error) without blocking stdout.
        (async () => {
          try {
            const dec = new TextDecoder();
            for await (const chunk of proc!.stderr) {
              const msg = dec.decode(chunk).trim();
              if (msg) log("debug", "ffmpeg", { cameraId, quality, msg: msg.slice(0, 300) });
            }
          } catch { /* stderr closed */ }
        })();

        for await (const chunk of proc.stdout) {
          if (done || sock.readyState !== WebSocket.OPEN) break;
          if (sock.bufferedAmount > MAX_BUFFERED) {
            // Don't corrupt the stream by dropping mid-fragment bytes — close and let the
            // client reconnect with a fresh init segment.
            log("warn", "live socket backpressure; closing for reconnect", { cameraId, quality });
            break;
          }
          sock.send(chunk);
        }
      } catch (e) {
        log("warn", "live stream error", { cameraId, quality, err: errMsg(e) });
      } finally {
        cleanup();
      }
    };

    if (sock.readyState === WebSocket.OPEN) start();
    else sock.onopen = () => start();
  }
}
