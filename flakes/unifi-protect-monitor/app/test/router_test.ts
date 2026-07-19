import { handle, type ServerContext } from "../server/router.ts";
import { parseConfig } from "../server/config.ts";
import { Camera } from "../server/protect.ts";
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";

function makeCtx(authEnabled: boolean, authed: boolean, cameras: Camera[]): ServerContext {
  const auth = {
    enabled: authEnabled,
    // Mirror AuthGate: when the gate is disabled every request is authed.
    isAuthed: (_req: Request) => Promise.resolve(!authEnabled || authed),
    login: (_req: Request) => Promise.resolve(new Response(null, { status: 204 })),
    logout: () => new Response(null, { status: 204 }),
  };
  return {
    cfg: parseConfig({}),
    client: {} as unknown,
    streams: {} as unknown,
    events: {} as unknown,
    auth,
    getCameras: () => Promise.resolve(cameras),
  } as unknown as ServerContext;
}

const CAM: Camera = { id: "c1", name: "Front", state: "CONNECTED", isMicEnabled: true, hasPackageCamera: false, hasMic: true, hasSpeaker: false };

Deno.test("GET /healthz returns ok", async () => {
  const res = await handle(new Request("http://x/healthz"), makeCtx(false, false, []));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
});

Deno.test("GET / serves the dark SPA when passwordless", async () => {
  const res = await handle(new Request("http://x/"), makeCtx(false, false, []));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
});

Deno.test("GET /api/cameras returns cameras + defaults", async () => {
  const res = await handle(new Request("http://x/api/cameras"), makeCtx(false, false, [CAM]));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.cameras.length, 1);
  assertEquals(body.defaults.defaultQuality, "medium");
});

Deno.test("unknown path 404s", async () => {
  const res = await handle(new Request("http://x/nope"), makeCtx(false, false, []));
  assertEquals(res.status, 404);
});

Deno.test("auth gate: unauthenticated page redirects, api 401s", async () => {
  const ctx = makeCtx(true, false, [CAM]);
  const page = await handle(new Request("http://x/"), ctx);
  assertEquals(page.status, 302);
  assertEquals(page.headers.get("location"), "/login");
  const api = await handle(new Request("http://x/api/cameras"), ctx);
  assertEquals(api.status, 401);
});

Deno.test("auth gate: authenticated request passes", async () => {
  const res = await handle(new Request("http://x/"), makeCtx(true, true, [CAM]));
  assertEquals(res.status, 200);
  assert(true);
});
