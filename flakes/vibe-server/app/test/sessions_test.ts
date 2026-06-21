import { shQuote, substitute } from "../src/sessions.ts";
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
