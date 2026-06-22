// Commit-message suggestion for the web "Commit & Push" modal. Two sources, in
// order of preference:
//
//   1. The gcommit scratchpad. The in-session Claude Code writes a normal,
//      human-style message to a gitignored `GIT_COMMIT_MSG` file at the repo root
//      (the same file the `gcommit` CLI reads and signs `-F`). If one exists we
//      offer it verbatim — exactly what gcommit would commit. Always read; cheap.
//   2. A model draft. With no scratchpad, and only when commitPush.generateMessage
//      is on, draft a message from the combined diff via a one-shot `claude -p`
//      (claude.ts). Costs tokens, so it is gated and best-effort.
//
// The result is only a SUGGESTION pre-filled into the modal; the human edits and
// authorizes the actual signed commit. ZERO external imports.

import type { ServerConfig } from "./config.ts";
import { gitDiffMulti } from "./diff.ts";
import { generateCommitMessage } from "./claude.ts";

// The gcommit convention: the message scratchpad at the repo root.
export const SCRATCHPAD_FILE = "GIT_COMMIT_MSG";
const MAX_SCRATCHPAD_BYTES = 64 * 1024; // mirror the commit-message cap

export interface MessageSuggestion {
  message: string;
  source: "scratchpad" | "generated" | "none";
}

// Pure: normalize a scratchpad/file body into a usable message (CRLF → LF, trim).
export function cleanSuggestion(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

// Pure: stitch the per-directory diffs of dirs that actually changed into one
// blob for the generator, each labeled by its path. Empty / non-repo dirs drop out.
export function joinDiffsForPrompt(
  dirs: Array<{ path: string; isRepo: boolean; empty: boolean; diff: string }>,
): string {
  return dirs
    .filter((d) => d.isRepo && !d.empty && d.diff.trim().length > 0)
    .map((d) => `# ${d.path}\n${d.diff}`)
    .join("\n\n")
    .trim();
}

// Read the first non-empty GIT_COMMIT_MSG across the session's directories (the
// primary/cwd is first, so it wins). Read-only and bounded; a missing/oversized/
// unreadable file just falls through to the next dir.
async function readScratchpad(dirs: string[]): Promise<string> {
  for (const dir of dirs) {
    try {
      const path = `${dir}/${SCRATCHPAD_FILE}`;
      const st = await Deno.stat(path);
      if (!st.isFile || st.size === 0 || st.size > MAX_SCRATCHPAD_BYTES) continue;
      const raw = await Deno.readTextFile(path);
      if (raw.includes("\x00")) continue; // binary content — not a commit message
      const text = cleanSuggestion(raw);
      if (text) return text;
    } catch {
      // missing / permission / not-a-file — try the next directory
    }
  }
  return "";
}

export async function suggestCommitMessage(config: ServerConfig, dirs: string[]): Promise<MessageSuggestion> {
  // 1) The gcommit scratchpad — exactly what gcommit would commit.
  const scratch = await readScratchpad(dirs);
  if (scratch) return { message: scratch, source: "scratchpad" };

  // 2) Draft from the diff, if enabled.
  if (config.commitPush.generateMessage) {
    const md = await gitDiffMulti(dirs);
    const diffText = joinDiffsForPrompt(md.dirs);
    if (diffText) {
      const gen = await generateCommitMessage(config, diffText);
      if (gen) return { message: gen, source: "generated" };
    }
  }

  return { message: "", source: "none" };
}
