import { cleanGeneratedMessage, commitMessagePrompt, extractLoginError, extractLoginUrl, mergeOnboarding, parseAuthStatus } from "../src/claude.ts";
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";

// A realistic `claude auth login` capture: the URL appears inside an OSC-8
// terminal-hyperlink escape (ESC ] 8 ; ; <uri> ST <text> ...), then again as the
// visible text, on one line, followed by the paste prompt.
const ESC = "\x1b";
const ST = ESC + "\\";
const LOGIN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc123&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile+user%3Ainference&code_challenge=XyZ_-09&code_challenge_method=S256&state=Q6Ok0Il-Vx";
const LOGIN_CAPTURE = "Opening browser to sign in…\r\n" +
  "If the browser didn't open, visit: " +
  ESC + "]8;;" + LOGIN_URL + ST + LOGIN_URL + ESC + "]8;;" + ST + "\r\n" +
  "Paste code here if prompted > ";

Deno.test("extractLoginUrl pulls the claude.com OAuth URL out of OSC-8 escapes", () => {
  assertEquals(extractLoginUrl(LOGIN_CAPTURE), LOGIN_URL);
});

Deno.test("extractLoginUrl stops at control chars (no trailing escape junk)", () => {
  const u = extractLoginUrl(LOGIN_CAPTURE);
  assert(u !== null);
  assert(!(u as string).includes("\x1b"), "must not include the ESC terminator");
  assert((u as string).endsWith("state=Q6Ok0Il-Vx"), "must capture the full query string");
});

Deno.test("extractLoginUrl returns null when there is no auth URL", () => {
  assertEquals(extractLoginUrl("just some boring session output\nno url here"), null);
  // A non-Anthropic host must not match.
  assertEquals(extractLoginUrl("visit https://evil.example.com/cai/oauth/x"), null);
});

Deno.test("parseAuthStatus reads a logged-in status", () => {
  const s = parseAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "it@nkcfo.com",
    subscriptionType: "team",
    orgName: "NKCFO, LLC",
  }));
  assertEquals(s.loggedIn, true);
  assertEquals(s.email, "it@nkcfo.com");
  assertEquals(s.subscriptionType, "team");
});

Deno.test("parseAuthStatus reads a not-logged-in status (exit 1 still prints JSON)", () => {
  const s = parseAuthStatus(JSON.stringify({ loggedIn: false, authMethod: "none" }));
  assertEquals(s.loggedIn, false);
  assertEquals(s.email, undefined);
});

Deno.test("parseAuthStatus tolerates surrounding noise / bad input", () => {
  assertEquals(parseAuthStatus('warning: foo\n{"loggedIn":true}\n').loggedIn, true);
  assertEquals(parseAuthStatus("not json at all").loggedIn, false);
  assert(parseAuthStatus("not json at all").error !== undefined);
});

Deno.test("mergeOnboarding sets onboarding + theme + per-dir trust, preserving the rest", () => {
  const out = mergeOnboarding(
    { userID: "u1", theme: "light", projects: { "/keep": { foo: 1 } } },
    "dark",
    ["/srv/a", "/srv/b"],
  );
  assertEquals(out.hasCompletedOnboarding, true);
  assertEquals(out.theme, "dark");
  assertEquals(out.userID, "u1"); // unrelated keys preserved
  const projects = out.projects as Record<string, Record<string, unknown>>;
  assertEquals(projects["/keep"], { foo: 1 }); // existing project untouched
  assertEquals(projects["/srv/a"].hasTrustDialogAccepted, true);
  assertEquals(projects["/srv/a"].hasCompletedProjectOnboarding, true);
  assertEquals(projects["/srv/b"].hasTrustDialogAccepted, true);
});

Deno.test("mergeOnboarding merges into an existing project entry without dropping its keys", () => {
  const out = mergeOnboarding({ projects: { "/srv/a": { mcpServers: { x: 1 } } } }, "dark", ["/srv/a"]);
  const a = (out.projects as Record<string, Record<string, unknown>>)["/srv/a"];
  assertEquals(a.mcpServers, { x: 1 });
  assertEquals(a.hasTrustDialogAccepted, true);
});

Deno.test("mergeOnboarding tolerates a missing/garbage projects field", () => {
  const out = mergeOnboarding({ projects: "oops" as unknown as Record<string, unknown> }, "dark", ["/srv/a"]);
  const projects = out.projects as Record<string, Record<string, unknown>>;
  assertEquals(projects["/srv/a"].hasTrustDialogAccepted, true);
});

Deno.test("extractLoginError reads the failure line out of ANSI-laden output", () => {
  const text = "\x1b[2mPaste code here > \x1b[0mLogin failed: Request failed with status code 400\r\n";
  assertEquals(extractLoginError(text), "Login failed: Request failed with status code 400");
  assertEquals(extractLoginError("all good, no failure here"), undefined);
});

// ---- commit-message drafting (claude -p prompt + output cleaning) ----

Deno.test("commitMessagePrompt embeds the diff and forbids AI/co-author trailers", () => {
  const p = commitMessagePrompt("diff --git a/x b/x\n+hello");
  assertStringIncludes(p, "diff --git a/x b/x");
  assertStringIncludes(p, "imperative subject");
  // The convention: no "Generated with Claude Code" / "Co-Authored-By" trailers.
  assertStringIncludes(p, "Co-Authored-By");
  assertStringIncludes(p, "Generated with Claude Code");
});

Deno.test("cleanGeneratedMessage strips code fences, trailers, and trims", () => {
  // A bare message passes through.
  assertEquals(cleanGeneratedMessage("  Fix the parser\n\nHandle empty input.  "), "Fix the parser\n\nHandle empty input.");
  // A wrapping ```fence``` is removed.
  assertEquals(cleanGeneratedMessage("```\nAdd retries\n```"), "Add retries");
  assertEquals(cleanGeneratedMessage("```text\nAdd retries\n```"), "Add retries");
  // CRLF is normalized.
  assertEquals(cleanGeneratedMessage("subject\r\n\r\nbody"), "subject\n\nbody");
  // Stray AI / co-author trailers the model may add anyway are dropped.
  assertEquals(
    cleanGeneratedMessage("Refactor auth\n\n\u{1F916} Generated with Claude Code\nCo-Authored-By: Claude <noreply@anthropic.com>"),
    "Refactor auth",
  );
  // Empty / whitespace-only ⇒ "".
  assertEquals(cleanGeneratedMessage("   \n\t "), "");
});
