import { clampClipWindow, decodeJwtExpMs } from "../server/protect-internal.ts";
import { assertEquals } from "./assert.ts";

function jwt(exp: number): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "hdr." + b64url(JSON.stringify({ exp })) + ".sig";
}

Deno.test("decodeJwtExpMs reads exp (seconds) as ms; rejects garbage", () => {
  assertEquals(decodeJwtExpMs(jwt(1700000000)), 1700000000000);
  assertEquals(decodeJwtExpMs("not-a-jwt"), null);
  assertEquals(decodeJwtExpMs("only.two"), null);
});

Deno.test("clampClipWindow clamps to coverage and caps length", () => {
  const cov = { recordingStart: 1000, recordingEnd: 10000, mode: "always" };
  assertEquals(clampClipWindow(2000, 5000, cov, 60000), { start: 2000, end: 5000 }); // within
  assertEquals(clampClipWindow(500, 5000, cov, 60000), { start: 1000, end: 5000 }); // start clamped up
  assertEquals(clampClipWindow(2000, 99999, cov, 60000), { start: 2000, end: 10000 }); // end clamped down
  assertEquals(clampClipWindow(2000, 9000, cov, 3000), { start: 2000, end: 5000 }); // length capped
  assertEquals(clampClipWindow(5000, 5000, cov, 60000), null); // empty
  assertEquals(clampClipWindow(20000, 30000, cov, 60000), null); // entirely past coverage
});

Deno.test("clampClipWindow tolerates missing coverage bounds", () => {
  const cov = { recordingStart: null, recordingEnd: null, mode: "always" };
  assertEquals(clampClipWindow(2000, 5000, cov, 60000), { start: 2000, end: 5000 });
  assertEquals(clampClipWindow(2000, 5000, undefined, 60000), { start: 2000, end: 5000 });
});
