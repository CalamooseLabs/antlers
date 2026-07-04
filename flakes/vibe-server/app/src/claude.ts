// Everything about the `claude` CLI and its config directory. ZERO external imports.
//
//  - the spawn-env allowlist + builder (shared with sessions.ts);
//  - config-dir resolution and seeding of .claude.json (hasCompletedOnboarding +
//    theme + per-directory trust) so a fresh service user's sessions don't block
//    on the first-run theme picker / workspace-trust dialog;
//  - the auth-status query (`claude auth status --json`);
//  - the interactive `claude auth login` flow — it prints an OAuth URL on
//    claude.com and then reads a pasted code from its terminal, so the operator
//    authenticates the service user ONCE from the web UI and every spawned session
//    inherits the login (they all share this config dir).
//
// Verified against claude-code 2.1.170. See memory: claude-auth-login-mechanics.

import type { ServerConfig } from "./config.ts";
import { isError, log } from "./util.ts";

// Only these env-var names are propagated into spawned sessions (and the login /
// status invocations); everything else the daemon holds (stray tokens, DB URLs,
// …) is dropped so it can't reach Claude Code or its browser-readable logs.
// config.extraEnv extends this list. NOTE: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
// are listed so API-key deployments still work, but buildEnv further drops them via
// scrubApiCredsEnv when subscriptionAuth is on (the default) so a stray key/token
// can't shadow the plan's OAuth login.
export const ENV_ALLOWLIST = [
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

export function buildEnv(config: ServerConfig): Record<string, string> {
  const allow = new Set([...ENV_ALLOWLIST, ...(config.extraEnv ?? [])]);
  const env: Record<string, string> = {};
  for (const k of allow) {
    const v = Deno.env.get(k);
    if (v !== undefined) env[k] = v;
  }
  return scrubApiCredsEnv(env, config.subscriptionAuth ?? true);
}

// Pure: subscription-first — when subscriptionAuth is on, drop a stray
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so `claude` uses the plan's OAuth login
// (CLAUDE_CONFIG_DIR/.credentials.json) rather than the key/token. This matters
// because `claude` checks ANTHROPIC_AUTH_TOKEN AHEAD of the stored claude.ai OAuth,
// so a stray token shadows the auth-status banner AND session inference even after
// a good login (a fresh login then appears not to "take effect"); a bare
// ANTHROPIC_API_KEY only wins headless `claude -p` (the commit-message draft) but
// is dropped here too so that path stays on the plan. subscriptionAuth=false leaves
// the env untouched for genuine API-key billing. Mirrors the `vibe` wrapper's drop
// (flakes/vibe/package.nix) so the service's own spawns match its sessions.
export function scrubApiCredsEnv(
  env: Record<string, string>,
  subscriptionAuth: boolean,
): Record<string, string> {
  if (!subscriptionAuth) return env;
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

// ---- config dir + onboarding/theme/trust seeding ----
//
// claude reads/writes .claude.json (onboarding state, theme, per-project trust),
// .credentials.json and settings.json all INSIDE $CLAUDE_CONFIG_DIR. The
// vibe-server unit pins CLAUDE_CONFIG_DIR (→ stateDir/.claude when no explicit
// claudeConfigDir is set) so this location is deterministic.

export function configDir(): string {
  const explicit = Deno.env.get("CLAUDE_CONFIG_DIR");
  if (explicit && explicit.trim()) return explicit;
  const home = Deno.env.get("HOME");
  return `${home && home.trim() ? home : "/var/lib/vibe"}/.claude`;
}

function claudeJsonPath(): string {
  return `${configDir()}/.claude.json`;
}

// Pure: merge onboarding/theme/trust flags into an existing .claude.json object,
// preserving unrelated keys. `dirs` are absolute project paths to mark trusted so
// the workspace-trust dialog never blocks a session.
export function mergeOnboarding(
  existing: Record<string, unknown>,
  theme: string,
  dirs: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  out.hasCompletedOnboarding = true;
  if (theme) out.theme = theme;
  const projects: Record<string, unknown> =
    existing.projects && typeof existing.projects === "object" && !Array.isArray(existing.projects)
      ? { ...(existing.projects as Record<string, unknown>) }
      : {};
  for (const d of dirs) {
    const prev = projects[d] && typeof projects[d] === "object" && !Array.isArray(projects[d])
      ? projects[d] as Record<string, unknown>
      : {};
    projects[d] = { ...prev, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  }
  out.projects = projects;
  return out;
}

async function readClaudeJson(): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await Deno.readTextFile(claudeJsonPath()));
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// Writes are serialized so the startup seed and a concurrent spawn-time seed can't
// interleave and lose each other's edits. Best-effort: failures are logged.
let seedWriting: Promise<void> = Promise.resolve();

function seed(config: ServerConfig, dirs: string[]): Promise<void> {
  if (!config.seedClaudeOnboarding) return Promise.resolve();
  seedWriting = seedWriting.then(async () => {
    try {
      await Deno.mkdir(configDir(), { recursive: true });
      const merged = mergeOnboarding(await readClaudeJson(), config.claudeTheme, dirs);
      await Deno.writeTextFile(claudeJsonPath(), JSON.stringify(merged, null, 2));
    } catch (e) {
      log("warn", "claude onboarding seed failed", { err: isError(e) ? e.message : String(e) });
    }
  });
  return seedWriting;
}

// Seed onboarding-complete + theme + trust for every configured directory. Called
// once at startup so the auth/login UI and the first session work without prompts.
export function seedClaudeConfig(config: ServerConfig): Promise<void> {
  return seed(config, config.presets.flatMap((p) => p.directories));
}

// Mark one directory trusted (idempotent). Called before spawning a session so
// user-added dirs created after startup are covered too.
export function seedTrust(config: ServerConfig, dirPath: string): Promise<void> {
  return seed(config, [dirPath]);
}

// ---- auth status ----

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
  error?: string;
}

// Pure: parse `claude auth status --json` stdout. Tolerates surrounding noise by
// falling back to the first {...} block.
export function parseAuthStatus(stdout: string): ClaudeAuthStatus {
  const text = stdout.trim();
  let obj: unknown = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        obj = JSON.parse(text.slice(a, b + 1));
      } catch {
        obj = null;
      }
    }
  }
  if (!obj || typeof obj !== "object") return { loggedIn: false, error: "could not read auth status" };
  const s = obj as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    loggedIn: s.loggedIn === true,
    authMethod: str(s.authMethod),
    email: str(s.email),
    subscriptionType: str(s.subscriptionType),
    orgName: str(s.orgName),
  };
}

// `claude auth status` is non-interactive (exit 0 logged in, exit 1 not); we parse
// stdout JSON either way. Env mirrors a session's so it reflects the auth the
// sessions actually use.
export async function claudeAuthStatus(config: ServerConfig): Promise<ClaudeAuthStatus> {
  try {
    const out = await new Deno.Command("claude", {
      args: ["auth", "status", "--json"],
      env: buildEnv(config),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return parseAuthStatus(new TextDecoder().decode(out.stdout));
  } catch (e) {
    return { loggedIn: false, error: isError(e) ? e.message : String(e) };
  }
}

// ---- commit-message drafting (one-shot `claude -p`) ----

const GEN_TIMEOUT_MS = 60_000; // a short non-interactive generation
const MAX_GEN_DIFF_BYTES = 100_000; // bound the diff fed to claude (argv + tokens)
const MAX_MESSAGE_BYTES = 64 * 1024; // commit-message cap (mirrors commit.ts)

// Pure: the prompt asking for a human-style commit message. Mirrors the
// gcommit / vibe-shell convention — a concise imperative subject + optional body,
// and explicitly NO "Generated with Claude Code" / "Co-Authored-By" trailers
// (these commits must read as the human author's own work).
export function commitMessagePrompt(diff: string): string {
  return [
    "Write a git commit message for the following staged changes.",
    "Use a concise, imperative subject line (<= 72 chars); if useful, add a blank",
    "line and a short body explaining the what and why. Output ONLY the commit",
    "message text — no code fences, no preamble or sign-off, and absolutely NO",
    '"Generated with Claude Code" or "Co-Authored-By" trailers.',
    "",
    "Changes (git diff):",
    diff,
  ].join("\n");
}

// Pure: clean the model's raw stdout into a usable commit message — strip a
// wrapping ```code fence```, drop any stray AI/co-author trailer it added anyway,
// trim, and reject anything over the message cap.
export function cleanGeneratedMessage(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n").trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  t = t
    .split("\n")
    .filter((l) => !/^\s*(Co-Authored-By:|(\u{1F916}\s*)?Generated with )/iu.test(l))
    .join("\n")
    .trim();
  if (new TextEncoder().encode(t).length > MAX_MESSAGE_BYTES) return "";
  return t;
}

// Draft a commit message from a diff with a one-shot, non-interactive `claude -p`.
// Reuses the service's Claude auth/config dir (same env as a session). Returns
// null on any failure/timeout so the caller can fall back to no suggestion. The
// diff travels on argv (capped) — claude -p reads its prompt there, same as the
// existing `claude auth status` spawn.
export async function generateCommitMessage(config: ServerConfig, diff: string): Promise<string | null> {
  const clipped = diff.length > MAX_GEN_DIFF_BYTES ? diff.slice(0, MAX_GEN_DIFF_BYTES) : diff;
  if (!clipped.trim()) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GEN_TIMEOUT_MS);
  try {
    const out = await new Deno.Command("claude", {
      args: ["-p", commitMessagePrompt(clipped)],
      env: buildEnv(config),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    }).output();
    if (!out.success) return null;
    const msg = cleanGeneratedMessage(new TextDecoder().decode(out.stdout));
    return msg || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- interactive login flow (URL + paste-back code over a PTY) ----

export type LoginPhase = "idle" | "starting" | "awaiting_code" | "exchanging" | "done" | "error";

export interface LoginState {
  phase: LoginPhase;
  url?: string;
  error?: string;
  startedAt?: number;
}

interface Login {
  child: Deno.ChildProcess;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  pid: number;
  state: LoginState;
  buf: string;
  timer: ReturnType<typeof setTimeout>;
  exited: boolean; // set once child.status resolves, so cancel knows not to kill
}

let current: Login | null = null;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // auto-kill an abandoned login
const SCAN_LIMIT = 64 * 1024;

// The OAuth URL `claude auth login` prints (host claude.com for the /cai/oauth/
// flow). It is a single line with no whitespace/control chars, so we stop at the
// first such char (the terminal wraps it in OSC-8 escape sequences).
// deno-lint-ignore no-control-regex -- the \x00-\x1f stop class is intentional (terminal escapes).
const LOGIN_URL_RE = /(https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|auth\.anthropic\.com|login\.anthropic\.com)\/[^\s\x00-\x1f"'<>\\]+)/;

export function extractLoginUrl(text: string): string | null {
  const m = text.match(LOGIN_URL_RE);
  return m ? m[1] : null;
}

// Strip CSI/OSC escapes and stray control chars so a human message ("Login
// failed: …") can be read out of the captured PTY output.
function stripAnsi(s: string): string {
  // The control chars below are intentional (CSI/OSC escapes + stray C0 bytes).
  // deno-lint-ignore no-control-regex
  const csi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  // deno-lint-ignore no-control-regex
  const osc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
  // deno-lint-ignore no-control-regex
  const ctrl = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
  return s.replace(csi, "").replace(osc, "").replace(ctrl, "");
}

export function extractLoginError(text: string): string | undefined {
  const m = stripAnsi(text).match(/Login failed:[^\n\r]*/);
  return m ? m[0].trim() : undefined;
}

function isLive(p: LoginPhase): boolean {
  return p === "starting" || p === "awaiting_code" || p === "exchanging";
}

export function loginState(): LoginState {
  return current ? { ...current.state } : { phase: "idle" };
}

// Log the current Claude account out (drops the OAuth credentials from the shared
// config dir). Best-effort / non-fatal — run before an interactive login so
// "log in as a different account" can't be short-circuited by an existing login:
// with an account already signed in, `claude auth login` exits 0 WITHOUT printing
// an OAuth URL (verified against claude-code 2.1.177), which the UI then surfaces
// as an instant "success" with no link to follow. An already-logged-out state (or
// a logout error) is ignored; the login spawn that follows still drives the flow.
export async function claudeLogout(config: ServerConfig): Promise<void> {
  try {
    await new Deno.Command("claude", {
      args: ["auth", "logout"],
      env: buildEnv(config),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    log("warn", "claude auth logout failed", { err: isError(e) ? e.message : String(e) });
  }
}

// Start `claude auth login` (or return the in-flight one). Spawns it under a PTY
// (util-linux `script`) with piped stdin so the code can be written back into the
// PTY; setsid gives it its own process group for a clean kill.
export async function startClaudeLogin(config: ServerConfig): Promise<LoginState> {
  if (current && isLive(current.state.phase)) return { ...current.state };
  cancelClaudeLogin(); // clear a previous finished attempt

  // Log out any signed-in account FIRST so `claude auth login` always issues a
  // fresh OAuth URL. When an account is already signed in it exits 0 with no URL
  // (2.1.177), so the flow would jump straight to "done"/success and the user
  // could never follow a link to switch accounts.
  await claudeLogout(config);

  const dec = new TextDecoder();
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("setsid", {
      args: ["script", "-q", "-f", "-e", "-c", "claude auth login --claudeai", "/dev/null"],
      env: { TERM: "xterm-256color", ...buildEnv(config) },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    return { phase: "error", error: `failed to start login: ${isError(e) ? e.message : String(e)}` };
  }

  const login: Login = {
    child,
    writer: child.stdin.getWriter(),
    pid: child.pid,
    state: { phase: "starting", startedAt: Date.now() },
    buf: "",
    exited: false,
    timer: setTimeout(() => {
      log("warn", "claude login timed out; killing");
      cancelClaudeLogin();
    }, LOGIN_TIMEOUT_MS),
  };
  current = login;

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      if (login.buf.length < SCAN_LIMIT) login.buf += dec.decode(chunk, { stream: true });
      if (!login.state.url) {
        const u = extractLoginUrl(login.buf);
        if (u) {
          login.state.url = u;
          if (login.state.phase === "starting") login.state.phase = "awaiting_code";
        }
      }
    }
  };
  void Promise.all([pump(child.stdout), pump(child.stderr)]).catch(() => {});

  child.status.then((st) => {
    login.exited = true;
    clearTimeout(login.timer);
    if (current !== login) return; // superseded by a newer attempt
    if (st.code === 0) {
      login.state.phase = "done";
      login.state.error = undefined;
    } else if (login.state.phase !== "done") {
      login.state.phase = "error";
      login.state.error = extractLoginError(login.buf) ?? `login exited with code ${st.code}`;
    }
  }).catch(() => {
    login.exited = true;
    if (current === login && isLive(login.state.phase)) {
      login.state.phase = "error";
      login.state.error = "login process error";
    }
  });

  // Give the URL a few seconds to appear so the first response can carry it;
  // otherwise the client polls GET /api/claude-auth.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && login.state.phase === "starting" && !login.state.url) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ...login.state };
}

// Pure: did the pasted code actually establish/refresh the subscription login?
// A clean exit (code 0) is authoritative — startClaudeLogin logs the previous
// account out before the login, so a code exchange always ran; exit 0 means the
// pasted code was accepted and fresh OAuth credentials were written. Otherwise
// (non-zero / lost exit code) only trust an auth status that shows a REAL claude.ai
// subscription login
// AND a CHANGE from the before-snapshot, so we never report success on: a stray
// API key (authMethod "api_key") / auth token ("oauth_token") that fabricates
// loggedIn=true, or a FAILED account switch that left the prior OAuth logged in
// (before/after identity unchanged). That false "Logged in!" is exactly why a new
// login looked like it "didn't take effect".
export function loginSucceeded(
  exitCode: number,
  before: ClaudeAuthStatus,
  after: ClaudeAuthStatus,
): boolean {
  if (exitCode === 0) return true;
  if (!after.loggedIn || after.authMethod !== "claude.ai") return false;
  return !before.loggedIn ||
    before.email !== after.email ||
    before.subscriptionType !== after.subscriptionType;
}

// Write the pasted authorization code into the login PTY and wait for the
// exchange to finish, then re-check auth status to confirm.
export async function submitClaudeCode(
  config: ServerConfig,
  code: string,
): Promise<{ ok: boolean; error?: string; status?: ClaudeAuthStatus }> {
  const login = current;
  if (!login || login.state.phase !== "awaiting_code") {
    return { ok: false, error: "no login is awaiting a code" };
  }
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 4096 || /[\r\n]/.test(trimmed)) {
    return { ok: false, error: "invalid code" };
  }

  // Snapshot the account BEFORE the exchange so a failed switch (prior OAuth still
  // logged in) or a stray key/token can't be mistaken for a successful new login.
  const before = await claudeAuthStatus(config);
  login.state.phase = "exchanging";
  try {
    await login.writer.write(new TextEncoder().encode(trimmed + "\n"));
  } catch (e) {
    const err = `failed to send code: ${isError(e) ? e.message : String(e)}`;
    login.state.phase = "error";
    login.state.error = err;
    cancelClaudeLogin(); // reap the PTY/claude child rather than orphan it
    return { ok: false, error: err };
  }

  // The process exits once it has exchanged the code (success or failure). Capture
  // its exit code; null means we hit the timeout instead.
  const exitCode = await Promise.race([
    login.child.status.then((st) => st.code).catch(() => -1),
    new Promise<number | null>((r) => setTimeout(() => r(null), 60_000)),
  ]);
  await new Promise((r) => setTimeout(r, 50)); // let child.status.then() set phase
  if (exitCode === null) return { ok: false, error: "timed out exchanging code" };

  // Trust a clean exit (code 0 = code accepted, creds written) even if a
  // just-issued status query hasn't caught up yet; otherwise require a real,
  // CHANGED claude.ai login vs the before-snapshot (loginSucceeded) so a stray
  // key/token or a failed switch isn't reported as success.
  const status = await claudeAuthStatus(config);
  if (loginSucceeded(exitCode, before, status)) {
    if (current === login) login.state.phase = "done";
    return { ok: true, status };
  }
  return { ok: false, error: login.state.error ?? "login did not complete", status };
}

export function cancelClaudeLogin(): void {
  const login = current;
  if (!login) return;
  clearTimeout(login.timer);
  try {
    login.writer.close();
  } catch { /* already closed / errored */ }
  // Kill whenever the child has not been confirmed exited — including an
  // "error"-state-but-still-running process — so it can never be orphaned.
  if (!login.exited) {
    try {
      Deno.kill(-login.pid, "SIGTERM"); // process group
    } catch {
      try {
        Deno.kill(login.pid, "SIGTERM");
      } catch { /* already gone */ }
    }
  }
  current = null;
}
