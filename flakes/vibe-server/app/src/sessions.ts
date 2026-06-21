// Session lifecycle: spawn (env-allowlisted), track, kill, snapshot/recover
// across restarts, and a periodic reaper. ZERO external imports.

import { b64url, basenameOf, isError, log, sanitizeName } from "./util.ts";
import { buildEnv, seedTrust } from "./claude.ts";
import type { DirConfig, ServerConfig } from "./config.ts";

export type Status = "running" | "terminating" | "exited" | "failed";

export interface SessionInfo {
  id: string;
  dir: string;
  path: string;
  name: string;
  pid: number;
  status: Status;
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

export function sessionCount(): number {
  return sessions.size;
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

export async function spawnSession(config: ServerConfig, dir: DirConfig): Promise<SessionInfo> {
  await pruneSessions();

  // Mark this directory trusted (+ onboarding complete) so the session doesn't
  // block on the workspace-trust dialog / first-run theme picker. Idempotent.
  await seedTrust(config, dir.path);

  const id = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const prefix = config.sessionNamePrefix ? `${config.sessionNamePrefix}-` : "";
  const name = `${prefix}${dir.name}-${id.slice(0, 4)}`;
  const logDir = `${config.stateDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });
  const logPath = `${logDir}/${id}.log`;
  const logFile = await Deno.open(logPath, { create: true, write: true, append: true });

  const resolved = substitute(config.sessionCommand, { DIR: dir.path, NAME: name });

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
  const [setsidBin, ...setsidArgs] = config.pty
    ? ["setsid", "script", "-q", "-f", "-e", "-c", resolved.map(shQuote).join(" "), "/dev/null"]
    : ["setsid", ...resolved];

  const cmd = new Deno.Command(setsidBin, {
    args: setsidArgs,
    cwd: dir.path,
    // TERM gives the PTY a sane terminal type; an allowlisted TERM overrides it.
    // VIBE_MANAGED tells the `vibe` launcher this session is already tracked by
    // the server, so it skips self-registration (POST /api/register).
    env: { TERM: "xterm-256color", VIBE_MANAGED: "1", ...buildEnv(config) },
    stdin: "null",
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

  const info: SessionInfo = {
    id,
    dir: dir.name,
    path: dir.path,
    name,
    pid: child.pid,
    status: "running",
    startedAt: Date.now(),
    command: resolved.join(" "),
  };

  const enc = new TextEncoder();
  await logFile.write(
    enc.encode(`# vibe session ${name}\n# dir: ${dir.path}\n# cmd: ${resolved.join(" ")}\n\n`),
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

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      scan(chunk);
      await writeLog(chunk);
    }
  };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);

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
  });

  sessions.set(id, { info, child, logPath });
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
    dir: sanitizeName(basenameOf(fields.dir)) || "external",
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
