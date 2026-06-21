// Read-only git working-tree diff for a session's directory. Captures tracked
// changes + staged + deletions + renames (git diff HEAD) plus untracked,
// non-ignored files (per-file git diff --no-index), WITHOUT mutating repo state
// (no `git add -N`, no `git reset`). ZERO external imports — only Deno.Command,
// Text{De,En}coder, AbortController/setTimeout, and the local ./util.ts.
//
// Hardening (every git spawn): a scrubbed env (no prompts, no pager, no lock
// waits, no system/global/user config — so a repo's .git/config aliases/hooks
// can't run), `--no-ext-diff --no-textconv` on every diff invocation (no
// attacker-controlled external-diff / textconv program runs — these are honoured
// from the repo-local .git/config, which the env scrub does NOT neutralise), a
// `--` terminator on every argv (a file named `-x` is a path, not a flag),
// `core.bigFileThreshold` so one huge blob diffs as "binary" instead of emitting
// gigabytes, a per-call timeout, an aggregate untracked-loop deadline, and
// byte/file caps so a huge or hostile tree can't OOM or hang the daemon.

import { isError, log } from "./util.ts";

export interface DiffResult {
  isRepo: boolean; // false → cwd is not inside a git work tree
  branch?: string; // branch name; absent on detached HEAD / zero-commit
  empty: boolean; // true → isRepo && no changes && no error
  diff: string; // combined unified-diff text (tracked, then each untracked)
  truncated: boolean; // true → hit a byte cap, the untracked-file cap, or a timeout
  error?: string; // set only on a fatal git failure; diff may still be partial
}

const MAX_DIFF_BYTES = 2_000_000; // ~2 MB total combined diff text
const MAX_UNTRACKED_FILES = 200; // cap per-file --no-index invocations
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024; // skip untracked files larger than this
const BINARY_SNIFF_BYTES = 8192; // null-byte sniff window
const GIT_TIMEOUT_MS = 10_000; // per git invocation
const TOTAL_TIMEOUT_MS = 30_000; // aggregate wall-clock budget for the whole diff

const dec = new TextDecoder();
const enc = new TextEncoder();

// Scrubbed env for every git spawn. PATH is passed through so `git` resolves;
// everything else is neutralised. clearEnv:true (in git()) drops the rest.
function gitEnv(): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: "/var/empty",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
  };
}

interface GitOut {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Run git read-only in `cwd`. `-c core.quotepath=false` keeps unicode/space
// filenames literal; `-c core.fsmonitor=false` keeps git from launching a daemon;
// `-c core.bigFileThreshold` makes git treat a blob larger than the total cap as
// binary (so one giant file diffs as "Binary files differ" rather than emitting it
// whole before the post-buffer byte cap can reject it). Never throws — failures
// surface via `code`/`timedOut`. stderr is captured for logging, never returned.
async function git(cwd: string, args: string[]): Promise<GitOut> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, GIT_TIMEOUT_MS);
  try {
    const cmd = new Deno.Command("git", {
      args: ["-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "-c", `core.bigFileThreshold=${MAX_DIFF_BYTES}`, ...args],
      cwd,
      env: gitEnv(),
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    });
    const { code, stdout, stderr } = await cmd.output();
    return { code, stdout: dec.decode(stdout), stderr: dec.decode(stderr), timedOut };
  } catch (e) {
    // Abort (timeout) or spawn failure (git missing, cwd gone).
    return { code: -1, stdout: "", stderr: isError(e) ? e.message : String(e), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

// Inspect an untracked file's head to (a) decide if it is binary (NUL byte) and
// (b) report its size, so we can skip binaries/oversized files without buffering
// them. Uses lstat (no-follow): a symlink is reported `symlink:true` so the caller
// lets `git diff --no-index` render it (mode 120000, target path only) without us
// reading through it to an out-of-tree target. Returns null if the file vanished
// or is unreadable (caller then skips it).
async function sniff(path: string): Promise<{ binary: boolean; size: number; symlink: boolean } | null> {
  let f: Deno.FsFile | null = null;
  try {
    const st = await Deno.lstat(path);
    if (st.isSymlink) return { binary: false, size: 0, symlink: true };
    if (!st.isFile) return null;
    f = await Deno.open(path, { read: true });
    const head = new Uint8Array(BINARY_SNIFF_BYTES);
    const n = await f.read(head);
    const slice = head.subarray(0, n ?? 0);
    return { binary: slice.indexOf(0) !== -1, size: st.size, symlink: false };
  } catch {
    return null;
  } finally {
    try {
      f?.close();
    } catch { /* ignore */ }
  }
}

export async function gitDiff(path: string): Promise<DiffResult> {
  const res: DiffResult = { isRepo: false, empty: false, diff: "", truncated: false };

  // (a) Is cwd inside a git work tree? Non-repo / deleted dir → exit 128 or spawn
  //     failure (code -1). Either way: not a repo, return cleanly.
  const inside = await git(path, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return res;
  res.isRepo = true;

  // (b) Branch label (cosmetic, never fatal). On detached HEAD / zero-commit,
  //     symbolic-ref fails → fall back to a short SHA; if that also fails, omit.
  const sym = await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (sym.code === 0 && sym.stdout.trim()) {
    res.branch = sym.stdout.trim();
  } else {
    const sha = await git(path, ["rev-parse", "--short", "HEAD"]);
    if (sha.code === 0 && sha.stdout.trim()) res.branch = sha.stdout.trim();
  }

  let out = "";
  let bytes = 0;
  // Aggregate wall-clock budget: the per-call timeout bounds one git spawn; this
  // bounds the whole operation (the untracked loop can issue up to
  // MAX_UNTRACKED_FILES spawns).
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  // Append text under the global byte budget. Returns false once the cap is hit.
  const append = (text: string): boolean => {
    if (!text) return true;
    const add = enc.encode(text).length;
    if (bytes + add > MAX_DIFF_BYTES) {
      res.truncated = true;
      return false;
    }
    out += text;
    bytes += add;
    return true;
  };

  // (c) Does HEAD exist? `--verify --quiet` exits 1 on a zero-commit repo — in
  //     which case `git diff HEAD` would fatal (exit 128). Diff against HEAD when
  //     it exists, else against the index (`--cached`), so a freshly scaffolded
  //     project (git init + git add -A, no commit yet) still shows its staged files
  //     instead of reporting "no changes".
  const hasHead = (await git(path, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;

  // (d) Tracked delta in one call: working-tree + staged + deletions + renames vs
  //     HEAD, or the staged tree vs the empty tree on a zero-commit repo.
  const tracked = await git(path, [
    "-c", "diff.renames=true", "diff", "--no-color", "--no-ext-diff", "--no-textconv",
    hasHead ? "HEAD" : "--cached", "--",
  ]);
  if (tracked.timedOut) {
    res.error = "git diff timed out";
    return finalize(res, out);
  }
  if (tracked.code !== 0) {
    res.error = tracked.stderr.trim() || `git diff exited ${tracked.code}`;
    return finalize(res, out);
  }
  if (!append(tracked.stdout)) return finalize(res, out);

  // (e) Untracked, non-ignored files. `--exclude-standard` keeps .gitignore'd
  //     secrets out; `-z` is NUL-delimited so newline/space filenames are safe.
  const others = await git(path, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
  if (others.code !== 0) {
    if (!res.error) res.error = others.stderr.trim() || `git ls-files exited ${others.code}`;
    return finalize(res, out);
  }

  let files = others.stdout.split("\0").filter((f) => f.length > 0);
  if (files.length > MAX_UNTRACKED_FILES) {
    files = files.slice(0, MAX_UNTRACKED_FILES);
    res.truncated = true;
  }

  for (const rel of files) {
    if (bytes >= MAX_DIFF_BYTES || Date.now() > deadline) {
      res.truncated = true;
      break;
    }
    const meta = await sniff(`${path}/${rel}`);
    if (!meta) continue; // vanished / unreadable
    if (meta.binary) {
      // Never emit raw bytes — synthesize a parser-friendly stanza so the UI
      // renders a clean "binary" file card. Strip CR/LF from the name so it stays
      // a single header line.
      const safe = rel.replace(/[\r\n]/g, " ");
      if (!append(`diff --git a/${safe} b/${safe}\nnew file mode 100644\nBinary files /dev/null and b/${safe} differ\n`)) break;
      continue;
    }
    if (meta.size > MAX_UNTRACKED_FILE_BYTES) {
      res.truncated = true; // skip giant generated files before git buffers them
      continue;
    }
    // `--no-index /dev/null FILE` exits 1 when the files differ — NORMAL for a new
    // file; treat 0 or 1 as success, >=2 (e.g. 128) is a per-file error. `--` guards
    // a filename that starts with `-`.
    const d = await git(path, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", rel]);
    if (d.timedOut) {
      res.truncated = true;
      continue;
    }
    if (d.code === 0 || d.code === 1) {
      if (!append(d.stdout)) break;
    } else {
      log("warn", "untracked diff failed", { code: d.code });
    }
  }

  return finalize(res, out);
}

function finalize(res: DiffResult, out: string): DiffResult {
  res.diff = out;
  res.empty = res.isRepo && !res.error && out.trim().length === 0;
  return res;
}

// A session can span several directories (a preset's `directories`: the first is
// the working dir, the rest are `claude --add-dir`'d). The Diff button shows ALL
// of them — one DiffResult per directory, in order, with exact-duplicate paths
// collapsed. Each runs through the same read-only/scrubbed gitDiff, so the
// hardening and caps apply per directory.
export interface MultiDiffResult {
  dirs: Array<{ path: string } & DiffResult>;
  truncated: boolean; // true if ANY directory's diff was truncated
}

export async function gitDiffMulti(paths: string[]): Promise<MultiDiffResult> {
  const seen = new Set<string>();
  const dirs: Array<{ path: string } & DiffResult> = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    dirs.push({ path, ...(await gitDiff(path)) });
  }
  return { dirs, truncated: dirs.some((d) => d.truncated) };
}
