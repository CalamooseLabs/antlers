import { buildFfmpegArgs, codecStringFromProbe } from "../server/stream.ts";
import { assert, assertStringIncludes } from "./assert.ts";

Deno.test("buildFfmpegArgs remuxes RTSPS to fragmented mp4; audio only when present", () => {
  const withAudio = buildFfmpegArgs("rtsps://10.0.0.1:7441/tok?enableSrtp", true).join(" ");
  assertStringIncludes(withAudio, "-rtsp_transport tcp");
  assertStringIncludes(withAudio, "rtsps://10.0.0.1:7441/tok?enableSrtp");
  assertStringIncludes(withAudio, "-c:v copy"); // no re-encode
  assertStringIncludes(withAudio, "-c:a aac"); // MSE needs AAC
  assertStringIncludes(withAudio, "frag_keyframe");
  assertStringIncludes(withAudio, "empty_moov");

  const noAudio = buildFfmpegArgs("rtsps://10.0.0.1:7441/tok?enableSrtp", false).join(" ");
  assertStringIncludes(noAudio, "-an"); // drop audio when the source has none
  assert(!noAudio.includes("-c:a aac"));

  const args = buildFfmpegArgs("rtsps://x", true);
  assert(args[args.length - 1] === "pipe:1");
});

Deno.test("codecStringFromProbe maps H.264 High@4.1 to avc1.640029 and advertises audio only when present", () => {
  const mime = codecStringFromProbe("h264", "High", 41, true);
  assertStringIncludes(mime, "video/mp4");
  assertStringIncludes(mime, "avc1.640029");
  assertStringIncludes(mime, "mp4a.40.2");
  // No audio track -> no mp4a in the advertised mime (else MSE stalls waiting for it).
  assert(!codecStringFromProbe("h264", "High", 41, false).includes("mp4a"));
});

Deno.test("codecStringFromProbe maps Main profile and default level", () => {
  assertStringIncludes(codecStringFromProbe("h264", "Main", undefined, true), "avc1.4d4029");
});

Deno.test("codecStringFromProbe uses hvc1 for HEVC and a safe H.264 default otherwise", () => {
  assertStringIncludes(codecStringFromProbe("hevc", "Main", 120, true), "hvc1");
  assertStringIncludes(codecStringFromProbe(undefined, undefined, undefined, true), "avc1.4d4029");
});
