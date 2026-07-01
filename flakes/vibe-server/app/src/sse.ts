// Read-only Server-Sent-Events view of a session's log. The client REPLACES its
// view with each snapshot (a full superset), so the page mirrors the current state.
// A single async loop (driven by an AbortController, not overlapping setIntervals)
// polls every 700ms and emits a keepalive every ~15s — so no timer can fire after
// the stream is cancelled. ZERO external imports.
//
// `streamSessionLog` serves ONE of two sources, switching automatically:
//   - Claude's complete JSONL TRANSCRIPT (the full, append-only conversation; see
//     transcript.ts) — the default, rendered INCREMENTALLY (only new bytes parsed
//     per tick) so a marathon session never re-parses its whole file on the
//     single-threaded event loop.
//   - the terminal SCREEN (term.ts grid emulator over the raw PTY capture) as a
//     FALLBACK before the first turn writes any transcript (or when forced).
// It re-resolves the transcript every tick, so a session whose log is opened before
// its first turn upgrades terminal→transcript when the transcript appears, and a
// session that rolls its transcript (e.g. /clear starts a new sessionId.jsonl) is
// tracked to the new file — both without the viewer reconnecting.

import { TermFilter } from "./term.ts";
import { MAX_TRANSCRIPT_BYTES, renderRecord } from "./transcript.ts";

// Cap the live snapshot so a marathon session can't push a multi-MB string to every
// viewer; the tail is what you're watching anyway, and Download serves the full log.
const LIVE_RENDER_CAP = 512 * 1024;

function sseChunk(text: string): string {
  // One SSE event whose data is (possibly multi-line) text, blank-line terminated.
  // The leading space after "data:" is consumed by the EventSource parser, so the
  // line's own content (incl. any leading spaces) is preserved exactly.
  return text.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// Trim leading blank lines and tail-cap a rendered transcript to LIVE_RENDER_CAP,
// aligning the cut to a line boundary so the view never opens mid-line.
function capSnapshot(rendered: string): string {
  let snap = rendered.replace(/^\s+/u, "");
  if (snap.length > LIVE_RENDER_CAP) {
    let tail = snap.slice(snap.length - LIVE_RENDER_CAP);
    const nl = tail.indexOf("\n");
    if (nl >= 0) tail = tail.slice(nl + 1); // drop the partial first line
    snap = "… (earlier history truncated — use Download for the full log)\n\n" + tail;
  }
  return snap;
}

// Serve a session's log over SSE. `resolveTranscript` returns the session's current
// transcript path (or null when there's none yet / it's forced off); it's called
// every tick so the source can upgrade/roll live. `logPath` is the raw PTY capture
// used for the terminal fallback.
export function streamSessionLog(
  logPath: string,
  resolveTranscript: () => Promise<string | null>,
): Response {
  const enc = new TextEncoder();
  const ac = new AbortController();

  // Transcript-mode incremental state.
  let transcriptPath: string | null = null;
  let tOffset = -1; // -1 = uninitialized; set to the tail start on first read
  let tPending = ""; // decoded-but-incomplete trailing JSONL line
  let tRendered = ""; // accumulated rendered transcript text
  let tDecoder = new TextDecoder(); // streaming: buffers incomplete UTF-8 across reads

  // Terminal-fallback incremental state.
  const term = new TermFilter();
  let termOffset = 0;

  let current = ""; // the latest rendered snapshot (transcript or terminal)
  let lastSent: string | null = null;

  // Append only the NEW bytes of the bound transcript and render the complete lines
  // among them. Returns true when `tRendered` changed. Best-effort: a transient read
  // error just returns false and is retried next tick.
  const appendTranscript = async (): Promise<boolean> => {
    let size = 0;
    try {
      size = (await Deno.stat(transcriptPath!)).size;
    } catch {
      return false;
    }
    if (tOffset < 0) {
      // First read: skip to the last MAX_TRANSCRIPT_BYTES so the initial parse is
      // bounded (the clipped leading partial line is dropped as unparseable).
      tOffset = size > MAX_TRANSCRIPT_BYTES ? size - MAX_TRANSCRIPT_BYTES : 0;
    }
    if (size < tOffset) {
      // File shrank (truncation/rollover) — restart from its tail.
      tOffset = size > MAX_TRANSCRIPT_BYTES ? size - MAX_TRANSCRIPT_BYTES : 0;
      tPending = "";
      tRendered = "";
      tDecoder = new TextDecoder();
    }
    if (size <= tOffset) return false; // no growth
    let chunk = "";
    const file = await Deno.open(transcriptPath!, { read: true });
    try {
      await file.seek(tOffset, Deno.SeekMode.Start);
      const buf = new Uint8Array(size - tOffset);
      let off = 0;
      while (off < buf.length) {
        const n = await file.read(buf.subarray(off));
        if (n === null) break;
        off += n;
      }
      tOffset += off;
      chunk = tDecoder.decode(buf.subarray(0, off), { stream: true });
    } finally {
      try {
        file.close();
      } catch { /* ignore */ }
    }
    const data = tPending + chunk;
    const nl = data.lastIndexOf("\n");
    if (nl < 0) {
      tPending = data;
      return false; // no complete line yet
    }
    tPending = data.slice(nl + 1);
    let changed = false;
    for (const line of data.slice(0, nl).split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(t);
      } catch {
        continue;
      }
      const s = renderRecord(rec);
      if (s) {
        tRendered += s;
        changed = true;
      }
    }
    return changed;
  };

  // Pull new bytes of the raw PTY capture into the grid emulator. Returns true when
  // the screen changed.
  const pullTerminal = async (): Promise<boolean> => {
    const file = await Deno.open(logPath, { read: true }).catch(() => null);
    if (!file) return false;
    let grew = false;
    try {
      await file.seek(termOffset, Deno.SeekMode.Start);
      const buf = new Uint8Array(65536);
      while (true) {
        const n = await file.read(buf);
        if (n === null) break;
        termOffset += n;
        term.push(buf.subarray(0, n)); // synchronous: consumes before the next read
        grew = true;
      }
    } finally {
      try {
        file.close();
      } catch { /* ignore */ }
    }
    return grew;
  };

  // Refresh `current` from whichever source applies. Swallows errors so a transient
  // failure keeps the last snapshot and simply retries next tick.
  const update = async (): Promise<void> => {
    try {
      const tp = await resolveTranscript();
      if (tp && tp !== transcriptPath) {
        // Bind (first turn) or rebind (transcript rolled, e.g. /clear): reset the
        // incremental state and switch to transcript mode.
        transcriptPath = tp;
        tOffset = -1;
        tPending = "";
        tRendered = "";
        tDecoder = new TextDecoder();
      }
      if (transcriptPath) {
        const changed = await appendTranscript();
        if (changed) current = capSnapshot(tRendered);
        return;
      }
      if (await pullTerminal()) current = term.render();
    } catch { /* keep `current`; retry next tick */ }
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sinceKeepalive = 0;
      while (!ac.signal.aborted) {
        await update();
        // Deliver whenever there's undelivered content AND the consumer isn't
        // backpressured — retried every tick (NOT gated on a fresh change), so a
        // snapshot skipped while a slow client was stalled still goes out once it
        // catches up, even if the source has since gone idle.
        const canSend = controller.desiredSize === null || controller.desiredSize > 0;
        if (current !== "" && current !== lastSent && canSend) {
          try {
            controller.enqueue(enc.encode(sseChunk(current)));
          } catch {
            break;
          }
          lastSent = current;
          sinceKeepalive = 0;
        } else {
          sinceKeepalive += 700;
          if (sinceKeepalive >= 15000) {
            sinceKeepalive = 0;
            try {
              controller.enqueue(enc.encode(": keepalive\n\n"));
            } catch {
              break;
            }
          }
        }
        await sleep(700);
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}
