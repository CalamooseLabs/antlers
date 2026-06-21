// Read-only Server-Sent-Events view of a session's captured log. The captured
// bytes are raw PTY output from a full-screen TUI (`claude --remote-control`), so
// we don't tail them verbatim — we feed them through a terminal-grid emulator
// (term.ts) and emit the *rendered screen* as a snapshot whenever it changes. The
// client REPLACES its view with each snapshot, so the page mirrors what the
// session's terminal currently shows. A single async loop (driven by an
// AbortController, not overlapping setIntervals) polls every 700ms and emits a
// keepalive every ~15s — so no timer can fire after the stream is cancelled.
// ZERO external imports.

import { TermFilter } from "./term.ts";

function sseChunk(text: string): string {
  // One SSE event whose data is (possibly multi-line) text, blank-line terminated.
  // The leading space after "data:" is consumed by the EventSource parser, so the
  // line's own content (incl. any leading spaces) is preserved exactly.
  return text.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export function streamLog(logPath: string): Response {
  const enc = new TextEncoder();
  const ac = new AbortController();
  let file: Deno.FsFile | null = null;
  let offset = 0;
  // Rebuilt from byte 0 each time the stream is (re)opened, so a fresh viewer (or
  // an EventSource auto-reconnect) sees the full current screen, not a fragment.
  const term = new TermFilter();
  let lastSnap: string | null = null; // null sentinel: the first snapshot always sends

  const close = () => {
    try {
      file?.close();
    } catch { /* ignore */ }
    file = null;
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Pull new bytes from the log into the emulator and, if the rendered screen
      // changed, push one snapshot. Returns false if the controller is gone.
      const drain = async (): Promise<boolean> => {
        try {
          if (!file) {
            try {
              file = await Deno.open(logPath, { read: true });
            } catch {
              return true; // not created yet — try again next tick
            }
          }
          await file.seek(offset, Deno.SeekMode.Start);
          const chunk = new Uint8Array(65536);
          let grew = false;
          while (true) {
            const n = await file.read(chunk);
            if (n === null) break;
            offset += n;
            term.push(chunk.subarray(0, n)); // synchronous: consumes before next read
            grew = true;
          }
          if (grew) {
            const snap = term.render();
            // Each snapshot is a full-screen SUPERSET of any it would replace, so
            // when the consumer is backpressured (slow/stalled client) skip this
            // tick rather than queue another whole screen — the next changed
            // snapshot carries the latest state anyway. Without this, a busy TUI
            // (its spinner / counters mutate the rendered grid almost every poll,
            // defeating the snap!==lastSnap dedup) would grow the stream's internal
            // queue unbounded per stalled viewer (a start()-driven enqueue never
            // blocks). lastSnap is left unchanged on a skip so the latest screen
            // still sends once the consumer catches up.
            if (snap !== lastSnap && (controller.desiredSize === null || controller.desiredSize > 0)) {
              lastSnap = snap;
              controller.enqueue(enc.encode(sseChunk(snap)));
            }
          }
          return true;
        } catch {
          return false; // controller closed / read error after cancel
        }
      };

      let sinceKeepalive = 0;
      while (!ac.signal.aborted) {
        if (!(await drain())) break;
        sinceKeepalive += 700;
        if (sinceKeepalive >= 15000) {
          sinceKeepalive = 0;
          try {
            controller.enqueue(enc.encode(": keepalive\n\n"));
          } catch {
            break;
          }
        }
        await sleep(700);
      }
      close();
    },
    cancel() {
      ac.abort();
      close();
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
