import { classifyScreen, parseTokens } from "../src/activity.ts";
import { assertEquals } from "./assert.ts";

Deno.test("parseTokens scales k/M suffixes and strips commas", () => {
  assertEquals(parseTokens("7.7", "k"), 7700);
  assertEquals(parseTokens("1.2", "M"), 1200000);
  assertEquals(parseTokens("850", ""), 850);
  assertEquals(parseTokens("12,345", ""), 12345);
  assertEquals(parseTokens("nope", "k"), null);
});

Deno.test("classifyScreen detects 'thinking' via the 'esc to interrupt' line + scrapes tokens", () => {
  const screen = "✻ Architecting… (1m 52s · ↑ 7.7k tokens)\n❯\n  esc to interrupt";
  const c = classifyScreen(screen);
  assertEquals(c.state, "thinking");
  assertEquals(c.tokens, 7700);
});

Deno.test("classifyScreen detects 'ready' from the prompt / auto-mode footer", () => {
  const screen = "✻ Sautéed for 35m\n──── ultracode ─\n❯\n  ⏵⏵ auto mode on (shift+tab to cycle)  /rc active";
  assertEquals(classifyScreen(screen).state, "ready");
});

Deno.test("classifyScreen leaves fields undefined when no markers are present", () => {
  const c = classifyScreen("booting up, nothing rendered yet");
  assertEquals(c.state, undefined);
  assertEquals(c.tokens, undefined);
});

Deno.test("classifyScreen: 'esc to interrupt' wins even when a prompt char is also on screen", () => {
  const screen = "❯ do the thing\n✻ Working… (↑ 1.2k tokens)  esc to interrupt";
  const c = classifyScreen(screen);
  assertEquals(c.state, "thinking");
  assertEquals(c.tokens, 1200);
});
