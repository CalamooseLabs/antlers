import { INDEX_HTML, LOGIN_HTML } from "../server/html.ts";
import { assert, assertStringIncludes } from "./assert.ts";

Deno.test("INDEX_HTML is dark and wires the expected endpoints", () => {
  assertStringIncludes(INDEX_HTML, "color-scheme: dark");
  assertStringIncludes(INDEX_HTML, "/ws/live/");
  assertStringIncludes(INDEX_HTML, "/ws/events");
  assertStringIncludes(INDEX_HTML, "/api/cameras");
  assertStringIncludes(INDEX_HTML, "/snapshot/");
  assertStringIncludes(INDEX_HTML, "MediaSource");
  assertStringIncludes(INDEX_HTML, "cameras"); // ?cameras= focus mode
});

Deno.test("INDEX_HTML client script avoids template-literal syntax (kept as a JS template literal)", () => {
  // The inlined <script> must not contain backticks or the dollar-brace sequence, or the
  // outer template literal in html.ts would be broken.
  const script = INDEX_HTML.slice(INDEX_HTML.indexOf("<script>"));
  assert(!script.includes("`"), "client script must not contain backticks");
  assert(!script.includes("$" + "{"), "client script must not contain a dollar-brace sequence");
});

Deno.test("LOGIN_HTML posts to /api/login", () => {
  assertStringIncludes(LOGIN_HTML, "/api/login");
  assertStringIncludes(LOGIN_HTML, "password");
});
