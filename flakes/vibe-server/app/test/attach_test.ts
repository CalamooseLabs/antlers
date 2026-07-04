// Unit tests for the interactive attach client's pure helpers (attach.ts). The
// socket/tty/raw-mode plumbing needs a live server + terminal, so only the pure
// parsing/scanning is covered here. ZERO external imports (see ./assert.ts).

import { assert, assertEquals } from "./assert.ts";
import { attachWsUrl, indexOfByte, parseAttachArgs } from "../src/attach.ts";

Deno.test("parseAttachArgs: flags in any order + lone positional id", () => {
  assertEquals(
    parseAttachArgs(["--url", "http://127.0.0.1:8420", "--token", "abc-_9", "sess1"]),
    { url: "http://127.0.0.1:8420", token: "abc-_9", id: "sess1" },
  );
  // Positional before flags, and = form.
  assertEquals(
    parseAttachArgs(["sess2", "--url=http://x", "--token=t"]),
    { url: "http://x", token: "t", id: "sess2" },
  );
  // Explicit --id wins over relying on the positional.
  assertEquals(
    parseAttachArgs(["--id", "sess3", "--url", "u", "--token", "t"]),
    { url: "u", token: "t", id: "sess3" },
  );
});

Deno.test("parseAttachArgs: reports missing/invalid args", () => {
  assert("error" in parseAttachArgs(["--token", "t", "id"]), "missing url should error");
  assert("error" in parseAttachArgs(["--url", "u", "id"]), "missing token should error");
  assert("error" in parseAttachArgs(["--url", "u", "--token", "t"]), "missing id should error");
  assert("error" in parseAttachArgs(["--bogus", "x", "--url", "u", "--token", "t", "id"]), "unknown flag should error");
  assert("error" in parseAttachArgs(["a", "b", "--url", "u", "--token", "t"]), "second positional should error");
});

Deno.test("indexOfByte: finds the detach byte, or -1", () => {
  assertEquals(indexOfByte(new Uint8Array([0x61, 0x62, 0x03, 0x63]), 0x03), 2);
  assertEquals(indexOfByte(new Uint8Array([0x03]), 0x03), 0);
  assertEquals(indexOfByte(new Uint8Array([0x61, 0x62, 0x63]), 0x03), -1);
  assertEquals(indexOfByte(new Uint8Array([]), 0x03), -1);
});

Deno.test("attachWsUrl: http→ws, https→wss, id path-encoded", () => {
  assertEquals(attachWsUrl("http://127.0.0.1:8420", "abc"), "ws://127.0.0.1:8420/api/local/sessions/abc/attach");
  assertEquals(attachWsUrl("https://vibe.example.com", "x1"), "wss://vibe.example.com/api/local/sessions/x1/attach");
});
