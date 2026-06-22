import { normResetsAt, parseUsage } from "../src/usage.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("parseUsage extracts windows in canonical order with ISO reset times", () => {
  // Intentionally out of order in the input — output must follow WINDOW_DEFS order.
  const raw = JSON.stringify({
    seven_day: { utilization: 41, resets_at: "2026-06-28T00:00:00Z" },
    five_hour: { utilization: 12.5, resets_at: "2026-06-21T18:00:00Z" },
    seven_day_sonnet: { utilization: 3, resets_at: "2026-06-28T00:00:00Z" },
  });
  const snap = parseUsage(raw);
  assert(snap !== null);
  assertEquals(snap.windows.map((w) => w.key), ["five_hour", "seven_day", "seven_day_sonnet"]);
  assertEquals(snap.windows[0].label, "Session (5h)");
  assertEquals(snap.windows[0].utilization, 12.5);
  assertEquals(snap.windows[0].resetsAt, Date.parse("2026-06-21T18:00:00Z"));
});

Deno.test("parseUsage skips null/absent windows (e.g. opus when not applicable)", () => {
  const snap = parseUsage(JSON.stringify({
    five_hour: { utilization: 5, resets_at: "2026-06-21T18:00:00Z" },
    seven_day_opus: null,
  }));
  assert(snap !== null);
  assertEquals(snap.windows.map((w) => w.key), ["five_hour"]);
});

Deno.test("parseUsage clamps utilization to 0-100", () => {
  const snap = parseUsage(JSON.stringify({
    five_hour: { utilization: 142, resets_at: "2026-06-21T18:00:00Z" },
    seven_day: { utilization: -3, resets_at: "2026-06-28T00:00:00Z" },
  }));
  assert(snap !== null);
  assertEquals(snap.windows[0].utilization, 100);
  assertEquals(snap.windows[1].utilization, 0);
});

Deno.test("parseUsage accepts the statusline shape (used_percentage + epoch seconds)", () => {
  const snap = parseUsage(JSON.stringify({
    five_hour: { used_percentage: 20, resets_at: 1781000000 }, // seconds
  }));
  assert(snap !== null);
  assertEquals(snap.windows[0].utilization, 20);
  assertEquals(snap.windows[0].resetsAt, 1781000000 * 1000);
});

Deno.test("parseUsage includes extra_usage only when enabled with a number", () => {
  const on = parseUsage(JSON.stringify({
    five_hour: { utilization: 1, resets_at: "2026-06-21T18:00:00Z" },
    extra_usage: { is_enabled: true, utilization: 33 },
  }));
  assert(on !== null);
  assertEquals(on.extraEnabled, true);
  assertEquals(on.windows.map((w) => w.key), ["five_hour", "extra_usage"]);

  const off = parseUsage(JSON.stringify({
    five_hour: { utilization: 1, resets_at: "2026-06-21T18:00:00Z" },
    extra_usage: { is_enabled: false, utilization: 33 },
  }));
  assert(off !== null);
  assertEquals(off.extraEnabled, false);
  assertEquals(off.windows.map((w) => w.key), ["five_hour"]);
});

Deno.test("parseUsage tolerates a missing reset timestamp (resetsAt null)", () => {
  const snap = parseUsage(JSON.stringify({ five_hour: { utilization: 7 } }));
  assert(snap !== null);
  assertEquals(snap.windows[0].resetsAt, null);
});

Deno.test("parseUsage recovers from surrounding noise via the brace fallback", () => {
  const snap = parseUsage('warning: deprecated\n{"five_hour":{"utilization":9,"resets_at":"2026-06-21T18:00:00Z"}}\n');
  assert(snap !== null);
  assertEquals(snap.windows[0].utilization, 9);
});

Deno.test("parseUsage returns null for non-object / unparseable bodies", () => {
  assertEquals(parseUsage("not json at all"), null);
  assertEquals(parseUsage("[1,2,3]"), null);
  assertEquals(parseUsage("42"), null);
});

Deno.test("parseUsage returns an empty window list for an object with no known windows", () => {
  const snap = parseUsage(JSON.stringify({ unrelated: true }));
  assert(snap !== null);
  assertEquals(snap.windows, []);
});

Deno.test("normResetsAt distinguishes epoch seconds, ms, and ISO strings", () => {
  assertEquals(normResetsAt(1781000000), 1781000000 * 1000); // seconds -> ms
  assertEquals(normResetsAt(1781000000000), 1781000000000); // already ms
  assertEquals(normResetsAt("2026-06-21T18:00:00Z"), Date.parse("2026-06-21T18:00:00Z"));
  assertEquals(normResetsAt("not a date"), null);
  assertEquals(normResetsAt(null), null);
  assertEquals(normResetsAt(undefined), null);
});
