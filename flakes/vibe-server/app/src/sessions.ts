// Session lifecycle: spawn (env-allowlisted), track, kill, snapshot/recover
// across restarts, and a periodic reaper. ZERO external imports.

import { b64url, isError, log } from "./util.ts";
import { buildEnv, configDir, seedTrust } from "./claude.ts";
import { ActivityScraper, type InteractionState } from "./activity.ts";
import { findTranscript, readTail } from "./transcript.ts";
import type { PresetConfig, ServerConfig } from "./config.ts";

// A live subscriber to a session's raw PTY output (the interactive terminal
// attach; see attachSession). `chunk` receives each raw stdout burst verbatim;
// `end` fires once when the session's streams drain (process gone). Registered
// only for server-spawned pty sessions with a live pump.
export interface OutputSub {
  chunk(bytes: Uint8Array): void;
  end(): void;
}

// How much of the raw PTY capture to replay to a freshly-attached client as its
// first paint, so it sees the session's CURRENT screen immediately rather than a
// blank one until Claude's next repaint. `claude --remote-control` is a
// full-screen TUI that repaints its whole viewport with absolute cursor
// positioning, so the last screenful of raw bytes reproduces the live screen (in
// colour). A partial leading escape is harmless — the terminal ignores it and the
// next full repaint corrects everything.
const ATTACH_REPLAY_BYTES = 256 * 1024;

// Process lifecycle. "booting" is the startup window between spawn and the first
// output (Claude Code coming up); it becomes "running" once output flows.
export type Status = "booting" | "running" | "terminating" | "exited" | "failed";

export interface SessionInfo {
  id: string;
  // The preset this session was started from (server-spawned only; undefined for
  // an external, self-registered `vibe`). Used to re-resolve its commit settings.
  preset?: string;
  path: string;
  name: string;
  pid: number;
  status: Status;
  // The AI INTERACTION state (distinct from the process `status`): is the model
  // thinking, did it just finish a turn, or is it waiting for input. Set by the
  // output scraper (heuristic) and/or by Claude Code hooks (authoritative). Absent
  // until first known.
  state?: InteractionState;
  // True once a hook has reported state. Hooks are authoritative — they alone emit
  // "completed" — so the moment one speaks, the heuristic scraper stops touching
  // `state` (otherwise it would clobber a fresh "completed" with "ready" within a
  // poll, hiding it). The scraper drives state only until the first hook fires.
  stateFromHook?: boolean;
  // Latest token count scraped from the session's status line ("↑ N tokens").
  tokens?: number;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  // The resolved spawn command (shown in the UI's log/metadata view).
  command?: string;
  // Set when the session's early output contained a Claude/Anthropic login URL —
  // the UI renders it as a clickable link so the user can authenticate.
  loginUrl?: string;
  // True for a session a manually-run `vibe` self-registered (POST /api/register)
  // rather than one the server spawned. It has no child handle and no captured
  // log; the launcher heartbeats to keep it "running". The UI reflects it (status
  // + diff) but hides Logs/Kill (its output lives in the user's own terminal).
  external?: boolean;
}

interface Session {
  info: SessionInfo;
  child: Deno.ChildProcess | null; // null for sessions re-adopted after a restart
  logPath: string;
  // The PTY's input side, so the web UI can type into the session's prompt (see
  // sendInput). Present only for server-spawned pty sessions; absent for headless
  // (pty=false) and re-adopted sessions (no child handle → no stdin). Closed on exit.
  inputWriter?: WritableStreamDefaultWriter<Uint8Array>;
  // Serializes typed-input sends (see sendInput) AND raw interactive keystrokes
  // (see writeRawInput): every write chains onto the previous so a message send and
  // a live attach typing into the same session can't interleave their bytes.
  sendChain?: Promise<void>;
  // Live subscribers to the raw PTY output — the interactive terminal attach
  // (attachSession). Present only for server-spawned pty sessions with a running
  // pump; the pump broadcasts each stdout chunk here, and drains fire `end`.
  outputSubs?: Set<OutputSub>;
  // Set true (synchronously) once the pump has drained and outputSubs was cleared,
  // so an attach whose WebSocket opens AFTER the session already exited detects it
  // and closes instead of subscribing to a set that will never drain again.
  outputEnded?: boolean;
  // For external (self-registered) sessions: the per-registration token the
  // launcher echoes back on heartbeat/deregister, and the last heartbeat time.
  deregToken?: string;
  lastSeen?: number;
}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 100;
// Prune below MAX (not just to it) so a burst of concurrent spawns can't each
// see size < MAX and all skip pruning.
const PRUNE_TARGET = MAX_SESSIONS - 10;

// First Claude/Anthropic auth URL a not-logged-in session prints to its output.
// (claude.com is the host of the `claude auth login` /cai/oauth/ flow.) The stop
// class excludes control chars so a URL wrapped in OSC-8 terminal escapes is
// captured cleanly (mirrors claude.ts LOGIN_URL_RE).
// deno-lint-ignore no-control-regex -- the \x00-\x1f stop class is intentional (terminal escapes).
const AUTH_URL_RE = /(https?:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|auth\.anthropic\.com|login\.anthropic\.com)\/[^\s\x00-\x1f"'<>\\]+)/;

export function listSessions(): SessionInfo[] {
  return [...sessions.values()].map((s) => s.info);
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

// Resolve a server-spawned session's current Claude JSONL transcript path, or null.
// Re-resolved on every call (NOT cached) so the log view follows the session live:
// it returns null before the first turn (caller serves the terminal view, then
// upgrades when the transcript appears) and tracks the newest transcript if the
// session rolls one (e.g. `/clear` starts a new sessionId.jsonl). External sessions
// run under the user's own config dir, not ours, so they're skipped (they also have
// no captured log).
export async function getTranscriptPath(s: Session): Promise<string | null> {
  if (s.info.external) return null;
  return await findTranscript(configDir(), s.info.path, s.info.startedAt);
}

export function sessionCount(): number {
  return sessions.size;
}

// Authoritatively set a server-owned session's interaction state (+ optional token
// count) — called from the loopback callback a Claude Code hook hits. Overrides the
// heuristic scraper. Ignores unknown / external sessions. Returns whether it applied.
export function setSessionState(id: string, state: InteractionState, tokens?: number): boolean {
  const s = sessions.get(id);
  if (!s || s.info.external) return false;
  s.info.state = state;
  s.info.stateFromHook = true; // hooks now own state; the scraper backs off (see pump)
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
    s.info.tokens = Math.round(tokens);
  }
  return true;
}

export function substitute(cmd: string[], vars: Record<string, string>): string[] {
  return cmd.map((part) => {
    let r = part;
    for (const [k, v] of Object.entries(vars)) r = r.replaceAll(`@${k}@`, v);
    return r;
  });
}

// POSIX single-quote escaping, for building the `script -c <string>` argument
// (the only way util-linux `script` accepts a command). Safe for paths/args with
// spaces or shell metacharacters.
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function pidAlive(pid: number): boolean {
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

// Evict oldest terminated sessions (and their logs) when over the cap, down to
// PRUNE_TARGET. Running sessions are never evicted.
async function pruneSessions(): Promise<void> {
  if (sessions.size < MAX_SESSIONS) return;
  const terminal = [...sessions.values()]
    .filter((s) => s.info.status !== "running" && s.info.status !== "terminating")
    .sort((a, b) => (a.info.exitedAt ?? a.info.startedAt) - (b.info.exitedAt ?? b.info.startedAt));
  for (const s of terminal) {
    if (sessions.size <= PRUNE_TARGET) break;
    sessions.delete(s.info.id);
    try {
      await Deno.remove(s.logPath);
    } catch { /* ignore */ }
  }
}

export async function spawnSession(config: ServerConfig, preset: PresetConfig): Promise<SessionInfo> {
  await pruneSessions();

  // The first preset directory is the session's working dir; the rest are added
  // via the launcher's `claude --add-dir`. Trust every one (+ mark onboarding
  // complete) so none blocks on the workspace-trust dialog / theme picker. Idempotent.
  const cwd = preset.directories[0];
  for (const d of preset.directories) await seedTrust(config, d);

  const id = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const prefix = config.sessionNamePrefix ? `${config.sessionNamePrefix}-` : "";
  const name = `${prefix}${preset.name}-${id.slice(0, 4)}`;
  const logDir = `${config.stateDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });
  const logPath = `${logDir}/${id}.log`;
  const logFile = await Deno.open(logPath, { create: true, write: true, append: true });

  // @PRESET@ -> `@<name>` so the launcher applies the preset (its dirs/branch/pins);
  // @DIR@/@NAME@ keep working for a custom sessionCommand.
  const resolved = substitute(config.sessionCommand, { DIR: cwd, NAME: name, PRESET: `@${preset.name}` });

  // setsid so the session leads its own process group (kill(-pid) reaps the
  // tree). Credentials reach claude via the allowlisted env, never as CLI args,
  // so they don't land in /proc/<pid>/cmdline or the captured log.
  //
  // PTY: Claude Code auto-detects a non-TTY stdin/stdout and drops into `--print`
  // (headless) mode, which needs a prompt — so `claude --remote-control` spawned
  // with piped stdio dies with "Input must be provided … when using --print". We
  // allocate a pseudo-terminal with util-linux `script` so it runs interactively;
  // `script` mirrors the child's output to its stdout (our pipe) and keeps the PTY
  // master open, so the session's stdin doesn't hit EOF. Disable via `pty = false`
  // for a genuinely headless `sessionCommand` (e.g. `claude -p …`).
  // Size the PTY before the command runs. `claude --remote-control` repaints a
  // full-screen viewport sized to the terminal; `script`'s pipe-backed PTY reports
  // 0×0, so Claude/Ink falls back to ~80×24 and clips longer output to the last
  // screenful. `stty` runs on the -c command's controlling tty (the PTY itself), so
  // the size is set before claude reads it; errors are swallowed (the size is
  // best-effort). ptyRows/ptyCols are config integers, so the interpolation can't
  // inject shell. Each dimension is independent — 0 = leave that one at the default
  // (e.g. ptyRows alone emits `stty rows N`). Only the `pty` branch reaches `stty`.
  const ptyCmd = (() => {
    const cmd = resolved.map(shQuote).join(" ");
    const dims: string[] = [];
    if (config.ptyRows > 0) dims.push(`rows ${config.ptyRows}`);
    if (config.ptyCols > 0) dims.push(`cols ${config.ptyCols}`);
    return dims.length ? `stty ${dims.join(" ")} 2>/dev/null; ${cmd}` : cmd;
  })();
  const [setsidBin, ...setsidArgs] = config.pty
    ? ["setsid", "script", "-q", "-f", "-e", "-c", ptyCmd, "/dev/null"]
    : ["setsid", ...resolved];

  const cmd = new Deno.Command(setsidBin, {
    args: setsidArgs,
    cwd,
    // TERM gives the PTY a sane terminal type; an allowlisted TERM overrides it.
    // VIBE_MANAGED tells the `vibe` launcher this session is already tracked by
    // the server, so it skips self-registration (POST /api/register).
    // VIBE_STATE_* let the session's Claude Code hooks report interaction state back
    // over loopback (POST /api/session-state); the report script no-ops without them,
    // so interactive/hand-run sessions are unaffected. These names aren't in the
    // default claude env allowlist, so the buildEnv spread normally can't clobber them
    // (an operator who adds one to extraEnv would override it — don't).
    env: {
      TERM: "xterm-256color",
      VIBE_MANAGED: "1",
      VIBE_STATE_URL: `http://127.0.0.1:${config.port}/api/session-state`,
      VIBE_STATE_TOKEN: regToken,
      VIBE_SESSION_ID: id,
      ...buildEnv(config),
    },
    // A pty session gets a piped stdin so the web UI can type into the prompt:
    // `script` forwards whatever we write to it into the child's PTY (the exact
    // channel claude auth login's code-paste uses). Headless commands keep it null.
    stdin: config.pty ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });

  let child: Deno.ChildProcess;
  try {
    child = cmd.spawn();
  } catch (e) {
    try {
      logFile.close();
    } catch { /* ignore */ }
    throw new Error(`Failed to launch session: ${isError(e) ? e.message : String(e)}`);
  }

  // Hold the PTY's input side for sendInput. Only `config.pty` spawns a piped
  // stdin (accessing child.stdin otherwise throws), so guard on it.
  const inputWriter = config.pty ? child.stdin.getWriter() : undefined;

  // Live subscribers to the raw PTY output, for the interactive terminal attach.
  // Only meaningful with a pty (there's no captured TUI otherwise); the pump below
  // broadcasts each stdout burst to them.
  const outputSubs = new Set<OutputSub>();

  const info: SessionInfo = {
    id,
    preset: preset.name,
    path: cwd,
    name,
    pid: child.pid,
    status: "booting", // → "running" on first output (see the pump below)
    startedAt: Date.now(),
    command: resolved.join(" "),
  };

  const enc = new TextEncoder();
  await logFile.write(
    enc.encode(`# vibe session ${name}\n# dir: ${cwd}\n# cmd: ${resolved.join(" ")}\n\n`),
  );

  // Scan the start of the output for a login URL so the UI can surface it.
  const dec = new TextDecoder();
  const SCAN_LIMIT = 64 * 1024;
  let scanBuf = "";
  const scan = (chunk: Uint8Array) => {
    if (info.loginUrl || scanBuf.length > SCAN_LIMIT) return;
    scanBuf += dec.decode(chunk, { stream: true });
    const m = scanBuf.match(AUTH_URL_RE);
    if (m) info.loginUrl = m[1];
  };

  // Bound the captured log: once the cap is hit, stop appending (a size cap, not
  // rotation — rotation would break the offset-based SSE tail).
  let logBytes = 0;
  let capped = false;
  const writeLog = async (chunk: Uint8Array) => {
    if (config.maxLogBytes > 0 && logBytes >= config.maxLogBytes) {
      if (!capped) {
        capped = true;
        try {
          await logFile.write(enc.encode("\n# [log truncated: size cap reached]\n"));
        } catch { /* ignore */ }
      }
      return;
    }
    try {
      await logFile.write(chunk);
      logBytes += chunk.length;
    } catch { /* log closed */ }
  };

  // Heuristic interaction-state + token scraper, fed from the PTY output (stdout).
  // Best-effort: hooks override it when wired. The first output also flips the
  // session "booting" → "running".
  const activity = new ActivityScraper();
  const pump = async (stream: ReadableStream<Uint8Array>, scrape: boolean) => {
    for await (const chunk of stream) {
      if (info.status === "booting") info.status = "running";
      scan(chunk);
      if (scrape) {
        activity.push(chunk);
        // Hooks are authoritative: once one has reported (stateFromHook), the
        // scraper must NOT touch `state` — else it would overwrite a fresh
        // "completed" with "ready" on the next eval and the user would never see it.
        // Tokens have no hook source, so keep scraping them regardless.
        if (!info.stateFromHook && activity.state && info.state !== activity.state) {
          info.state = activity.state;
        }
        if (activity.tokens !== undefined && info.tokens !== activity.tokens) info.tokens = activity.tokens;
        // Fan the raw stdout out to any interactive attach clients verbatim (only
        // stdout carries the TUI; stderr is `script`'s own diagnostics). A slow/
        // broken subscriber must not stall the pump or its peers, so each send is
        // isolated — a throwing sub is dropped rather than propagated.
        if (outputSubs.size) {
          for (const sub of outputSubs) {
            try {
              sub.chunk(chunk);
            } catch {
              outputSubs.delete(sub);
            }
          }
        }
      }
      await writeLog(chunk);
    }
  };
  // Only the PTY (stdout) carries the TUI; stderr is `script`'s own diagnostics.
  const pumps = Promise.all([pump(child.stdout, true), pump(child.stderr, false)]);

  child.status.then((st) => {
    // A non-zero exit within the first couple of seconds almost always means the
    // session never really started (bad cwd, missing creds, etc.).
    info.status = Date.now() - info.startedAt < 2000 && st.code !== 0 ? "failed" : "exited";
    info.exitedAt = Date.now();
    info.exitCode = st.code;
    void saveSnapshot(config.stateDir);
  }).catch(() => {
    info.status = "failed";
    info.exitedAt = Date.now();
  });
  pumps.then(() => {
    try {
      logFile.close();
    } catch { /* ignore */ }
    // Streams drained ⇒ the process is gone; release the stdin writer (best-effort,
    // it may already be errored). Closing sends EOF to `script`, which is harmless
    // post-exit.
    if (inputWriter) inputWriter.close().catch(() => {});
    // Tell any interactive attach clients the session ended so they detach cleanly,
    // and flag the end synchronously BEFORE clearing so an attach mid-handshake (its
    // sub not yet registered) sees it and closes rather than orphaning itself.
    const self = sessions.get(id);
    if (self) self.outputEnded = true;
    for (const sub of outputSubs) {
      try {
        sub.end();
      } catch { /* ignore */ }
    }
    outputSubs.clear();
  });

  sessions.set(id, { info, child, logPath, inputWriter, outputSubs });
  void saveSnapshot(config.stateDir);
  return info;
}

export function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  // External (self-registered) sessions are never signalled from here: their pid
  // is a hand-run launcher we don't own, so kill(-pid) could hit the user's
  // terminal process group or — after PID reuse / under runAsRoot — an unrelated
  // process. They're managed from their own terminal; the DELETE route refuses
  // them before this, and this is defense-in-depth.
  if (s.info.external) return false;
  if (s.info.status === "exited" || s.info.status === "failed") {
    sessions.delete(id);
    return true;
  }
  if (s.info.status === "terminating") return true; // already being killed
  const term = (sig: Deno.Signal) => {
    try {
      Deno.kill(-s.info.pid, sig); // process group
    } catch {
      try {
        Deno.kill(s.info.pid, sig);
      } catch { /* already gone */ }
    }
  };
  s.info.status = "terminating";
  term("SIGTERM");
  setTimeout(() => {
    if (s.info.status === "terminating") term("SIGKILL");
  }, 5000);
  return true;
}

// ---- typed input into a running session's prompt (PTY write) ----
//
// The web UI can send a one-off message to a server-spawned session's Claude Code
// prompt: we write it into the session's PTY (via the held stdin writer, which
// `script` forwards to the child), then — after a brief pause — a lone CR to submit
// it (see inputChunks: the CR must not ride in on the text's write burst, or the
// TUI folds it into the prompt as a newline instead of submitting). This is NOT a
// substitute for Remote Control (no streamed reply here); it's a "type this and hit
// Enter" affordance.

// Cap on a single injected message (bytes of the normalized text, before the CR).
export const MAX_INPUT_BYTES = 16 * 1024;

// Pure: normalize a web-submitted message into the text typed at the prompt.
// Newlines collapse to spaces so a multi-line paste arrives as ONE prompt (rather
// than submitting line-by-line at each LF), and remaining control bytes are dropped
// so nothing can inject terminal escape sequences into the TUI. "" if empty.
export function cleanInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // deno-lint-ignore no-control-regex -- intentionally stripping C0 + DEL control bytes
  return raw.replace(/\r\n?|\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
}

// Pure: the two PTY writes a submitted message becomes — the cleaned text, then
// the Enter keypress (CR) as its OWN chunk. sendInput paces these apart in time
// because the Claude Code TUI tells a paste from typing by how an input burst
// arrives: when the text and a trailing CR land in one write, the whole burst
// reads as a paste and the CR becomes a literal newline in the prompt — so the
// message appears but never submits ("just sits there", the reported bug). A CR
// delivered on its own, after the text has drained, registers as a discrete
// Enter. Split out as a pure function so the two-chunk shape is unit-testable.
export function inputChunks(msg: string): [Uint8Array, Uint8Array] {
  const enc = new TextEncoder();
  return [enc.encode(msg), enc.encode("\r")];
}

// Pause between writing the message text and the Enter keypress, so the CR isn't
// swallowed into the text's write burst (see inputChunks). It's one delay per
// submitted message, so a value comfortably above any paste-coalescing window is
// effectively free. This rides on the TUI's (undocumented) paste-vs-typing burst
// heuristic rather than bracketed-paste markers — cleanInput strips ESC and this
// raw-PTY path has no terminal emulator, so timing is the only submit signal; it
// may need revisiting on a Claude Code TUI upgrade.
export const SUBMIT_DELAY_MS: number = 120;
// A zero/negative gap defeats the fix (the two writes coalesce into one read), so
// fail loudly at import rather than silently regress.
if (SUBMIT_DELAY_MS <= 0) throw new Error("SUBMIT_DELAY_MS must be > 0");

// Write one cleaned message into a PTY input writer as a *submitted* prompt: the
// text, then — after `delayMs` — the Enter (CR) as its own write. The pause is
// load-bearing: with both bytes in one write the child PTY coalesces them into a
// single read and the TUI reads the trailing CR as a paste newline, so nothing
// submits. Callers serialize this per session (see sendInput's sendChain) so two
// messages can't interleave their writes; kept separate so tests can drive it
// against a fake writer.
export async function submitInput(
  writer: { write(chunk: Uint8Array): Promise<void> },
  msg: string,
  delayMs: number = SUBMIT_DELAY_MS,
): Promise<void> {
  const [text, enter] = inputChunks(msg);
  await writer.write(text);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await writer.write(enter);
}

// True when a session can accept typed input: server-owned, running, and still
// holding a live PTY writer (not external, not re-adopted after a restart — those
// have no child handle and thus no stdin). Surfaced to the UI as `canInput`.
export function canSendInput(id: string): boolean {
  const s = sessions.get(id);
  return !!s && !s.info.external && s.info.status === "running" && !!s.inputWriter;
}

// Type a message into a running PTY session's prompt and submit it (text + CR).
// Returns an HTTP-shaped result the route maps directly (code is also set on
// success = 200). Best-effort: a write that races the process exiting is a 500.
export async function sendInput(
  id: string,
  raw: unknown,
): Promise<{ ok: boolean; code: number; error?: string }> {
  const s = sessions.get(id);
  if (!s) return { ok: false, code: 404, error: "Not found" };
  if (s.info.external) return { ok: false, code: 409, error: "External sessions are driven from their own terminal" };
  if (s.info.status !== "running") return { ok: false, code: 409, error: "Session is not running" };
  if (!s.inputWriter) return { ok: false, code: 409, error: "Input is unavailable for this session" };
  const msg = cleanInput(raw);
  if (!msg) return { ok: false, code: 400, error: "A message is required" };
  if (new TextEncoder().encode(msg).length > MAX_INPUT_BYTES) {
    return { ok: false, code: 400, error: "Message is too long" };
  }
  // Serialize sends per session. A message is two writes split by SUBMIT_DELAY_MS,
  // so concurrent POSTs to the same session would otherwise interleave (text A,
  // text B, CR, CR → one garbled merged submission). Chain each send onto the last
  // so its text+gap+CR finishes before the next starts — mirrors the snapshot
  // writer's chain (snapWriting). The stored chain swallows errors so one failed
  // send can't poison later ones; this caller still sees its own error via `run`.
  const writer = s.inputWriter;
  const run = (s.sendChain ?? Promise.resolve()).then(() => submitInput(writer, msg));
  s.sendChain = run.catch(() => {});
  try {
    await run;
    return { ok: true, code: 200 };
  } catch (e) {
    return { ok: false, code: 500, error: `Could not deliver message: ${isError(e) ? e.message : String(e)}` };
  }
}

// ---- interactive terminal attach (raw PTY passthrough) ----
//
// `vibe open` attaches a real terminal to a running server-spawned session and
// drives it like a normal `claude` in the terminal: keystrokes flow straight into
// the PTY (writeRawInput, NOT the sanitized sendInput one-shot path) and the raw
// PTY output streams back verbatim (attachSession broadcasts the pump's stdout).
// The transport is a loopback WebSocket, gated by the same discovery-file token as
// the other /api/local endpoints. Ctrl-C detach lives entirely in the client (it
// never forwards 0x03); the session keeps running when the client leaves.

// True when a session can be driven by an interactive attach: server-owned,
// running, and still holding a live PTY (input writer + output fan-out). Excludes
// external sessions (someone else's terminal) and sessions re-adopted after a
// restart (no child handle → no stdin / live pump). Surfaced to the CLI as
// `canInput` so `vibe open` knows whether to attach interactively or fall back to
// the read-only screen stream.
export function canAttach(id: string): boolean {
  const s = sessions.get(id);
  return !!s && !s.info.external && s.info.status === "running" && !!s.inputWriter && !!s.outputSubs;
}

// Write RAW bytes into a running session's PTY (the interactive attach's keystroke
// path). Unlike sendInput, nothing is sanitized or line-submitted — the client's
// exact key bytes (arrows, escapes, Enter, …) reach Claude Code as typed. Chained
// onto `sendChain` so a concurrent message-send (sendInput) and live typing can't
// interleave their writes. Returns false if the session can't take input.
export async function writeRawInput(id: string, bytes: Uint8Array): Promise<boolean> {
  const s = sessions.get(id);
  if (!s || s.info.external || s.info.status !== "running" || !s.inputWriter) return false;
  if (bytes.length === 0) return true;
  const writer = s.inputWriter;
  const run = (s.sendChain ?? Promise.resolve()).then(() => writer.write(bytes));
  s.sendChain = run.catch(() => {});
  try {
    await run;
    return true;
  } catch {
    return false;
  }
}

// Upgrade a request to a WebSocket that bridges a real terminal to the session's
// PTY: on open, replay the last screenful of raw output so the client paints the
// current screen immediately, then stream live output; inbound binary frames are
// the client's raw keystrokes, written straight into the PTY. Returns null when the
// session can't be attached interactively (the route then answers 409 and the CLI
// falls back to the read-only screen stream). `protocol` is echoed back as the
// accepted WebSocket subprotocol (the client passes the auth token there, since a
// WebSocket client can't set request headers).
export function attachSession(req: Request, id: string, protocol?: string): Response | null {
  if (!canAttach(id)) return null;
  const s = sessions.get(id)!;
  const subs = s.outputSubs!;

  let upgrade: { socket: WebSocket; response: Response };
  try {
    upgrade = Deno.upgradeWebSocket(req, protocol ? { protocol } : undefined);
  } catch {
    return null; // not a valid WebSocket handshake
  }
  const { socket, response } = upgrade;
  socket.binaryType = "arraybuffer";

  let sub: OutputSub | null = null;
  const detach = () => {
    if (sub) {
      subs.delete(sub);
      sub = null;
    }
  };

  socket.onopen = async () => {
    // Backpressure guard: if the client can't keep up, drop rather than buffer
    // unboundedly (Claude's next full repaint re-syncs the screen anyway).
    const trySend = (bytes: Uint8Array) => {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < (1 << 20)) socket.send(bytes);
    };
    // Register the subscriber FIRST — before the async readTail below — so a session
    // that drains DURING the replay await still delivers end() through our sub and
    // closes the socket, instead of the drain clearing outputSubs before we joined
    // and leaving us orphaned (client frozen on a dead session). Chunks that arrive
    // before the replay is sent are queued and flushed right after it, so live output
    // never races ahead of (or is lost behind) the first paint.
    let live = false;
    let ended = false;
    const queue: Uint8Array[] = [];
    sub = {
      chunk: (bytes) => {
        if (ended) return;
        if (live) trySend(bytes);
        else queue.push(bytes);
      },
      end: () => {
        ended = true;
        try {
          socket.close(1000, "session ended");
        } catch { /* already closing */ }
      },
    };
    subs.add(sub);
    // The pump may have already drained between the pre-upgrade canAttach check and
    // now (outputSubs cleared without seeing our sub); detect via the sync flag.
    if (s.outputEnded) {
      subs.delete(sub);
      try {
        socket.close(1000, "session ended");
      } catch { /* ignore */ }
      return;
    }
    // First paint: clear the client screen, then replay the tail of the raw PTY
    // capture so the CURRENT screen appears at once (see ATTACH_REPLAY_BYTES).
    try {
      trySend(new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x33, 0x4a, 0x1b, 0x5b, 0x48])); // ESC[2J ESC[3J ESC[H
      const tail = await readTail(s.logPath, ATTACH_REPLAY_BYTES);
      if (!ended && tail.length) trySend(tail);
    } catch { /* best-effort first paint */ }
    // Flush anything captured during the replay, then go live. Synchronous (no await
    // between the flush and `live = true`), so no chunk can slip in out of order.
    if (!ended) {
      for (const b of queue) trySend(b);
      queue.length = 0;
      live = true;
    }
  };

  socket.onmessage = (e) => {
    // Inbound frames are the client's raw keystrokes. Fire-and-forget: writeRawInput
    // serializes writes onto the session's sendChain, so ordering holds without
    // awaiting here (which would stall the socket's message pump).
    const data = e.data;
    if (data instanceof ArrayBuffer) {
      if (data.byteLength) void writeRawInput(id, new Uint8Array(data));
    } else if (typeof data === "string" && data.length) {
      void writeRawInput(id, new TextEncoder().encode(data));
    }
  };

  socket.onclose = detach;
  socket.onerror = detach;
  return response;
}

// ---- externally-registered (manually-run `vibe`) sessions ----
//
// A `vibe` started by hand on this host self-registers (POST /api/register, gated
// by the loopback peer + the discovery-file token below) so it shows up in the
// session list. Such a session has no ChildProcess and no captured log — its
// output stays in the user's terminal / claude.ai — so the launcher heartbeats
// (PUT /api/register) to keep it "running" and the reaper retires it on staleness
// (cross-user /proc is hidden by ProtectProc=invisible, so pidAlive can't be
// trusted for it). External sessions are deliberately NOT snapshotted.

// The discovery-file token (set once at startup by main.ts). A register POST must
// present it; per-registration tokens (returned to the launcher) gate heartbeat /
// deregister.
let regToken = "";
export function setRegToken(t: string): void {
  regToken = t;
}
export function registerTokenMatches(t: string): boolean {
  return regToken.length > 0 && t === regToken;
}

const EXTERNAL_TTL_MS = 90_000; // retire an external session this long after its last heartbeat

export async function registerExternal(
  fields: { name: string; dir: string; pid: number },
): Promise<{ id: string; token: string }> {
  await pruneSessions();
  const id = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const deregToken = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const info: SessionInfo = {
    id,
    // External sessions have no preset (managed from the user's own terminal).
    path: fields.dir,
    name: fields.name,
    pid: fields.pid,
    status: "running",
    startedAt: Date.now(),
    command: "(external vibe session)",
    external: true,
  };
  sessions.set(id, { info, child: null, logPath: "", deregToken, lastSeen: Date.now() });
  log("info", "external session registered", { id, name: fields.name, dir: fields.dir });
  return { id, token: deregToken };
}

// Refresh an external session's heartbeat. Returns false for an unknown id, a bad
// token, or a session no longer running. Heartbeats are best-effort: the launcher
// ignores the result, so a still-running manual session the server has forgotten
// (e.g. after a restart — external sessions aren't snapshotted) reappears only
// when `vibe` is run again, not automatically.
export function heartbeatExternal(id: string, token: string): boolean {
  const s = sessions.get(id);
  if (!s || !s.info.external || s.deregToken !== token) return false;
  if (s.info.status !== "running") return false;
  s.lastSeen = Date.now();
  return true;
}

export function deregisterExternal(id: string, token: string): boolean {
  const s = sessions.get(id);
  if (!s || !s.info.external || s.deregToken !== token) return false;
  if (s.info.status === "running" || s.info.status === "terminating") {
    s.info.status = "exited";
    s.info.exitedAt = Date.now();
  }
  return true;
}

// ---- snapshot / recovery across restarts ----
//
// Remote Control sessions (and their setsid process groups) outlive the
// vibe-server process. We persist the running set so a restart re-adopts them —
// keeping them listable and killable — instead of leaking untracked orphans.
// Re-adopted sessions carry no ChildProcess handle, so the reaper polls /proc to
// notice when they exit. Writes are serialized to avoid interleaving.

function snapshotPath(stateDir: string): string {
  return `${stateDir}/sessions.json`;
}

let snapWriting: Promise<void> = Promise.resolve();

export function saveSnapshot(stateDir: string): Promise<void> {
  snapWriting = snapWriting.then(async () => {
    const running = [...sessions.values()]
      // External (self-registered) sessions are not persisted — they belong to a
      // user's terminal, not the server, and re-register themselves on rerun.
      .filter((s) => s.info.status === "running" && !s.info.external)
      .map((s) => s.info);
    try {
      await Deno.writeTextFile(snapshotPath(stateDir), JSON.stringify(running));
    } catch (e) {
      log("warn", "snapshot save failed", { err: isError(e) ? e.message : String(e) });
    }
  });
  return snapWriting;
}

export async function recoverSessions(stateDir: string): Promise<number> {
  let arr: unknown;
  try {
    arr = JSON.parse(await Deno.readTextFile(snapshotPath(stateDir)));
  } catch {
    return 0;
  }
  let n = 0;
  for (const item of Array.isArray(arr) ? arr : []) {
    const info = item as SessionInfo;
    if (!info || typeof info.pid !== "number" || typeof info.id !== "string") continue;
    if (!pidAlive(info.pid)) continue;
    sessions.set(info.id, {
      info: { ...info, status: "running" },
      child: null,
      logPath: `${stateDir}/logs/${info.id}.log`,
    });
    n++;
  }
  await saveSnapshot(stateDir); // rewrite to reflect what actually survived
  return n;
}

// Notice re-adopted sessions (child === null) whose process has exited, and keep
// the snapshot fresh.
export function startReaper(stateDir: string): void {
  setInterval(() => {
    let changed = false;
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.info.status !== "running" && s.info.status !== "terminating") continue;
      if (s.info.external) {
        // Heartbeat-tracked: retire once the launcher stops checking in (its
        // process may be cross-user, so /proc visibility can't be relied on).
        if (now - (s.lastSeen ?? s.info.startedAt) > EXTERNAL_TTL_MS) {
          s.info.status = "exited";
          s.info.exitedAt = now;
          changed = true;
        }
      } else if (s.child === null && !pidAlive(s.info.pid)) {
        s.info.status = "exited";
        s.info.exitedAt = now;
        changed = true;
      }
    }
    if (changed) void saveSnapshot(stateDir);
  }, 30_000);
}
