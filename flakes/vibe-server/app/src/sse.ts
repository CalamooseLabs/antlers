// Read-only Server-Sent-Events tail of a session's captured log. A single async
// loop (driven by an AbortController, not overlapping setIntervals) polls from
// the last offset every 700ms and emits a keepalive every ~15s — so no timer can
// fire after the stream is cancelled. ZERO external imports.

function sseChunk(text: string): string {
  // One SSE event whose data is (possibly multi-line) text, blank-line terminated.
  return text.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export function streamLog(logPath: string): Response {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ac = new AbortController();
  let file: Deno.FsFile | null = null;
  let offset = 0;

  const close = () => {
    try {
      file?.close();
    } catch { /* ignore */ }
    file = null;
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Drain new bytes from the log into the stream. Returns false if the
      // controller is gone (cancelled) so the loop can stop.
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
          while (true) {
            const n = await file.read(chunk);
            if (n === null) break;
            offset += n;
            const text = dec.decode(chunk.subarray(0, n), { stream: true });
            if (text) controller.enqueue(enc.encode(sseChunk(text)));
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
