// Interactive terminal attach client — `vibe-server attach …`, re-invoked from the
// same compiled binary (see main.ts + writeEndpointFile.attachBin) by the `vibe
// open` launcher. It bridges the local terminal to a running session's PTY over a
// loopback WebSocket (see attachSession in sessions.ts): raw PTY output is written
// to stdout and raw keystrokes are forwarded to the session, so it behaves just
// like running `claude` in this terminal.
//
// Ctrl-C DETACHES rather than killing: in raw mode Ctrl-C arrives as the byte 0x03
// (ISIG is off), so we intercept it here and never forward it — the session keeps
// running in the background and can be re-attached later or driven from claude.ai.
// Use Esc to interrupt Claude's current turn.
//
// ZERO external imports (Deno globals only), like the rest of the app — this file
// is compiled into the same binary, so it must not pull the deno-cache FOD off empty.

// Ctrl-C (ETX). The one key the client swallows to detach instead of forwarding.
export const DETACH_BYTE = 0x03;

export interface AttachArgs {
  url: string;
  token: string;
  id: string;
}

// Pure: parse `attach --url <u> --token <t> <id>` (flags in any order; the lone
// positional is the session id). Returns the parsed args or an { error } message.
// Kept pure + exported so it's unit-testable without a live server.
export function parseAttachArgs(args: string[]): AttachArgs | { error: string } {
  let url = "";
  let token = "";
  let id = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") url = args[++i] ?? "";
    else if (a === "--token") token = args[++i] ?? "";
    else if (a === "--id") id = args[++i] ?? "";
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else if (a.startsWith("--token=")) token = a.slice("--token=".length);
    else if (a.startsWith("--id=")) id = a.slice("--id=".length);
    else if (a.startsWith("-")) return { error: `unknown option: ${a}` };
    else if (!id) id = a; // the lone positional is the session id
    else return { error: `unexpected argument: ${a}` };
  }
  if (!url) return { error: "missing --url" };
  if (!token) return { error: "missing --token" };
  if (!id) return { error: "missing session id" };
  return { url, token, id };
}

// Pure: index of the first `byte` in `buf`, or -1. Used to spot the detach key in a
// keystroke burst (so any characters typed before it are still forwarded).
export function indexOfByte(buf: Uint8Array, byte: number): number {
  for (let i = 0; i < buf.length; i++) if (buf[i] === byte) return i;
  return -1;
}

// Pure: the WebSocket URL for a session's attach endpoint, derived from the
// discovery-file base URL (http→ws, https→wss).
export function attachWsUrl(base: string, id: string): string {
  return base.replace(/^http/, "ws") + `/api/local/sessions/${encodeURIComponent(id)}/attach`;
}

const enc = new TextEncoder();
function errln(msg: string): void {
  try {
    Deno.stderr.writeSync(enc.encode(msg + "\n"));
  } catch { /* ignore */ }
}

// Run the interactive attach. Exit codes: 0 = attached then detached / session
// ended (a normal outcome — do NOT fall back); 2 = never connected (the caller may
// fall back to the read-only screen stream); 1 = a usage / terminal error.
export function runAttach(args: string[]): void {
  const parsed = parseAttachArgs(args);
  if ("error" in parsed) {
    errln(`vibe attach: ${parsed.error}`);
    errln("usage: vibe-server attach --url <url> --token <token> <session-id>");
    Deno.exit(1);
  }
  const { url, token, id } = parsed;

  if (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal()) {
    errln("vibe attach: not a terminal");
    Deno.exit(2); // let the caller fall back to the read-only view
  }

  let connected = false;
  let finished = false;
  let raw = false;

  const cleanup = () => {
    if (raw) {
      try {
        Deno.stdin.setRaw(false);
      } catch { /* ignore */ }
      raw = false;
    }
    // Terminal teardown. We render the session's RAW PTY bytes verbatim, which for a
    // fresh `claude --remote-control` include enter-alt-screen (ESC[?1049h), mouse
    // tracking (ESC[?1000/1002/1003/1006h) and bracketed paste (ESC[?2004h). The
    // session keeps running when we detach, so it never emits the disables — we must,
    // or the parent terminal is left stuck on the alt buffer with mouse/paste garbage
    // (needing a manual `reset`). Each sequence is a harmless no-op if its mode was
    // never set. Order: disable input modes, reset SGR/cursor/scroll-region, then
    // leave the alt-screen last so the pre-attach screen is restored.
    try {
      Deno.stdout.writeSync(enc.encode(
        "\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + // bracketed paste + mouse off
          "\x1b[0m\x1b[?25h\x1b[r" + // SGR reset, cursor on, scroll region reset
          "\x1b[?1049l", // leave alt-screen (restores the pre-attach screen)
      ));
    } catch { /* ignore */ }
  };

  const finish = (msg: string, code: number) => {
    if (finished) return;
    finished = true;
    cleanup();
    errln(`\r\nvibe: ${msg}`);
    Deno.exit(code);
  };

  // A termination signal (window closing, or an external `kill -INT` while raw mode
  // is on) must still restore the tty — otherwise the terminal is left raw + on the
  // alt-screen. Keyboard Ctrl-C is NOT this: in raw mode it arrives as the byte 0x03
  // (ISIG off) and drives the detach path below, so a SIGINT handler only fires for
  // an out-of-band SIGINT.
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    try {
      Deno.addSignalListener(sig, () => finish("terminated", connected ? 0 : 2));
    } catch { /* signal unavailable */ }
  }

  errln(`vibe: attaching to ${id} — Ctrl-C detaches (the session keeps running); Esc interrupts Claude.`);

  let socket: WebSocket;
  try {
    // The auth token rides in the WebSocket subprotocol — a WebSocket client can't
    // set request headers, and the server validates it there (see the attach route).
    socket = new WebSocket(attachWsUrl(url, id), [token]);
  } catch (e) {
    finish(`could not attach: ${e instanceof Error ? e.message : String(e)}`, 2);
    return;
  }
  socket.binaryType = "arraybuffer";

  const pumpStdin = async () => {
    const buf = new Uint8Array(4096);
    while (!finished) {
      let n: number | null;
      try {
        n = await Deno.stdin.read(buf);
      } catch {
        finish("input closed", connected ? 0 : 2);
        return;
      }
      if (n === null) { // stdin EOF
        finish("input closed", connected ? 0 : 2);
        return;
      }
      const bytes = buf.subarray(0, n);
      const k = indexOfByte(bytes, DETACH_BYTE);
      if (k >= 0) {
        // Forward anything typed before the Ctrl-C, then detach (never forward 0x03).
        if (k > 0 && socket.readyState === WebSocket.OPEN) socket.send(bytes.slice(0, k));
        try {
          socket.close(1000, "detach");
        } catch { /* already closing */ }
        finish("detached (session still running)", 0);
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(bytes.slice()); // copy: buf is reused
    }
  };

  socket.onopen = () => {
    connected = true;
    try {
      Deno.stdin.setRaw(true);
      raw = true;
    } catch (e) {
      finish(`cannot set raw mode: ${e instanceof Error ? e.message : String(e)}`, 1);
      return;
    }
    void pumpStdin();
  };

  socket.onmessage = (e) => {
    try {
      const d = e.data;
      if (d instanceof ArrayBuffer) Deno.stdout.writeSync(new Uint8Array(d));
      else if (typeof d === "string") Deno.stdout.writeSync(enc.encode(d));
    } catch { /* stdout closed — the close/error handlers finish up */ }
  };

  socket.onclose = () => finish(connected ? "session ended" : "could not attach (is the session running?)", connected ? 0 : 2);
  socket.onerror = () => finish(connected ? "connection error" : "could not attach (is vibe-server running?)", connected ? 0 : 2);
}
