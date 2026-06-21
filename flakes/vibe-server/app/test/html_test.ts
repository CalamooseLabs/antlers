// Guards the single-page UI's inlined browser script. ZERO external imports.
//
// INDEX_HTML is a template literal, so its inlined <script> is just a STRING as
// far as `deno test`/`deno compile` are concerned — a syntax error inside it
// (e.g. writing `\"` instead of `\\"`, which the template literal collapses to a
// bare `"` and breaks the emitted string) type-checks and compiles fine, then
// fails to parse IN THE BROWSER. One such error anywhere aborts the whole script,
// so the UI never boots and the page is blank ("nothing shows up"). These tests
// parse the emitted script the way a browser would, so that class of bug fails
// here instead of silently shipping.

import { INDEX_HTML } from "../src/html.ts";
import { assert, assertStringIncludes } from "./assert.ts";

function browserScript(): string {
  const m = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert(m, "INDEX_HTML must contain exactly one <script> block");
  return m![1];
}

Deno.test("the inlined browser script parses as valid JavaScript", () => {
  const src = browserScript();
  // `new Function(body)` parses the entire body (V8 pre-parses nested functions
  // too, so a syntax error deep inside one is still caught) WITHOUT executing it,
  // so undefined browser globals (document, EventSource, …) and the trailing
  // boot() call don't matter — only syntax does.
  try {
    new Function(src);
  } catch (e) {
    throw new Error(
      `inlined browser script is not valid JS — it would break the page on load: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
});

Deno.test("no stray single-backslash escapes survive into the emitted script", () => {
  // In the source these must be doubled (\\" , \\n , \\/) so they reach the
  // browser intact; if a single-backslash slips through, the cases it would break
  // (a bare " inside a "…" string) are already caught by the parse test above, but
  // assert the specific known-bad line renders correctly as a focused regression.
  const src = browserScript();
  assertStringIncludes(src, 'Commits go to branch \\"');
});
