// Render Claude Code's JSONL session transcript into a readable, append-only text
// log, and locate the transcript file for a session. ZERO external imports.
//
// Why this exists: the terminal capture (term.ts) can only ever reconstruct
// Claude's CURRENT full-screen viewport. `claude --remote-control` is an alt-screen
// TUI that repaints in place (verified against real logs: tens of thousands of
// cursor-homes, ~zero scrolls), so once output scrolls past the viewport it is
// overwritten and unrecoverable — the rendered "log" is only ever the last
// screenful. Claude itself, however, writes a COMPLETE, append-only record of the
// conversation as JSONL under its config dir
// (`$CLAUDE_CONFIG_DIR/projects/<mangled-cwd>/<sessionId>.jsonl`). Rendering that is
// a log that genuinely "continues on" — every prompt, assistant message, and tool
// call across the whole session.
//
// We render the *visible-equivalent* content — user prompts, assistant text, tool
// calls + (truncated) tool results — and skip `thinking` blocks and the bookkeeping
// record types, mirroring what the TUI shows but for the entire session.

// Tool results (command output, file contents) can be huge and are mostly noise for
// a conversation log, so each is capped.
const TOOL_RESULT_MAX_LINES = 40;
const TOOL_RESULT_MAX_CHARS = 4000;
const TOOL_INPUT_MAX_CHARS = 2000;
// Ignore transcripts last modified before the session started (minus a little slack
// for clock skew / spawn latency) so we never bind a session to a stale older one.
const FIND_SLACK_MS = 10_000;

// Right-trim, then cap to maxLines / maxChars, appending a marker when truncated.
function truncate(text: string, maxLines: number, maxChars: number): string {
  let t = text.replace(/\s+$/u, "");
  let cut = false;
  const lines = t.split("\n");
  if (lines.length > maxLines) {
    t = lines.slice(0, maxLines).join("\n");
    cut = true;
  }
  if (t.length > maxChars) {
    t = t.slice(0, maxChars);
    // Don't end on a lone high surrogate (a split astral char) — it would encode to
    // U+FFFD; drop the orphan half.
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
    cut = true;
  }
  return cut ? t.replace(/\s+$/u, "") + "\n    … (truncated — Download for the full log)" : t;
}

// A marked, indented block: the first line carries `marker`, continuations align
// under it. Returns "" for empty content so callers can drop blank blocks.
function block(marker: string, text: string): string {
  const trimmed = text.replace(/\s+$/u, "");
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const pad = " ".repeat(marker.length);
  const head = marker + lines[0];
  const rest = lines.slice(1).map((l) => pad + l);
  return "\n" + [head, ...rest].join("\n") + "\n";
}

// Pure: a one-line (or short) summary of a tool call's input, by tool name.
export function summarizeToolInput(name: string, input: unknown): string {
  const o = (input && typeof input === "object") ? input as Record<string, unknown> : {};
  const s = (v: unknown) => typeof v === "string" ? v : "";
  switch (name) {
    case "Bash":
      return s(o.command);
    case "Read":
    case "Edit":
    case "Write":
      return s(o.file_path);
    case "NotebookEdit":
      return s(o.notebook_path) || s(o.file_path);
    case "Glob":
      return s(o.pattern) + (o.path ? ` (in ${s(o.path)})` : "");
    case "Grep":
      return s(o.pattern) + (o.path ? ` (in ${s(o.path)})` : "");
    case "Task":
      return s(o.description) || s(o.subagent_type);
    case "WebFetch":
      return s(o.url);
    case "WebSearch":
      return s(o.query);
    default: {
      const j = JSON.stringify(o) ?? "";
      return j.length > 200 ? j.slice(0, 200) + "…" : j;
    }
  }
}

// Flatten a tool_result's content (string or an array of content blocks) to text.
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === "object") {
          const bb = b as Record<string, unknown>;
          if (typeof bb.text === "string") return bb.text;
          if (bb.type === "image") return "[image]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Pure: render ONE parsed JSONL record to text (possibly multi-line), or "" to skip
// it (bookkeeping records, thinking blocks, empty content).
export function renderRecord(rec: unknown): string {
  if (!rec || typeof rec !== "object") return "";
  const r = rec as Record<string, unknown>;
  const msg = r.message && typeof r.message === "object" ? r.message as Record<string, unknown> : null;

  if (r.type === "user" && msg) {
    const c = msg.content;
    if (typeof c === "string") return c.trim() ? `\n❯ ${c.trim()}\n` : "";
    if (Array.isArray(c)) {
      let out = "";
      for (const b of c) {
        const bb = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
        if (bb.type === "text" && typeof bb.text === "string" && bb.text.trim()) {
          out += `\n❯ ${bb.text.trim()}\n`;
        } else if (bb.type === "tool_result") {
          const body = truncate(toolResultText(bb.content), TOOL_RESULT_MAX_LINES, TOOL_RESULT_MAX_CHARS);
          const marker = bb.is_error ? "  ⎿ [error] " : "  ⎿ ";
          out += block(marker, body);
        }
      }
      return out;
    }
    return "";
  }

  if (r.type === "assistant" && msg && Array.isArray(msg.content)) {
    let out = "";
    for (const b of msg.content) {
      const bb = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
      if (bb.type === "text" && typeof bb.text === "string" && bb.text.trim()) {
        out += `\n● ${bb.text.trim()}\n`;
      } else if (bb.type === "tool_use") {
        const name = typeof bb.name === "string" ? bb.name : "tool";
        const summary = summarizeToolInput(name, bb.input);
        if (name === "Bash" && summary) {
          out += block("⏵ Bash $ ", truncate(summary, 20, TOOL_INPUT_MAX_CHARS));
        } else {
          const oneLine = summary.split("\n")[0].slice(0, 200);
          out += `\n⏵ ${name}${oneLine ? ": " + oneLine : ""}\n`;
        }
      }
      // thinking blocks are intentionally skipped (the TUI hides them too).
    }
    return out;
  }

  return "";
}

// Pure: render a whole JSONL transcript (one JSON object per line) to text. Parse
// errors (e.g. a partial trailing line mid-write) are skipped, not fatal.
export function renderTranscript(jsonl: string): string {
  let out = "";
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    out += renderRecord(rec);
  }
  // Collapse runs of blank lines and drop leading whitespace for a tidy log.
  return out.replace(/\n{3,}/g, "\n\n").replace(/^\s+/u, "");
}

// Cap how much of a transcript is read+rendered in one go: rendering is synchronous
// CPU (JSON.parse per line), and Deno is single-threaded, so re-rendering a marathon
// session's multi-MB file on every change would stall /healthz, other SSE tails, and
// kills. We read the TAIL (the most recent history) when over the cap; the clipped
// leading partial line is dropped by renderTranscript's per-line parse. Normal
// transcripts are well under this and render in full.
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

// Read up to the last `maxBytes` of a file (its tail). Shared by the transcript and
// terminal-log readers so the seek/fill/close loop lives in one place.
export async function readTail(path: string, maxBytes: number): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    const size = (await file.stat()).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (start > 0) await file.seek(start, Deno.SeekMode.Start);
    const bytes = new Uint8Array(len);
    let off = 0;
    while (off < len) {
      const n = await file.read(bytes.subarray(off));
      if (n === null) break;
      off += n;
    }
    return bytes.subarray(0, off);
  } finally {
    try {
      file.close();
    } catch { /* ignore */ }
  }
}

// Read up to the last MAX_TRANSCRIPT_BYTES of a transcript as text (UTF-8; a lead
// byte clipped by the tail seek decodes to U+FFFD on its line, which is then dropped
// as unparseable — harmless).
export async function readTranscriptText(path: string): Promise<string> {
  return new TextDecoder().decode(await readTail(path, MAX_TRANSCRIPT_BYTES));
}

// Pure: Claude mangles a project's absolute path into a directory name by replacing
// every non-alphanumeric character with "-" (NOT collapsing runs), e.g.
// "/home/u/01 - x" → "-home-u-01---x".
export function mangleProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Locate the transcript file for a session: the most-recently-modified `*.jsonl`
// under `<configDir>/projects/<mangled cwd>` that was touched at/after the session
// started. Returns null when the dir/file doesn't exist yet (a fresh session has no
// transcript until its first turn — callers fall back to the terminal view) or when
// every transcript predates the session. The "newest after startedAt" rule binds a
// session to its own (actively-written) transcript in the common one-session-per-dir
// case; heavy concurrent same-dir use can be disambiguated later via a hook.
export async function findTranscript(
  configDir: string,
  cwd: string,
  startedAtMs: number,
): Promise<string | null> {
  // Claude names the projects dir from its process.cwd(), which getcwd(2) returns
  // already symlink-resolved and trailing-slash-stripped. Mangle the RESOLVED path
  // (best-effort: a non-existent dir just yields null below anyway), or the names
  // diverge for a symlinked/non-canonical preset dir and the transcript is never
  // found.
  let real = cwd;
  try {
    real = await Deno.realPath(cwd);
  } catch { /* keep cwd */ }
  const dir = `${configDir}/projects/${mangleProjectDir(real)}`;
  let best: { path: string; mtime: number } | null = null;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const path = `${dir}/${entry.name}`;
      let mtime = 0;
      try {
        mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      } catch {
        continue;
      }
      if (mtime < startedAtMs - FIND_SLACK_MS) continue;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
  } catch {
    return null; // projects dir not created yet
  }
  return best?.path ?? null;
}
