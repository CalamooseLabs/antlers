import { cleanSuggestion, joinDiffsForPrompt } from "../src/suggest.ts";
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";

Deno.test("cleanSuggestion normalizes CRLF and trims", () => {
  assertEquals(cleanSuggestion("  Fix bug\r\n\r\nDetails.  \n"), "Fix bug\n\nDetails.");
  assertEquals(cleanSuggestion("\r\n\r\n"), "");
  assertEquals(cleanSuggestion("single line"), "single line");
  assertEquals(cleanSuggestion("old\rmac\rlines"), "old\nmac\nlines");
});

Deno.test("joinDiffsForPrompt keeps only changed repos, each labeled by path", () => {
  const blob = joinDiffsForPrompt([
    { path: "/a", isRepo: true, empty: false, diff: "diff A" },
    { path: "/b", isRepo: true, empty: true, diff: "" }, // clean → dropped
    { path: "/c", isRepo: false, empty: true, diff: "" }, // non-repo → dropped
    { path: "/d", isRepo: true, empty: false, diff: "   " }, // whitespace-only → dropped
    { path: "/e", isRepo: true, empty: false, diff: "diff E" },
  ]);
  assertStringIncludes(blob, "# /a\ndiff A");
  assertStringIncludes(blob, "# /e\ndiff E");
  assert(!blob.includes("/b"), "clean repo must be dropped");
  assert(!blob.includes("/c"), "non-repo dir must be dropped");
  assert(!blob.includes("/d"), "whitespace-only diff must be dropped");
});

Deno.test("joinDiffsForPrompt is empty when nothing changed", () => {
  assertEquals(joinDiffsForPrompt([{ path: "/a", isRepo: true, empty: true, diff: "" }]), "");
  assertEquals(joinDiffsForPrompt([]), "");
});
