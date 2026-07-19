import { b64url, parseCookies, timingSafeEqual } from "../server/util.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("timingSafeEqual matches equal strings and rejects others", () => {
  assert(timingSafeEqual("hunter2", "hunter2"));
  assert(!timingSafeEqual("hunter2", "hunter3"));
  assert(!timingSafeEqual("short", "longerstring"));
  assert(timingSafeEqual("", ""));
});

Deno.test("parseCookies handles multiple cookies and spacing", () => {
  assertEquals(parseCookies("a=1; b=two;c=3"), { a: "1", b: "two", c: "3" });
  assertEquals(parseCookies(null), {});
  assertEquals(parseCookies("upm_session=abc.def"), { upm_session: "abc.def" });
});

Deno.test("b64url is url-safe and unpadded", () => {
  const s = b64url(new Uint8Array([255, 254, 253, 0, 1, 2]));
  assert(!s.includes("+") && !s.includes("/") && !s.includes("="));
});
