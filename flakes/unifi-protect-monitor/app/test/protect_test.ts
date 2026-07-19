import { ProtectClient } from "../server/protect.ts";
import { assert, assertEquals } from "./assert.ts";

const BASE = "https://10.0.0.1/proxy/protect/integration";

// Install a fetch stub; returns a restore fn.
function stubFetch(handler: (url: string, method: string, body: string | null) => Response): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    return Promise.resolve(handler(url, method, body));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

Deno.test("listCameras maps raw fields (name fallback, featureFlags)", async () => {
  const restore = stubFetch((url) => {
    assert(url.endsWith("/v1/cameras"));
    return new Response(
      JSON.stringify([
        { id: "cam1", name: "Front Door", state: "CONNECTED", isMicEnabled: true, hasPackageCamera: false, featureFlags: { hasMic: true, hasSpeaker: false } },
        { id: "cam2", name: null, state: "DISCONNECTED", featureFlags: {} },
      ]),
      { headers: { "content-type": "application/json" } },
    );
  });
  try {
    const c = new ProtectClient(BASE, "key");
    const cams = await c.listCameras();
    assertEquals(cams.length, 2);
    assertEquals(cams[0], { id: "cam1", name: "Front Door", state: "CONNECTED", isMicEnabled: true, hasPackageCamera: false, hasMic: true, hasSpeaker: false });
    assertEquals(cams[1].name, "cam2"); // null name -> id
    assertEquals(cams[1].hasMic, false);
  } finally {
    restore();
  }
});

Deno.test("ensureRtspsUrl creates streams when GET returns null, then caches", async () => {
  let gets = 0, posts = 0;
  const restore = stubFetch((url, method) => {
    if (url.endsWith("/rtsps-stream") && method === "GET") {
      gets++;
      return new Response(JSON.stringify({ high: null, medium: null, low: null, package: null }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/rtsps-stream") && method === "POST") {
      posts++;
      return new Response(JSON.stringify({ high: "rtsps://10.0.0.1:7441/tok?enableSrtp", medium: "rtsps://10.0.0.1:7441/med?enableSrtp" }), { headers: { "content-type": "application/json" } });
    }
    return new Response("no", { status: 404 });
  });
  try {
    const c = new ProtectClient(BASE, "key");
    const url1 = await c.ensureRtspsUrl("cam1", "high", ["high", "medium", "low"]);
    assertEquals(url1, "rtsps://10.0.0.1:7441/tok?enableSrtp");
    assertEquals(gets, 1);
    assertEquals(posts, 1);
    // Cached: no further GET/POST.
    const url2 = await c.ensureRtspsUrl("cam1", "high", ["high", "medium", "low"]);
    assertEquals(url2, url1);
    assertEquals(gets, 1);
    assertEquals(posts, 1);
  } finally {
    restore();
  }
});

Deno.test("getSnapshot returns bytes + content type", async () => {
  const restore = stubFetch((url) => {
    assert(url.includes("/snapshot?"));
    assert(url.includes("channel=main"));
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  });
  try {
    const c = new ProtectClient(BASE, "key");
    const { bytes, contentType } = await c.getSnapshot("cam1", { highQuality: true });
    assertEquals(contentType, "image/jpeg");
    assertEquals(bytes.length, 3);
  } finally {
    restore();
  }
});
