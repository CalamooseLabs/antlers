import { basenameOf, isLoopbackIp, normalizeAbs, sanitizeName, uniqueName, withinRoot } from "../src/util.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("normalizeAbs resolves . and .. and collapses slashes", () => {
  assertEquals(normalizeAbs("/a/b/../c"), "/a/c");
  assertEquals(normalizeAbs("/a//b/./c/"), "/a/b/c");
  assertEquals(normalizeAbs("/"), "/");
  assertEquals(normalizeAbs(""), "/");
  // ".." can never climb above root.
  assertEquals(normalizeAbs("/a/b/../../.."), "/");
  assertEquals(normalizeAbs("/../etc"), "/etc");
});

Deno.test("withinRoot bounds paths to a root (no prefix false-positives)", () => {
  assert(withinRoot("/home", "/home"));
  assert(withinRoot("/home", "/home/hub/x"));
  assert(!withinRoot("/home", "/homework")); // shares a prefix but is not a child
  assert(!withinRoot("/home", "/etc"));
  assert(withinRoot("/", "/anything/here")); // "/" contains everything
});

Deno.test("sanitizeName reduces to the safe label charset", () => {
  assertEquals(sanitizeName("My Project!"), "My-Project");
  assertEquals(sanitizeName("a_b-c"), "a_b-c");
  assertEquals(sanitizeName("--x--"), "x");
  assertEquals(sanitizeName("///"), "project"); // empty after stripping → fallback
  assertEquals(sanitizeName("café münch"), "caf-m-nch");
});

Deno.test("uniqueName avoids collisions with a numeric suffix", () => {
  const taken = new Set(["foo", "foo-2"]);
  assertEquals(uniqueName("foo", taken), "foo-3");
  assertEquals(uniqueName("bar", taken), "bar");
});

Deno.test("basenameOf returns the final segment", () => {
  assertEquals(basenameOf("/a/b/c"), "c");
  assertEquals(basenameOf("/a/b/"), "b");
  assertEquals(basenameOf("/x"), "x");
  assertEquals(basenameOf("/"), "");
});

Deno.test("isLoopbackIp recognizes only loopback peers", () => {
  assert(isLoopbackIp("127.0.0.1"));
  assert(isLoopbackIp("::1"));
  assert(isLoopbackIp("::ffff:127.0.0.1"));
  assert(isLoopbackIp("127.5.5.5"));
  assert(!isLoopbackIp("192.168.1.10"));
  assert(!isLoopbackIp("10.0.0.1"));
  assert(!isLoopbackIp(""));
});
