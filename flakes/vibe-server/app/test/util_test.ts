import { b64url, isError, isValidName, unb64url } from "../src/util.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("b64url round-trips arbitrary bytes (url-safe, unpadded)", () => {
  for (const len of [0, 1, 2, 3, 8, 9, 32, 255]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
    const enc = b64url(bytes);
    assert(!/[+/=]/.test(enc), `encoding must be url-safe & unpadded, got ${enc}`);
    assertEquals([...unb64url(enc)], [...bytes], `round-trip mismatch at len ${len}`);
  }
});

Deno.test("b64url encodes the known vector for 0xFB 0xFF 0xFE", () => {
  // these bytes exercise the chars that differ between std and url-safe base64
  assertEquals(b64url(new Uint8Array([0xfb, 0xff, 0xfe])), "-__-");
});

Deno.test("isValidName accepts the directory-name charset only", () => {
  for (const ok of ["antlers", "OpenReturn-UI", "a_b-1", "X"]) assert(isValidName(ok), `should accept ${ok}`);
  for (const bad of ["", "a b", "a/b", "../x", "a.b", "naughty;rm", "a\nb"]) {
    assert(!isValidName(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

Deno.test("isError narrows only real Errors", () => {
  assert(isError(new Error("x")));
  assert(isError(new TypeError("x")));
  assert(!isError("nope"));
  assert(!isError({ message: "fake" }));
  assert(!isError(null));
});
