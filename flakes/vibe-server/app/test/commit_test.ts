import { canCommit, canPush, checkoutArgs, cleanMessage, cleanPin, commitArgs, commitPushEnabled, pushArgs, validBranch } from "../src/commit.ts";
import { DEFAULTS } from "../src/config.ts";
import type { CommitPushConfig, PresetConfig, ServerConfig } from "../src/config.ts";
import { assert, assertEquals } from "./assert.ts";

// Build a ServerConfig whose (global) commitPush is the given partial.
function cfg(cp: Partial<CommitPushConfig>): ServerConfig {
  return { ...DEFAULTS, commitPush: { ...DEFAULTS.commitPush, ...cp } };
}

// Build a PresetConfig (the per-preset commit/touch fields live here now).
function preset(p: Partial<PresetConfig>): PresetConfig {
  return { name: "p", directories: ["/x"], branch: "", pushRemote: "", commitRequiresTouch: false, pushRequiresTouch: false, ...p };
}

Deno.test("cleanMessage trims and rejects empty / whitespace-only", () => {
  assertEquals(cleanMessage("  hello world  "), "hello world");
  assertEquals(cleanMessage("subject\n\nbody"), "subject\n\nbody");
  assertEquals(cleanMessage(""), null);
  assertEquals(cleanMessage("   \n\t "), null);
  assertEquals(cleanMessage(123), null);
  assertEquals(cleanMessage(undefined), null);
});

Deno.test("cleanMessage rejects an oversized message", () => {
  assert(cleanMessage("x".repeat(1000)) !== null);
  assertEquals(cleanMessage("x".repeat(64 * 1024 + 1)), null);
});

Deno.test("cleanPin accepts a sane PIN and rejects bad shapes", () => {
  assertEquals(cleanPin("123456"), "123456");
  assertEquals(cleanPin("aB3-9_ok"), "aB3-9_ok");
  assertEquals(cleanPin(""), null);
  assertEquals(cleanPin("x".repeat(257)), null);
  assertEquals(cleanPin(123456), null);
  // Newline / CR / control chars would corrupt the passphrase file — rejected.
  for (const bad of ["12\n34", "12\r34", "12\t34", "ab\x00cd", "p\x7f"]) {
    assertEquals(cleanPin(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

Deno.test("commitArgs builds a hardened, forced-signature commit; PIN never appears", () => {
  const a = commitArgs("/nix/store/x-vibe-gpg/bin/vibe-gpg", "my message");
  assertEquals(a, [
    "-c", "gpg.format=openpgp",
    "-c", "gpg.program=/nix/store/x-vibe-gpg/bin/vibe-gpg",
    "commit", "--no-verify", "-S", "-m", "my message",
  ]);
  // gpg.format is pinned so a repo can't switch to ssh-signing + an arbitrary
  // gpg.ssh.program, and --no-verify skips repo commit hooks (exec as signer).
  assert(a.includes("gpg.format=openpgp"), "must pin gpg.format=openpgp");
  assert(a.includes("--no-verify"), "must skip repo commit hooks");
  // With no wrapper (feature off) gpg.program is omitted but the format stays pinned.
  assertEquals(commitArgs("", "x"), ["-c", "gpg.format=openpgp", "commit", "--no-verify", "-S", "-m", "x"]);
  // The message is a single argv element (no shell), so injection isn't possible.
  const tricky = commitArgs("", "a; rm -rf /\n-S --amend");
  assert(!tricky.includes("--amend"), "the message must stay a single arg, not be parsed as flags");
  assertEquals(tricky[tricky.length - 1], "a; rm -rf /\n-S --amend");
});

Deno.test("pushArgs: no branch ⇒ remote or bare push; branch ⇒ explicit -u push", () => {
  // No configured branch: bare push (current branch's upstream) or `push <remote>`.
  assertEquals(pushArgs("", ""), ["push", "--no-verify"]);
  assertEquals(pushArgs("   ", ""), ["push", "--no-verify"]);
  assertEquals(pushArgs("origin", ""), ["push", "--no-verify", "origin"]);
  assertEquals(pushArgs("  upstream  ", ""), ["push", "--no-verify", "upstream"]);
  // Configured branch: push it explicitly and set tracking (it may be brand new).
  assertEquals(pushArgs("", "feature/x"), ["push", "--no-verify", "--set-upstream", "origin", "feature/x"]);
  assertEquals(pushArgs("upstream", "feature/x"), ["push", "--no-verify", "--set-upstream", "upstream", "feature/x"]);
});

Deno.test("validBranch accepts safe refs and rejects flag-like / unsafe names", () => {
  assertEquals(validBranch(""), null); // "" = don't switch
  for (const ok of ["main", "feature/x", "release-1.2", "a_b", "wip/foo-bar"]) {
    assertEquals(validBranch(ok), ok, `should accept ${ok}`);
  }
  // Leading dash would be read as a flag by `git checkout`; also reject spaces /
  // control chars / leading dot.
  for (const bad of ["-f", "--force", "-b evil", "a b", "a\nb", ".hidden", "x\x00y"]) {
    assertEquals(validBranch(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

Deno.test("checkoutArgs creates with -b only when the branch is new", () => {
  assertEquals(checkoutArgs("feature/x", false), ["checkout", "feature/x"]);
  assertEquals(checkoutArgs("feature/x", true), ["checkout", "-b", "feature/x"]);
});

Deno.test("capabilities: disabled feature allows nothing, regardless of preset", () => {
  const c = cfg({ enable: false });
  assertEquals(commitPushEnabled(c), false);
  assertEquals(canCommit(c, preset({})), false);
  assertEquals(canPush(c, preset({})), false);
});

Deno.test("capabilities: per-preset touch gating (feature enabled)", () => {
  const c = cfg({ enable: true });
  // No touch on the preset → both allowed.
  assertEquals(canCommit(c, preset({})), true);
  assertEquals(canPush(c, preset({})), true);
  // commitRequiresTouch on the preset → commit (and thus the whole button) off.
  assertEquals(canCommit(c, preset({ commitRequiresTouch: true })), false);
  // pushRequiresTouch on the preset → commit stays, push off.
  assertEquals(canCommit(c, preset({ pushRequiresTouch: true })), true);
  assertEquals(canPush(c, preset({ pushRequiresTouch: true })), false);
});
