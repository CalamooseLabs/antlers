import { consoleRoot, parseConfig, resolveApiKey, resolveRecordingPassword } from "../server/config.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";

Deno.test("parseConfig applies defaults and strips a trailing slash from consoleUrl", () => {
  const c = parseConfig({ consoleUrl: "https://10.0.0.1/proxy/protect/integration/" });
  assertEquals(c.consoleUrl, "https://10.0.0.1/proxy/protect/integration");
  assertEquals(c.port, 8460);
  assertEquals(c.defaultQuality, "medium");
});

Deno.test("parseConfig rejects unknown keys", () => {
  assertThrows(() => parseConfig({ bogus: 1 }));
});

Deno.test("parseConfig rejects a non-http consoleUrl", () => {
  assertThrows(() => parseConfig({ consoleUrl: "ftp://nope" }));
});

Deno.test("parseConfig sanitises qualities", () => {
  const c = parseConfig({ streamQualities: ["high", "garbage", "low"], defaultQuality: "nope" });
  assertEquals(c.streamQualities, ["high", "low"]);
  assertEquals(c.defaultQuality, "medium"); // invalid -> default
});

Deno.test("resolveApiKey prefers the file over the inline string", async () => {
  const tmp = await Deno.makeTempFile();
  await Deno.writeTextFile(tmp, "  file-secret\n");
  try {
    const c = parseConfig({ apiKey: "inline", apiKeyFile: tmp });
    assertEquals(await resolveApiKey(c), "file-secret");
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("resolveApiKey falls back to the inline string", async () => {
  const c = parseConfig({ apiKey: "inline-key" });
  assertEquals(await resolveApiKey(c), "inline-key");
});

Deno.test("resolveApiKey throws when the file is missing", async () => {
  const c = parseConfig({ apiKeyFile: "/definitely/not/here" });
  await assertRejects(() => resolveApiKey(c));
  assert(true);
});

Deno.test("recordings keys default off and coerce", () => {
  const d = parseConfig({});
  assertEquals(d.recordingsEnabled, false);
  assertEquals(d.recordingChannel, 0);
  assertEquals(d.maxClipDurationMs, 120000);
  assertEquals(parseConfig({ recordingChannel: 5 }).recordingChannel, 0); // invalid -> 0
  assertEquals(parseConfig({ recordingChannel: 2 }).recordingChannel, 2);
  assert(parseConfig({ maxClipDurationMs: 100 }).maxClipDurationMs >= 1000); // floored
});

Deno.test("consoleRoot strips the /proxy/... integration suffix", () => {
  assertEquals(consoleRoot("https://10.0.0.1/proxy/protect/integration"), "https://10.0.0.1");
  assertEquals(consoleRoot("https://10.0.0.1/proxy/protect/integration/"), "https://10.0.0.1");
});

Deno.test("resolveRecordingPassword reads the file, empty when unset", async () => {
  assertEquals(await resolveRecordingPassword(parseConfig({})), "");
  const tmp = await Deno.makeTempFile();
  await Deno.writeTextFile(tmp, "  s3cret\n");
  try {
    assertEquals(await resolveRecordingPassword(parseConfig({ recordingPasswordFile: tmp })), "s3cret");
  } finally {
    await Deno.remove(tmp);
  }
});
