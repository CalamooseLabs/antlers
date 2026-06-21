// "Commit & Push": stage the working tree, make a YubiKey-signed commit, and
// optionally push — driven from the web UI. This is the ONE mutating git path in
// vibe-server; everything else (diff.ts) is deliberately read-only, so this is a
// separate module with its own, NON-scrubbed git spawn:
//
//   - diff.ts runs git with `clearEnv:true` + a stripped env (no identity, no
//     agent, no credentials, HOME=/var/empty) precisely so git can't write/sign/
//     reach the network. Commit/push need the opposite: the signing user's real
//     git identity (~/.gitconfig), their gpg/card (~/.gnupg via GNUPGHOME), and
//     push credentials. So we INHERIT the daemon env and override HOME/GNUPGHOME
//     to the signing user's, keeping only GIT_TERMINAL_PROMPT=0 so a missing
//     credential fails fast instead of hanging the daemon on a prompt.
//   - The card PIN the user types in the browser is written to a 0600 file on
//     tmpfs (/run/vibe) and handed to gpg via `gpg.program=<wrapper>` +
//     VIBE_PIN_FILE (loopback pinentry). It is NEVER put on argv or persistent
//     disk, and is deleted in a finally. ONE attempt per request — a wrong PIN is
//     surfaced, never retried, so we can't walk the card toward its 3-strike lock.
//
// Touch can't be supplied from a browser, so a card whose policy requires a touch
// for sign/auth is gated off by config (commitRequiresTouch / pushRequiresTouch).
// ZERO external imports (Deno APIs + local ./*.ts only).

import type { PresetConfig, ServerConfig } from "./config.ts";
import { isError, log } from "./util.ts";

const COMMIT_TIMEOUT_MS = 90_000; // commit incl. card PIN verify + sign
const PUSH_TIMEOUT_MS = 180_000; // push to a (possibly slow) remote
const MAX_MESSAGE_BYTES = 64 * 1024; // sanity cap on the commit message
const MAX_PIN_LEN = 256; // OpenPGP PINs are short; reject anything absurd
// tmpfs scratch for the PIN file (RuntimeDirectory=vibe; covered by --allow-write).
const SCRATCH_DIR = "/run/vibe";

const dec = new TextDecoder();

// ---- capability predicates (also used by the router to 403 and by the UI to
//      hide the button). The feature has a global master switch (commitPush.enable);
//      the touch gates are PER-PRESET. Touch ⇒ no remote action for that op. ----

export function commitPushEnabled(config: ServerConfig): boolean {
  return config.commitPush.enable === true;
}

export function canCommit(config: ServerConfig, preset: PresetConfig): boolean {
  return commitPushEnabled(config) && !preset.commitRequiresTouch;
}

export function canPush(config: ServerConfig, preset: PresetConfig): boolean {
  return commitPushEnabled(config) && !preset.pushRequiresTouch;
}

// ---- pure input validation (tested) ----

// Trim and bound the commit message; null = invalid (empty or too large).
export function cleanMessage(msg: unknown): string | null {
  if (typeof msg !== "string") return null;
  const trimmed = msg.trim();
  if (trimmed.length === 0) return null;
  if (new TextEncoder().encode(trimmed).length > MAX_MESSAGE_BYTES) return null;
  return trimmed;
}

// A card PIN must be a non-empty single line within a sane length. Newlines/CR
// would corrupt the passphrase-file gpg reads, and control chars never belong in
// a PIN — reject them rather than risk a malformed signing attempt.
export function cleanPin(pin: unknown): string | null {
  if (typeof pin !== "string") return null;
  if (pin.length === 0 || pin.length > MAX_PIN_LEN) return null;
  // deno-lint-ignore no-control-regex -- rejecting control chars in a PIN is the point.
  if (/[\x00-\x1f\x7f]/.test(pin)) return null;
  return pin;
}

// git argv for the signed commit. The PIN never appears here — it travels via
// the VIBE_PIN_FILE env the gpgProgram wrapper reads. The message is a single
// argv element (no shell), so it can't be injected. `-S` forces a signature
// (like gcommit) so the commit fails loudly if signing isn't configured.
//
// Hardening against a hostile repo-local .git/config (the commit env is NOT
// scrubbed like diff.ts's read path): command-line `-c` has highest precedence,
// so `gpg.format=openpgp` pins the OpenPGP/YubiKey path — neutralizing a repo
// `gpg.format=ssh` + `gpg.ssh.program=<arbitrary>` exec vector — and `gpg.program`
// is our loopback-PIN wrapper. `--no-verify` skips the repo's commit hooks
// (pre-commit / prepare-commit-msg / commit-msg), which would otherwise run as
// the signing user; gitw() also pins `core.hooksPath` to an empty dir to defang
// post-commit and any repo-local `core.hooksPath`.
export function commitArgs(gpgProgram: string, message: string): string[] {
  const pre = ["-c", "gpg.format=openpgp"];
  if (gpgProgram) pre.push("-c", `gpg.program=${gpgProgram}`);
  return [...pre, "commit", "--no-verify", "-S", "-m", message];
}

// A configured target branch must be a safe git ref: no leading "-" (so it can't
// be read as a flag by `git checkout`), no spaces/control chars, and only typical
// ref characters. "" means "don't switch branches". Returns the branch or null.
export function validBranch(branch: string): string | null {
  if (branch === "") return null;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch)) return null;
  return branch;
}

// git argv to move onto the target branch — `-b` creates it from the current HEAD
// when it doesn't exist yet. The branch is a single argv element (no shell).
export function checkoutArgs(branch: string, create: boolean): string[] {
  return create ? ["checkout", "-b", branch] : ["checkout", branch];
}

// git argv for the push. With a configured branch we may have just created it (no
// upstream yet), so push it explicitly and set tracking (default remote `origin`
// when none is configured). Otherwise: "" remote ⇒ bare `git push` (the current
// branch's configured upstream), else `git push <remote>`.
export function pushArgs(remote: string, branch: string): string[] {
  const r = remote.trim();
  const b = branch.trim();
  // --no-verify skips a repo's pre-push hook (gitw also pins core.hooksPath).
  if (b) return ["push", "--no-verify", "--set-upstream", r || "origin", b];
  return r ? ["push", "--no-verify", r] : ["push", "--no-verify"];
}

export interface CommitPushResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  sha?: string; // short SHA of the new commit
  branch?: string;
  // How far we got, for the UI: where it stopped (or "done").
  stage: "check" | "branch" | "stage" | "commit" | "push" | "done";
  error?: string; // human-facing message (git/gpg stderr on failure)
}

interface GitOut {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Run a MUTATING git command in `cwd`. Unlike diff.ts's git(), this inherits the
// daemon env (clearEnv defaults false) and overrides only what signing/push need,
// so git sees the signing user's ~/.gitconfig + ~/.gnupg. Never throws.
async function gitw(cwd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<GitOut> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    const cmd = new Deno.Command("git", {
      // fsmonitor off (no daemon launch). core.hooksPath → an empty dir disables
      // ALL repo hooks (pre-commit/commit-msg/post-commit/pre-push/post-checkout)
      // and overrides any repo-local core.hooksPath — `-c` has highest precedence —
      // so a hostile/Claude-written .git/hooks can't exec as the signing user.
      // A `--` is added per-call where args take paths.
      args: ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/var/empty", ...args],
      cwd,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    });
    const { code, stdout, stderr } = await cmd.output();
    return { code, stdout: dec.decode(stdout), stderr: dec.decode(stderr), timedOut };
  } catch (e) {
    return { code: -1, stdout: "", stderr: isError(e) ? e.message : String(e), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

// Env overrides for the signing/push subprocess. Inherits the rest of the daemon
// env; sets HOME/GNUPGHOME to the signing user's so git identity + the card are
// found, GIT_TERMINAL_PROMPT=0 so a missing credential fails fast, and (when
// signing) VIBE_PIN_FILE for the gpgProgram wrapper.
function commitEnv(config: ServerConfig, pinFile?: string): Record<string, string> {
  const cp = config.commitPush;
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (cp.home) env.HOME = cp.home;
  if (cp.gnupgHome) env.GNUPGHOME = cp.gnupgHome;
  if (pinFile) env.VIBE_PIN_FILE = pinFile;
  return env;
}

function firstLine(stderr: string, fallback: string): string {
  const line = stderr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line || fallback;
}

// Stage everything, make a signed commit, and (if doPush) push. Single PIN
// attempt; the PIN file lives only on tmpfs and is removed in finally. Returns a
// structured result and never throws across the route boundary.
export async function commitAndPush(
  config: ServerConfig,
  preset: PresetConfig,
  cwd: string,
  message: string,
  pin: string,
  doPush: boolean,
): Promise<CommitPushResult> {
  const res: CommitPushResult = { ok: false, committed: false, pushed: false, stage: "check" };
  const cp = config.commitPush;

  // (a) Must be a work tree (defense in depth — the route already validates the dir).
  const inside = await gitw(cwd, ["rev-parse", "--is-inside-work-tree"], commitEnv(config), COMMIT_TIMEOUT_MS);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    res.error = "Not a git working tree.";
    return res;
  }

  // (b) Anything to commit? Check BEFORE any branch switch so a clean tree never
  //     moves the session onto another branch for nothing. `--porcelain` lists
  //     staged + unstaged + untracked (non-ignored) changes; empty ⇒ nothing.
  const status = await gitw(cwd, ["status", "--porcelain"], commitEnv(config), COMMIT_TIMEOUT_MS);
  if (status.code !== 0) {
    res.error = status.timedOut ? "git status timed out." : firstLine(status.stderr, `git status exited ${status.code}`);
    return res;
  }
  if (status.stdout.trim() === "") {
    res.error = "Nothing to commit — the working tree is clean.";
    return res;
  }

  // (c) Move onto the preset's branch (creating it from the current HEAD if it
  //     doesn't exist), carrying the working-tree changes. "" ⇒ stay on the
  //     current branch. The session's checked-out branch genuinely changes here.
  const branch = validBranch(preset.branch);
  if (preset.branch !== "" && branch === null) {
    res.error = `Preset branch is not a valid branch name: ${preset.branch}`;
    return res;
  }
  if (branch) {
    res.stage = "branch";
    const cur = await gitw(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], commitEnv(config), COMMIT_TIMEOUT_MS);
    if (cur.stdout.trim() !== branch) {
      const exists = (await gitw(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], commitEnv(config), COMMIT_TIMEOUT_MS)).code === 0;
      const co = await gitw(cwd, checkoutArgs(branch, !exists), commitEnv(config), COMMIT_TIMEOUT_MS);
      if (co.code !== 0) {
        res.error = co.timedOut
          ? "git checkout timed out."
          : `Could not switch to branch ${branch}: ${firstLine(co.stderr, `git checkout exited ${co.code}`)}`;
        return res;
      }
    }
  }

  // (d) Stage all changes (tracked edits/deletions + untracked non-ignored). `--`
  //     terminates options so a path can't be read as a flag.
  res.stage = "stage";
  const add = await gitw(cwd, ["add", "-A", "--"], commitEnv(config), COMMIT_TIMEOUT_MS);
  if (add.code !== 0) {
    res.error = add.timedOut ? "git add timed out." : firstLine(add.stderr, `git add exited ${add.code}`);
    return res;
  }

  // (e) Anything actually staged? Avoid invoking the card for an empty commit.
  const staged = await gitw(cwd, ["diff", "--cached", "--quiet"], commitEnv(config), COMMIT_TIMEOUT_MS);
  if (staged.code === 0) {
    res.error = "Nothing to commit — the working tree is clean.";
    return res;
  }

  // (d) Sign + commit. The PIN goes to a 0600 tmpfs file the gpgProgram wrapper
  //     reads via loopback pinentry; one attempt, deleted in finally.
  res.stage = "commit";
  let pinFile: string | null = null;
  try {
    pinFile = await Deno.makeTempFile({ dir: SCRATCH_DIR, prefix: "pin." });
    await Deno.chmod(pinFile, 0o600);
    await Deno.writeTextFile(pinFile, pin);
    const commit = await gitw(cwd, commitArgs(cp.gpgProgram, message), commitEnv(config, pinFile), COMMIT_TIMEOUT_MS);
    if (commit.code !== 0) {
      res.error = commit.timedOut
        ? "git commit timed out (card PIN / signing)."
        : firstLine(commit.stderr, `git commit exited ${commit.code}`);
      return res;
    }
  } catch (e) {
    res.error = isError(e) ? e.message : "commit failed";
    return res;
  } finally {
    if (pinFile) {
      try {
        await Deno.remove(pinFile);
      } catch { /* best-effort; tmpfs is wiped on reboot regardless */ }
    }
  }
  res.committed = true;

  // (e) Identify the new commit (cosmetic; failure here doesn't undo the commit).
  const sha = await gitw(cwd, ["rev-parse", "--short", "HEAD"], commitEnv(config), COMMIT_TIMEOUT_MS);
  if (sha.code === 0 && sha.stdout.trim()) res.sha = sha.stdout.trim();
  const br = await gitw(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], commitEnv(config), COMMIT_TIMEOUT_MS);
  if (br.code === 0 && br.stdout.trim()) res.branch = br.stdout.trim();

  // (f) Push, if requested and permitted. A push failure leaves the commit
  //     standing — the user can retry the push outside the web UI.
  if (doPush && canPush(config, preset)) {
    res.stage = "push";
    const push = await gitw(cwd, pushArgs(preset.pushRemote, preset.branch), commitEnv(config), PUSH_TIMEOUT_MS);
    if (push.code !== 0) {
      res.error = push.timedOut
        ? "Committed, but the push timed out."
        : "Committed, but the push failed: " + firstLine(push.stderr, `git push exited ${push.code}`);
      log("warn", "commit-push: push failed", { code: push.code });
      return res; // ok stays false: the operation didn't fully succeed
    }
    res.pushed = true;
  }

  res.stage = "done";
  res.ok = true;
  return res;
}
