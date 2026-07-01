// Tests for transcript.ts — rendering Claude's JSONL session transcript into a
// readable, complete log. ZERO external imports (offline; uses ./assert.ts).

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  findTranscript,
  mangleProjectDir,
  readTail,
  renderRecord,
  renderTranscript,
  summarizeToolInput,
} from "../src/transcript.ts";

Deno.test("mangleProjectDir replaces every non-alphanumeric char (no run-collapse)", () => {
  // Matches Claude's on-disk projects/<dir> naming, incl. the "space-dash-space" → "---" case.
  assertEquals(
    mangleProjectDir("/home/hub/01 - Projects/calamooselabs/antlers"),
    "-home-hub-01---Projects-calamooselabs-antlers",
  );
  assertEquals(mangleProjectDir("/etc/nixos"), "-etc-nixos");
});

Deno.test("summarizeToolInput surfaces the key field per tool", () => {
  assertEquals(summarizeToolInput("Bash", { command: "ls -la", description: "list" }), "ls -la");
  assertEquals(summarizeToolInput("Read", { file_path: "/a/b.ts" }), "/a/b.ts");
  assertEquals(summarizeToolInput("Edit", { file_path: "/a/b.ts" }), "/a/b.ts");
  assertEquals(summarizeToolInput("Write", { file_path: "/a/b.ts" }), "/a/b.ts");
  assertEquals(summarizeToolInput("Grep", { pattern: "foo", path: "src" }), "foo (in src)");
  assertEquals(summarizeToolInput("WebSearch", { query: "deno pty" }), "deno pty");
  // Unknown tool → compact JSON, capped.
  assertStringIncludes(summarizeToolInput("Mystery", { a: 1 }), "\"a\":1");
});

Deno.test("renderRecord: user string prompt", () => {
  assertEquals(
    renderRecord({ type: "user", message: { role: "user", content: "Fix the bug" } }),
    "\n❯ Fix the bug\n",
  );
});

Deno.test("renderRecord: assistant text", () => {
  const out = renderRecord({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
  });
  assertEquals(out, "\n● On it.\n");
});

Deno.test("renderRecord: assistant thinking is skipped", () => {
  const out = renderRecord({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }] },
  });
  assertEquals(out, "");
  assert(!out.includes("secret reasoning"), "thinking must not leak into the log");
});

Deno.test("renderRecord: assistant Bash tool_use shows the command", () => {
  const out = renderRecord({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "nix flake check" } }] },
  });
  assertStringIncludes(out, "⏵ Bash $ nix flake check");
});

Deno.test("renderRecord: user tool_result is rendered and truncated", () => {
  const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const out = renderRecord({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: big, is_error: false }] },
  });
  assertStringIncludes(out, "⎿ line 0");
  assertStringIncludes(out, "truncated"); // 100 lines exceeds the 40-line cap
  assert(!out.includes("line 99"), "content past the cap must be dropped");
});

Deno.test("renderRecord: error tool_result is marked", () => {
  const out = renderRecord({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "boom", is_error: true }] },
  });
  assertStringIncludes(out, "[error]");
  assertStringIncludes(out, "boom");
});

Deno.test("renderRecord: tool_result with array content (text blocks) flattens", () => {
  const out = renderRecord({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] }],
    },
  });
  assertStringIncludes(out, "hello");
  assertStringIncludes(out, "world");
});

Deno.test("renderRecord: bookkeeping record types are skipped", () => {
  for (const type of ["mode", "permission-mode", "bridge-session", "file-history-snapshot", "ai-title", "attachment", "last-prompt"]) {
    assertEquals(renderRecord({ type }), "");
  }
});

Deno.test("readTail returns the whole file when under the cap, else the last maxBytes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/f.bin`;
    await Deno.writeTextFile(path, "0123456789");
    assertEquals(new TextDecoder().decode(await readTail(path, 100)), "0123456789");
    assertEquals(new TextDecoder().decode(await readTail(path, 4)), "6789");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findTranscript picks the newest *.jsonl at/after startedAt, null when absent/stale", async () => {
  const cfg = await Deno.makeTempDir();
  try {
    const cwd = "/home/u/proj";
    const projDir = `${cfg}/projects/${mangleProjectDir(cwd)}`;
    await Deno.mkdir(projDir, { recursive: true });
    const older = `${projDir}/older.jsonl`;
    const newer = `${projDir}/newer.jsonl`;
    await Deno.writeTextFile(older, "{}\n");
    await Deno.writeTextFile(newer, "{}\n");
    // Pin deterministic mtimes (epoch seconds): older=1000s, newer=2000s.
    await Deno.utime(older, 1000, 1000);
    await Deno.utime(newer, 2000, 2000);

    // startedAt before both → newest (by mtime) wins.
    assertEquals(await findTranscript(cfg, cwd, 0), newer);
    // startedAt after both (beyond the slack) → none qualify.
    assertEquals(await findTranscript(cfg, cwd, 5_000_000), null);
    // Unknown project dir → null, not a throw.
    assertEquals(await findTranscript(cfg, "/no/such/dir/ever", 0), null);
  } finally {
    await Deno.remove(cfg, { recursive: true });
  }
});

Deno.test("renderTranscript: full conversation, parse-error tolerant, blanks collapsed", () => {
  const jsonl = [
    JSON.stringify({ type: "ai-title", title: "x" }), // skipped
    JSON.stringify({ type: "user", message: { role: "user", content: "Hi" } }),
    "{ this is not json", // partial/garbage line — must be skipped, not fatal
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello!" }, { type: "tool_use", name: "Read", input: { file_path: "/x" } }] },
    }),
    "", // blank line
  ].join("\n");
  const out = renderTranscript(jsonl);
  assertStringIncludes(out, "❯ Hi");
  assertStringIncludes(out, "● Hello!");
  assertStringIncludes(out, "⏵ Read: /x");
  assert(!out.includes("not json"), "garbage line must be ignored");
  assert(!/\n{3,}/.test(out), "no runs of 3+ blank lines");
  assert(!/^\s/.test(out), "no leading whitespace");
});
