import { gitDiff } from "../src/diff.ts";
import { assert, assertEquals } from "./assert.ts";

// Run a git setup command in `dir`. Identity is forced via -c so commits work
// regardless of ambient config (gitDiff's own reads scrub the env separately).
async function git(dir: string, ...args: string[]): Promise<void> {
  const cmd = new Deno.Command("git", {
    // Force identity and disable commit signing so setup works regardless of the
    // ambient git config (e.g. a global commit.gpgsign = true).
    args: ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false", ...args],
    stdout: "null",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`);
}

async function repo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-diff-" });
  await git(dir, "init", "-q");
  return dir;
}

Deno.test("gitDiff: a non-repo directory is reported as not-a-repo, not an error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-nonrepo-" });
  try {
    const r = await gitDiff(dir);
    assertEquals(r.isRepo, false);
    assert(!r.error, "not-a-repo is a normal state, not an error");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitDiff: a clean committed tree is empty", async () => {
  const dir = await repo();
  try {
    await Deno.writeTextFile(`${dir}/hello.txt`, "one\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");
    const r = await gitDiff(dir);
    assertEquals(r.isRepo, true);
    assertEquals(r.empty, true);
    assertEquals(r.diff.trim(), "");
    assert(!r.error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitDiff: a tracked modification appears in the diff", async () => {
  const dir = await repo();
  try {
    await Deno.writeTextFile(`${dir}/hello.txt`, "one\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");
    await Deno.writeTextFile(`${dir}/hello.txt`, "two\n");
    const r = await gitDiff(dir);
    assertEquals(r.isRepo, true);
    assertEquals(r.empty, false);
    assert(r.diff.includes("hello.txt"), "diff names the changed file");
    assert(r.diff.includes("-one"), "diff shows the removed line");
    assert(r.diff.includes("+two"), "diff shows the added line");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitDiff: an untracked (non-ignored) file shows up", async () => {
  const dir = await repo();
  try {
    await Deno.writeTextFile(`${dir}/hello.txt`, "one\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");
    await Deno.writeTextFile(`${dir}/fresh.txt`, "brand new\n");
    const r = await gitDiff(dir);
    assert(r.diff.includes("fresh.txt"), "untracked file is included");
    assert(r.diff.includes("brand new"), "untracked file content is shown");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitDiff: .gitignore'd file content never appears", async () => {
  const dir = await repo();
  try {
    await Deno.writeTextFile(`${dir}/.gitignore`, "secret.env\n");
    await Deno.writeTextFile(`${dir}/secret.env`, "TOKEN=supersecret\n");
    const r = await gitDiff(dir);
    assert(r.isRepo, "is a repo");
    assert(!r.diff.includes("TOKEN=supersecret"), "the ignored secret's content must never leak into the diff");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
