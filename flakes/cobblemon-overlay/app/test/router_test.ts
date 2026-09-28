// Router tests: the /effects auth split through the REAL handler with an
// injected socket peer — multichat-facing routes are loopback-only (+ the
// Bearer effects token when set), mod-facing routes use the ingest token rule
// and are not loopback-gated, and EVERY /effects route refuses a browser page
// (Origin / cross-site Sec-Fetch-Site) — plus the peer default, the new page
// routes, and /ingest (unknown event names acked + ignored, never a 400
// wedge). Also the util.ts gates.

import { DEFAULTS } from "../src/config.ts";
import { EffectQueue } from "../src/effects.ts";
import { type Deps, handler } from "../src/router.ts";
import { SpriteStore } from "../src/sprites.ts";
import { OverlayState } from "../src/state.ts";
import { checkToken, isBrowserCrossOrigin, isLoopbackIp } from "../src/util.ts";
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";

interface HubSpy {
  states: unknown[];
  games: Record<string, unknown>[];
  connect(): Response;
  broadcastState(v: unknown): void;
  broadcastGame(v: unknown): void;
}

function mkHub(): HubSpy {
  const spy: HubSpy = {
    states: [],
    games: [],
    connect() {
      return new Response("");
    },
    broadcastState(v) {
      spy.states.push(v);
    },
    broadcastGame(v) {
      spy.games.push(v as Record<string, unknown>);
    },
  };
  return spy;
}

function mkDeps(opts: { token?: string; effectsToken?: string } = {}): Deps & { hub: HubSpy } {
  return {
    config: { ...DEFAULTS, stateDir: "" },
    state: new OverlayState({ stateDir: "", eventLogSize: 10, staleAfterSec: 15, persistDebounceMs: 50 }),
    hub: mkHub(),
    sprites: new SpriteStore(""),
    effects: new EffectQueue({
      stateDir: "",
      enabled: true,
      leaseSec: 30,
      ttlSec: 600,
      acceptWindowSec: 45,
      maxOpen: 100,
    }),
    token: opts.token ?? "",
    effectsToken: opts.effectsToken ?? "",
  };
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://overlay.test${path}`, init);
}

const ENQ = { id: "r-1", effect: "about_face", viewer: "Alice", reward: "About Face" };
const LAN = "10.10.10.30";

// Every multichat-facing route, as [method, path, body].
const MULTICHAT_ROUTES: [string, string, unknown][] = [
  ["POST", "/effects", ENQ],
  ["GET", "/effects?ids=r-1", undefined],
  ["POST", "/effects/r-1/cancel", undefined],
  ["GET", "/effects/health", undefined],
];

Deno.test("isLoopbackIp: IPv4 loopback block, ::1, v4-mapped; nothing else", () => {
  for (const ip of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]) assert(isLoopbackIp(ip), ip);
  for (const ip of ["", "10.10.10.30", "0.0.0.0", "::", "::ffff:10.0.0.1", "fe80::1", "1127.0.0.1"]) {
    assert(!isLoopbackIp(ip), `must not be loopback: ${JSON.stringify(ip)}`);
  }
});

Deno.test("checkToken: open when unset; Bearer or X-Overlay-Token; bearerOnly refuses the header", () => {
  const r = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  assert(checkToken(r({}), ""), "no token configured = open");
  assert(!checkToken(r({}), "s3cret"));
  assert(checkToken(r({ authorization: "Bearer s3cret" }), "s3cret"));
  assert(checkToken(r({ authorization: "bearer   s3cret  " }), "s3cret"), "scheme case-insensitive, trimmed");
  assert(checkToken(r({ "x-overlay-token": "s3cret" }), "s3cret"));
  assert(!checkToken(r({ authorization: "Bearer nope" }), "s3cret"));
  assert(!checkToken(r({ "x-overlay-token": "s3cret" }), "s3cret", { bearerOnly: true }));
  assert(checkToken(r({ authorization: "Bearer s3cret" }), "s3cret", { bearerOnly: true }));
});

Deno.test("isBrowserCrossOrigin: any Origin, or a Sec-Fetch-Site other than none/same-origin", () => {
  const r = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  assert(!isBrowserCrossOrigin(r({})), "Deno fetch / Java HttpClient / curl send neither");
  assert(!isBrowserCrossOrigin(r({ "sec-fetch-site": "none" })), "typed in the address bar");
  assert(!isBrowserCrossOrigin(r({ "sec-fetch-site": "same-origin" })));
  assert(!isBrowserCrossOrigin(r({ "sec-fetch-site": " Same-Origin " })), "case/whitespace tolerant");
  for (const site of ["cross-site", "same-site", "", "bogus"]) {
    assert(isBrowserCrossOrigin(r({ "sec-fetch-site": site })), `sec-fetch-site ${JSON.stringify(site)}`);
  }
  for (const origin of ["https://evil.example", "http://127.0.0.1:8082", "null", ""]) {
    assert(isBrowserCrossOrigin(r({ origin })), `origin ${JSON.stringify(origin)} (even same-origin: Origin = a page)`);
    assert(isBrowserCrossOrigin(r({ origin, "sec-fetch-site": "same-origin" })));
  }
});

Deno.test("every /effects route refuses a browser page with 403 forbidden — before auth, body, or method", async () => {
  const deps = mkDeps({ token: "ingest-tok", effectsToken: "fx-tok" });
  type Route = [string, string, unknown, Record<string, string>, string]; // method, path, body, auth, peer
  const routes: Route[] = [
    ...MULTICHAT_ROUTES.map(([m, p, b]): Route => [m, p, b, { authorization: "Bearer fx-tok" }, "127.0.0.1"]),
    ["POST", "/effects/claim", { ready: true }, { authorization: "Bearer ingest-tok" }, LAN],
    ["POST", "/effects/r-1/result", { status: "applied" }, { authorization: "Bearer ingest-tok" }, LAN],
    ["PUT", "/effects", undefined, {}, "127.0.0.1"], // (would be a 405)
    ["GET", "/effects/nope/x/y", undefined, {}, LAN], // (would be a 404)
  ];
  const browser: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "http://127.0.0.1:8082", "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ];
  for (const [method, path, body, auth, peer] of routes) {
    for (const extra of browser) {
      const res = await handler(req(method, path, body, { ...auth, ...extra }), deps, peer);
      assertEquals(res.status, 403, `${method} ${path} ${JSON.stringify(extra)}`);
      assertEquals(await res.json(), { ok: false, reason: "forbidden" });
      assertEquals(res.headers.get("cache-control"), "no-store");
    }
  }
  assertEquals(deps.hub.games.length, 0, "a refused request never reaches the queue");
  // a typed-in / same-origin GET without Origin still works; callers send neither header
  for (const site of ["none", "same-origin"]) {
    const ok = await handler(
      req("GET", "/effects/health", undefined, { authorization: "Bearer fx-tok", "sec-fetch-site": site }),
      deps,
      "127.0.0.1",
    );
    assertEquals(ok.status, 200, site);
    await ok.body?.cancel();
  }
  const mod = await handler(req("POST", "/effects/claim", { ready: false }, { authorization: "Bearer ingest-tok" }), deps, LAN);
  assertEquals(mod.status, 200);
  await mod.body?.cancel();
});

Deno.test("multichat-facing effect routes: non-loopback peers get 403 forbidden (also the unknown-peer default)", async () => {
  const deps = mkDeps();
  for (const [method, path, body] of MULTICHAT_ROUTES) {
    for (const peer of [LAN, "192.168.1.9", "::ffff:10.0.0.1", ""]) {
      const res = await handler(req(method, path, body), deps, peer);
      assertEquals(res.status, 403, `${method} ${path} from ${JSON.stringify(peer)}`);
      assertEquals(await res.json(), { ok: false, reason: "forbidden" });
    }
    const dflt = await handler(req(method, path, body), deps); // peerIp omitted
    assertEquals(dflt.status, 403, "no peer threaded in = not loopback");
    await dflt.body?.cancel();
  }
  assertEquals(deps.hub.games.length, 0, "a refused request never reaches the queue");
});

Deno.test("multichat-facing effect routes: every loopback form is allowed (tokenless)", async () => {
  const deps = mkDeps();
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const res = await handler(req("GET", "/effects/health"), deps, peer);
    assertEquals(res.status, 200, peer);
    assertEquals(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.accepting, false, "no mod poll yet");
  }
});

Deno.test("effectsToken: loopback ALSO needs Bearer <effectsToken>; the ingest token / X-Overlay-Token don't do", async () => {
  const deps = mkDeps({ token: "ingest-tok", effectsToken: "fx-tok" });
  for (const [method, path, body] of MULTICHAT_ROUTES) {
    for (
      const headers of [
        {},
        { authorization: "Bearer ingest-tok" },
        { authorization: "Bearer nope" },
        { "x-overlay-token": "fx-tok" },
      ] as Record<string, string>[]
    ) {
      const res = await handler(req(method, path, body, headers), deps, "127.0.0.1");
      assertEquals(res.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
      assertEquals(await res.json(), { ok: false, reason: "unauthorized" });
    }
  }
  const ok = await handler(req("GET", "/effects/health", undefined, { authorization: "Bearer fx-tok" }), deps, "::1");
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
  // the right token from a non-loopback peer is still refused
  const lan = await handler(req("GET", "/effects/health", undefined, { authorization: "Bearer fx-tok" }), deps, LAN);
  assertEquals(lan.status, 403);
  await lan.body?.cancel();
});

Deno.test("mod-facing routes: NOT loopback-gated; the ingest token rule (Bearer or X-Overlay-Token)", async () => {
  const deps = mkDeps({ token: "ingest-tok", effectsToken: "fx-tok" });
  for (const headers of [{}, { authorization: "Bearer fx-tok" }, { "x-overlay-token": "nope" }] as Record<string, string>[]) {
    const res = await handler(req("POST", "/effects/claim", { ready: true }, headers), deps, LAN);
    assertEquals(res.status, 401, `claim ${JSON.stringify(headers)}`);
    assertEquals(await res.json(), { ok: false, reason: "unauthorized" });
    const r2 = await handler(req("POST", "/effects/r-1/result", { status: "applied" }, headers), deps, LAN);
    assertEquals(r2.status, 401, `result ${JSON.stringify(headers)}`);
    await r2.body?.cancel();
  }
  const claim = await handler(
    req("POST", "/effects/claim", { ready: true, max: 3 }, { authorization: "Bearer ingest-tok" }),
    deps,
    LAN,
  );
  assertEquals(claim.status, 200);
  assertEquals(await claim.json(), { ok: true, effects: [], cancels: [] });
  const viaHeader = await handler(
    req("POST", "/effects/claim", { ready: true }, { "x-overlay-token": "ingest-tok" }),
    deps,
    LAN,
  );
  assertEquals(viaHeader.status, 200);
  await viaHeader.body?.cancel();

  // tokenless deployment (the deployed /32-pinned config): open from the LAN
  const open = mkDeps();
  const res = await handler(req("POST", "/effects/claim", { ready: false }), open, LAN);
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("end to end through the router: multichat enqueue (loopback) → mod claim + result (LAN) → lookup", async () => {
  const deps = mkDeps({ token: "ingest-tok", effectsToken: "fx-tok" });
  const mod = { authorization: "Bearer ingest-tok" };
  const mc = { authorization: "Bearer fx-tok" };
  await handler(req("POST", "/effects/claim", { ready: false }, mod), deps, LAN).then((r) => r.body?.cancel());

  const enq = await handler(req("POST", "/effects", ENQ, mc), deps, "127.0.0.1");
  assertEquals(enq.status, 202);
  await enq.body?.cancel();
  assertEquals(deps.hub.games.map((g) => g.event), ["redeem"]);

  const claim = await handler(req("POST", "/effects/claim", { ready: true }, mod), deps, LAN);
  const cj = await claim.json();
  assertEquals(cj.effects.map((e: { id: string }) => e.id), ["r-1"]);

  const res = await handler(req("POST", "/effects/r-1/result", { status: "applied", detail: "Spun around" }, mod), deps, LAN);
  assertEquals(await res.json(), { ok: true, status: "applied" });
  assertEquals(deps.hub.games.map((g) => g.event), ["redeem", "effect_result"]);

  const look = await handler(req("GET", "/effects?ids=r-1", undefined, mc), deps, "127.0.0.1");
  const lj = await look.json();
  assertEquals(lj.effects[0].status, "applied");
  assertEquals(lj.effects[0].detail, "Spun around");
});

Deno.test("/ingest: reachable from the LAN peer; an unknown event name is acked + ignored, never a 400 wedge", async () => {
  const deps = mkDeps();
  const res = await handler(
    req("POST", "/ingest", { v: 1, type: "snapshot", session: "s", seq: 1, t: 1, player: "Cole" }),
    deps,
    LAN,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(deps.hub.states.length, 1);
  // protocol v1 gains no event names: a `redeem` pushed through /ingest is NOT
  // a memo — it is acked (so the mod's pusher moves on) and applied nowhere
  const odd = await handler(
    req("POST", "/ingest", { v: 1, type: "event", session: "s", seq: 2, t: 1, event: "redeem", viewer: "x" }),
    deps,
    LAN,
  );
  assertEquals(odd.status, 200);
  assertEquals(await odd.json(), { ok: true, ignored: true });
  assertEquals(deps.hub.games.length, 0, "nothing broadcast");
  assertEquals(deps.hub.states.length, 1, "nothing applied");
  const v2 = { v: 2, type: "event", session: "s", seq: 3, t: 1, event: "x" };
  const bad = await handler(req("POST", "/ingest", v2), deps, LAN);
  assertEquals(bad.status, 400, "a bad envelope is still a 400");
  await bad.body?.cancel();
});

Deno.test("pages: /overlay/redeems served no-store, listed on /, effects section on /status", async () => {
  const deps = mkDeps({ effectsToken: "fx-tok" });
  const page = await handler(req("GET", "/overlay/redeems"), deps, LAN);
  assertEquals(page.status, 200);
  assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(page.headers.get("cache-control"), "no-store");
  assertStringIncludes(await page.text(), "EventSource('/events')");

  const index = await handler(req("GET", "/"), deps, LAN);
  assertStringIncludes(await index.text(), `<a href="/overlay/redeems">/overlay/redeems</a>`);

  const status = await handler(req("GET", "/status"), deps, LAN);
  const html = await status.text();
  assertStringIncludes(html, "<h2>channel-point effects</h2>");
  assertStringIncludes(html, "NOT accepting (mod not polling)");
  assertStringIncludes(html, "loopback + token");
});
