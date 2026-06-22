// Best-effort INTERACTION-state + token scraper for a session, read from its
// captured terminal output. This is a HEURISTIC fallback — it reads Claude Code's
// TUI, which is undocumented and can change — so hooks (when wired) are the source
// of truth and override whatever this infers. Distinct from the process `status`
// (running/exited/…): this is "is the model thinking or waiting for input".
//
// What the `claude --remote-control` TUI shows (observed):
//   - while WORKING:  a "✻ <gerund>… (… · ↑ N tokens)" spinner + the literal
//                     string "esc to interrupt".
//   - when SETTLED:   the "esc to interrupt" line is gone; an "❯" input prompt and
//                     "auto mode on" footer remain.
// "completed" (a turn just finished) isn't distinguishable from "ready" in the
// terminal — only hooks (Stop) can tell them apart — so the scraper emits ready /
// thinking only.
//
// ZERO external imports.

import { TermFilter } from "./term.ts";

export type InteractionState = "ready" | "thinking" | "completed";

// Pure: turn a token number + magnitude suffix ("7.7","k") into a count, or null.
export function parseTokens(num: string, suffix: string): number | null {
  const base = parseFloat(num.replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const mult = /[kK]/.test(suffix) ? 1_000 : /[mM]/.test(suffix) ? 1_000_000 : 1;
  return Math.round(base * mult);
}

// Pure: infer state + token count from a rendered terminal SCREEN (term.ts output).
// Only emits "ready"/"thinking" (see header); leaves fields undefined when unknown
// so a caller never clobbers a known value with a guess.
export function classifyScreen(screen: string): { state?: InteractionState; tokens?: number } {
  const out: { state?: InteractionState; tokens?: number } = {};
  if (/\besc to interrupt\b/.test(screen)) {
    out.state = "thinking";
  } else if (/❯/.test(screen) || /auto mode on/.test(screen)) {
    out.state = "ready";
  }
  // The spinner / status line carries a running token count, e.g. "↑ 7.7k tokens".
  const tok = screen.match(/(\d[\d.,]*)\s*([kKmM]?)\s*tokens\b/);
  if (tok) {
    const n = parseTokens(tok[1], tok[2]);
    if (n !== null) out.tokens = n;
  }
  return out;
}

// Stateful, per-session: feed raw PTY chunks, read .state / .tokens. Re-evaluation
// is throttled (rendering the screen on every chunk would be wasteful under a busy
// session); the first chunk is always evaluated so boot→running is prompt.
const EVAL_INTERVAL_MS = 400;

export class ActivityScraper {
  private term = new TermFilter();
  private lastEval = 0;
  state: InteractionState | undefined;
  tokens: number | undefined;
  started = false;

  // Feed a chunk. Returns true on the FIRST non-empty chunk (the boot→running
  // signal). `now` is injectable for tests.
  push(bytes: Uint8Array, now = Date.now()): boolean {
    const first = !this.started && bytes.length > 0;
    if (bytes.length > 0) this.started = true;
    this.term.push(bytes);
    if (first || now - this.lastEval >= EVAL_INTERVAL_MS) {
      this.lastEval = now;
      this.evaluate();
    }
    return first;
  }

  private evaluate(): void {
    const c = classifyScreen(this.term.render());
    if (c.state) this.state = c.state;
    if (c.tokens !== undefined) this.tokens = c.tokens;
  }
}
