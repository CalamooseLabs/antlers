import {
  checkPassword,
  clearCookie,
  initKey,
  isAuthed,
  loginAllowed,
  loginFailed,
  loginSucceeded,
  newSessionCookie,
  passwordRequired,
} from "../src/auth.ts";
import { assert, assertEquals } from "./assert.ts";

const SECRET = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
const reqWithCookie = (c: string) => new Request("http://vibe.local/", { headers: { cookie: c } });
const cookiePair = (setCookie: string) => setCookie.split(";")[0]; // "vibe_session=<token>"

Deno.test("passwordRequired: only a non-blank file path means a password is required", () => {
  assert(!passwordRequired(""));
  assert(!passwordRequired("   "));
  assert(passwordRequired("/run/secrets/vibe-password"));
});

Deno.test("session cookie signs and verifies (HMAC round-trip)", async () => {
  await initKey(SECRET);
  const cookie = cookiePair(await newSessionCookie(false));
  assert(await isAuthed(reqWithCookie(cookie)), "fresh cookie should authenticate");
});

Deno.test("a tampered cookie is rejected", async () => {
  await initKey(SECRET);
  const cookie = cookiePair(await newSessionCookie(false));
  // flip the final char of the token (signature byte) — must fail verification
  const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
  assert(!(await isAuthed(reqWithCookie(tampered))), "tampered cookie must not authenticate");
});

Deno.test("a cookie signed under a different key is rejected", async () => {
  await initKey(SECRET);
  const cookie = cookiePair(await newSessionCookie(false));
  await initKey(new Uint8Array(32).fill(9)); // rotate the secret
  assert(!(await isAuthed(reqWithCookie(cookie))), "cookie from old key must not verify");
  await initKey(SECRET); // restore for other tests
});

Deno.test("no cookie / cleared cookie does not authenticate", async () => {
  await initKey(SECRET);
  assert(!(await isAuthed(new Request("http://vibe.local/"))));
  assert(!(await isAuthed(reqWithCookie(cookiePair(clearCookie(false))))));
});

Deno.test("checkPassword compares the trimmed file contents", async () => {
  const f = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(f, "hunter2\n");
    assert(await checkPassword("hunter2", f), "correct password should match (trailing newline trimmed)");
    assert(!(await checkPassword("hunter3", f)), "wrong password should not match");
    assert(!(await checkPassword("", f)), "empty submission should not match");
  } finally {
    await Deno.remove(f);
  }
});

Deno.test("checkPassword rejects an empty file or a missing file", async () => {
  const f = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(f, "   \n");
    assert(!(await checkPassword("", f)), "blank password file never matches");
    assert(!(await checkPassword("anything", f)));
  } finally {
    await Deno.remove(f);
  }
  assert(!(await checkPassword("x", "/no/such/password/file")), "missing file → false, not throw");
});

Deno.test("login rate-limit blocks after the free tries, and a success clears it", () => {
  const ip = "203.0.113.7"; // unique per test (module state persists across tests)
  assert(loginAllowed(ip).ok, "fresh ip is allowed");
  for (let i = 0; i < 5; i++) loginFailed(ip);
  const gate = loginAllowed(ip);
  assert(!gate.ok, "should be blocked after exceeding the free tries");
  assert(gate.retryAfter > 0, "a positive retry-after is reported");
  loginSucceeded(ip);
  assert(loginAllowed(ip).ok, "a successful login clears the block");
});
