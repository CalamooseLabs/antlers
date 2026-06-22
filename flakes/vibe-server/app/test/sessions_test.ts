import { cleanInput, inputChunks, shQuote, submitInput, substitute } from "../src/sessions.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("substitute replaces @DIR@/@NAME@ everywhere, leaves the rest", () => {
  const cmd = ["/nix/store/x/bin/vibe", "--remote-control", "@NAME@", "--cwd=@DIR@"];
  assertEquals(
    substitute(cmd, { DIR: "/srv/p", NAME: "antlers-20260620" }),
    ["/nix/store/x/bin/vibe", "--remote-control", "antlers-20260620", "--cwd=/srv/p"],
  );
});

Deno.test("substitute replaces repeated placeholders in one token", () => {
  assertEquals(substitute(["@NAME@-@NAME@"], { NAME: "x" }), ["x-x"]);
});

Deno.test("shQuote wraps in single quotes and is shell-safe", () => {
  assertEquals(shQuote("plain"), "'plain'");
  assertEquals(shQuote("/home/hub/01 - Projects/antlers"), "'/home/hub/01 - Projects/antlers'");
});

Deno.test("shQuote escapes embedded single quotes (no shell break-out)", () => {
  // A name like  a'b  must not let the quote escape the literal.
  assertEquals(shQuote("a'b"), "'a'\\''b'");
  // Metacharacters stay literal inside the single quotes.
  const q = shQuote("$(touch /tmp/pwned); rm -rf ~");
  assert(q.startsWith("'") && q.endsWith("'"));
  assert(!q.includes("''$"), "must not accidentally close the quote before $");
});

Deno.test("cleanInput passes through ordinary text (and unicode), trimmed", () => {
  assertEquals(cleanInput("fix the failing test please"), "fix the failing test please");
  assertEquals(cleanInput("  run the build  "), "run the build");
  assertEquals(cleanInput("café ☕ déjà"), "café ☕ déjà");
});

Deno.test("cleanInput collapses newlines to spaces (one prompt, not per-line submit)", () => {
  assertEquals(cleanInput("line one\nline two"), "line one line two");
  assertEquals(cleanInput("a\r\nb\rc"), "a b c");
  // A trailing newline must not leave a dangling space (trim runs last).
  assertEquals(cleanInput("only line\n"), "only line");
});

Deno.test("cleanInput drops control bytes so a CSI sequence can't drive the TUI", () => {
  // The ESC *initiator* (\x1b) is a control byte → stripped, which neutralizes the
  // sequence; the residual "[2J" is then inert literal text, not an erase command.
  const out = cleanInput("hi\x1b[2Jthere\x00");
  assert(!out.includes("\x1b"), "ESC byte must be stripped");
  assert(!out.includes("\x00"), "NUL byte must be stripped");
  assertEquals(out, "hi[2Jthere");
  assertEquals(cleanInput("tab\tseparated"), "tabseparated");
  assertEquals(cleanInput("bell\x07del\x7f"), "belldel");
});

Deno.test("inputChunks emits the text and the Enter (CR) as two separate chunks", () => {
  const dec = new TextDecoder();
  const [text, enter] = inputChunks("do the thing");
  assertEquals(dec.decode(text), "do the thing");
  // The CR is its OWN chunk, not glued onto the text. This shape is necessary but
  // NOT sufficient — it's the *pause between the writes* (exercised in the
  // submitInput tests below) that actually makes the TUI submit; see SUBMIT_DELAY_MS.
  assertEquals(dec.decode(enter), "\r");
});

// A stand-in for the PTY input writer that records each write() as decoded text,
// so submitInput's write count/ordering is assertable without a real PTY.
function recordingWriter() {
  const dec = new TextDecoder();
  const writes: string[] = [];
  return {
    writes,
    write(chunk: Uint8Array): Promise<void> {
      writes.push(dec.decode(chunk));
      return Promise.resolve();
    },
  };
}

Deno.test("submitInput writes the text first, then a lone Enter (CR) — two ordered writes", async () => {
  const w = recordingWriter();
  await submitInput(w, "do the thing", 0); // delayMs 0 → no real wait in the test
  // Exactly two writes, text then CR — NOT one combined write (which the PTY would
  // coalesce into a paste: the original bug), and NOT a CR glued onto the text.
  assertEquals(w.writes, ["do the thing", "\r"]);
});

Deno.test("chaining submitInput serializes concurrent sends so writes never interleave", async () => {
  const w = recordingWriter();
  // Replicate sendInput's per-session sendChain: each send awaits the previous.
  let chain: Promise<void> = Promise.resolve();
  const a = (chain = chain.then(() => submitInput(w, "AAAA", 1)));
  const b = (chain = chain.then(() => submitInput(w, "BBBB", 1)));
  await Promise.all([a, b]);
  // Each message's text+CR stays contiguous. Unchained, the delay would let B's
  // text land between A's text and CR (AAAA, BBBB, \r, \r → a garbled submit).
  assertEquals(w.writes, ["AAAA", "\r", "BBBB", "\r"]);
});

Deno.test("cleanInput returns empty for blank or non-string input", () => {
  assertEquals(cleanInput(""), "");
  assertEquals(cleanInput("   \n\t  "), "");
  assertEquals(cleanInput(undefined), "");
  assertEquals(cleanInput(null), "");
  assertEquals(cleanInput(42), "");
  assertEquals(cleanInput({ message: "x" }), "");
});
