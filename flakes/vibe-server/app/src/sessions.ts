// Session lifecycle: spawn (env-allowlisted), track, kill, snapshot/recover
// across restarts, and a periodic reaper. ZERO external imports.

import { b64url, isError, log } from "./util.ts";
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
}

interface Session {
  info: SessionInfo;
  child: Deno.ChildProcess | null; // null for sessions re-adopted after a restart
  logPath: string;
}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 100;
// Prune below MAX (not just to it) so a burst of concurrent spawns can't each
// see size < MAX and all skip pruning.
const PRUNE_TARGET = MAX_SESSIONS - 10;

// Only these env-var names are propagated into spawned sessions; everything else
// the daemon holds (stray tokens, DB URLs, …) is dropped so it can't reach
// Claude Code or its browser-readable logs. config.extraEnv extends this list.
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];

// First Claude/Anthropic auth URL a not-logged-in session prints to its output.
const AUTH_URL_RE =
  /(https?:\/\/(?:claude\.ai|console\.anthropic\.com|auth\.anthropic\.com|login\.anthropic\.com)\/[^\s"'<>]+)/;

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

function buildEnv(config: ServerConfig): Record<string, string> {
  const allow = new Set([...ENV_ALLOWLIST, ...(config.extraEnv ?? [])]);
  const env: Record<string, string> = {};
  for (const k of allow) {
    const v = Deno.env.get(k);
    if (v !== undefined) env[k] = v;
  }
  return env;
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
    env: { TERM: "xterm-256color", ...buildEnv(config) },
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
      .filter((s) => s.info.status === "running")
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
    for (const s of sessions.values()) {
      if (
        s.child === null &&
        (s.info.status === "running" || s.info.status === "terminating") &&
        !pidAlive(s.info.pid)
      ) {
        s.info.status = "exited";
        s.info.exitedAt = Date.now();
        changed = true;
      }
    }
    if (changed) void saveSnapshot(stateDir);
  }, 30_000);
}
