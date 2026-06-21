// Terminal-emulator tests. ZERO external imports (offline; uses ./assert.ts).
// They feed raw byte streams (as a real PTY would) through TermFilter/TermScreen
// and assert the rendered screen — i.e. what the session's terminal would show.

import { renderLog, TermFilter, TermScreen } from "../src/term.ts";
import { assert, assertEquals } from "./assert.ts";

const ESC = "\x1b";
const te = new TextEncoder();

// Feed a whole string through a fresh filter (optionally custom-sized) and render.
function feed(s: string, rows?: number, cols?: number): string {
  const f = new TermFilter(rows, cols);
  f.push(te.encode(s));
  return f.render();
}

// Feed several chunks separately (to exercise chunk-boundary buffering). Chunks may
// be strings or raw byte arrays (for split-UTF-8 cases).
function feedChunks(parts: Array<string | Uint8Array>, rows?: number, cols?: number): string {
  const f = new TermFilter(rows, cols);
  for (const p of parts) f.push(typeof p === "string" ? te.encode(p) : p);
  return f.render();
}

Deno.test("plain text renders; trailing blank rows/cols trimmed", () => {
  assertEquals(feed("hello world"), "hello world");
  assertEquals(feed("a\r\nb\r\nc"), "a\nb\nc");
  // A fresh screen is empty.
  assertEquals(feed(""), "");
  // Trailing spaces on a line are trimmed.
  assertEquals(feed("hi   "), "hi");
});

Deno.test("SGR color codes are dropped, text preserved", () => {
  assertEquals(feed(`${ESC}[31mred${ESC}[0m`), "red");
  assertEquals(feed(`${ESC}[1m${ESC}[38;5;246mx${ESC}[39m${ESC}[22m`), "x");
});

Deno.test("OSC window-title sequences are dropped (BEL and ST terminated)", () => {
  assertEquals(feed(`${ESC}]0;✳ Claude Code${"\x07"}hello`), "hello");
  assertEquals(feed(`${ESC}]0;title${ESC}\\world`), "world");
});

Deno.test("OSC-8 hyperlink wrapper dropped, visible text kept", () => {
  assertEquals(feed(`${ESC}]8;;http://x.test/p${"\x07"}link${ESC}]8;;${"\x07"}`), "link");
});

Deno.test("carriage return overwrites within the line", () => {
  assertEquals(feed("abc\rX"), "Xbc");
  assertEquals(feed("hello\rHEY"), "HEYlo");
});

Deno.test("CHA (absolute column) lays text out by position — the core fix", () => {
  // ✶ at col0, "um" at col4-5, "ox" at col7-8 — exactly the kind of column
  // positioning a naive ANSI-strip would mangle into "✶umox".
  assertEquals(feed(`${ESC}[38;5;174m✶${ESC}[5Gum${ESC}[8Gox`), "✶   um ox");
  assertEquals(feed(`abcdef${ESC}[2GX`), "aXcdef");
});

Deno.test("cursor forward/back movement", () => {
  assertEquals(feed(`a${ESC}[3Cb`), "a   b"); // CUF 3 -> col 4
  assertEquals(feed(`abcdef${ESC}[3D${ESC}[K`), "abc"); // back 3, erase to EOL
});

Deno.test("backspace and tab", () => {
  assertEquals(feed("abc\b\bX"), "aXc");
  assertEquals(feed("a\tb"), "a" + " ".repeat(7) + "b"); // tab to col 8
});

Deno.test("absolute cursor positioning into the grid (CUP)", () => {
  // Row 2, col 3 (1-based) -> blank first row, "  X" on the second.
  assertEquals(feed(`${ESC}[2;3HX`, 4, 20), "\n  X");
});

Deno.test("erase-in-line modes", () => {
  assertEquals(feed(`abcdef${ESC}[3G${ESC}[K`), "ab"); // 0: cursor..end of line
  assertEquals(feed(`abcdef${ESC}[4G${ESC}[1Gx`, 2, 20), "xbcdef"); // CHA back to col0, overwrite
  // 1: blank start..cursor (cols 0..3), cursor stays at col3, then x overwrites col3.
  assertEquals(feed(`abcdef${ESC}[4G${ESC}[1Kx`), "   xef");
});

Deno.test("erase-in-display clears the screen", () => {
  assertEquals(feed(`line1\r\nline2${ESC}[2J`, 5, 20), "");
});

Deno.test("LF at the bottom margin scrolls content off the top", () => {
  // 2-row screen: line1 scrolls away, leaving line2/line3.
  assertEquals(feed("line1\r\nline2\r\nline3", 2, 20), "line2\nline3");
});

Deno.test("autowrap at the right margin (deferred)", () => {
  // 3-col screen: "abcd" -> "abc" then wrap "d" onto the next row.
  assertEquals(feed("abcd", 4, 3), "abc\nd");
  // Writing exactly to the last column does NOT wrap until the next char.
  assertEquals(feed("abc", 4, 3), "abc");
});

Deno.test("DECSTBM scroll region: a fixed bottom status line survives scrolling", () => {
  const s = new TermScreen(4, 20);
  // Draw a status bar on the last row, then confine scrolling to rows 1-3.
  s.feed(`${ESC}[4;1Hstatus`); // row 4
  s.feed(`${ESC}[1;3r`); // scroll region = rows 1..3 (homes cursor to row1)
  s.feed("a\r\nb\r\nc\r\nd"); // fills region, scrolls 'a' off, region now b/c/d
  const out = s.render();
  assert(out.includes("status"), "status bar must persist outside the scroll region");
  assert(!out.includes("a\n") && !out.startsWith("a"), "first region line should have scrolled off");
  assert(out.includes("d"), "newest region line present");
});

Deno.test("insert / delete characters", () => {
  assertEquals(feed(`abc${ESC}[1G${ESC}[2@`), "  abc"); // ICH 2 at col0
  assertEquals(feed(`abcdef${ESC}[1G${ESC}[2P`), "cdef"); // DCH 2 at col0
});

Deno.test("RIS (ESC c) fully resets the screen", () => {
  assertEquals(feed(`junk${ESC}c`), "");
});

Deno.test("private mode sets (alt-screen, cursor vis, mouse, bracketed paste) are no-ops", () => {
  const noise =
    `${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1002h${ESC}[?2004h${ESC}[?2031hHI${ESC}[?25h${ESC}[?1049l`;
  assertEquals(feed(noise), "HI");
});

Deno.test("a C0 control / ESC where a CSI final byte is expected aborts the CSI, not eats the byte", () => {
  // An incomplete CSI ("ESC[1") followed by a control or a new ESC: the control/ESC
  // must still take effect, not be swallowed as the sequence's final byte.
  assertEquals(feed(`A${ESC}[1\nB`), "A\n B"); // LF preserved (bare LF keeps column)
  assertEquals(feed(`${ESC}[1${ESC}[2GX`), " X"); // 2nd CSI (CHA col 2) honored, X at col1
  // The realistic case: a CSI split at a chunk tail, then a real line break.
  assertEquals(feedChunks([`line1${ESC}[`, "\nline2"]), "line1\n     line2");
});

Deno.test("astral code points (emoji) are not split by autowrap", () => {
  const emoji = "\u{1F600}"; // 😀 — a surrogate pair (two UTF-16 units)
  // High surrogate lands in the last column: the whole glyph stays in that cell.
  assertEquals(feed(`ab${emoji}`, 4, 3), `ab${emoji}`);
  // Would-overflow: the whole glyph wraps to the next row (never split in half).
  assertEquals(feed(`abc${emoji}`, 4, 3), `abc\n${emoji}`);
});

Deno.test("escape sequence split across chunk boundaries", () => {
  assertEquals(feedChunks([`${ESC}[31`, "mABC"]), "ABC"); // SGR split
  assertEquals(feedChunks([`${ESC}]0;ti`, `tle${"\x07"}X`]), "X"); // OSC split
  assertEquals(feedChunks([`AB${ESC}`, "[1GZ"]), "ZB"); // CSI split right after ESC
});

Deno.test("UTF-8 multibyte split across chunk boundaries", () => {
  // "é" = 0xC3 0xA9; split the codepoint between the two pushes.
  assertEquals(feedChunks([new Uint8Array([0x41, 0xc3]), new Uint8Array([0xa9, 0x42])]), "AéB");
  assertEquals(feedChunks([new Uint8Array([0xc3]), new Uint8Array([0xa9])]), "é");
});

Deno.test("a realistic noisy TUI frame renders to clean text", () => {
  // Title spam + cursor save/hide + SGR + a CR-redrawn spinner, then a content line.
  const frame = [
    `${ESC}[?25l${ESC}7`,
    `${ESC}]0;⠂ Fix homelab host static IP configuration${"\x07"}`,
    `${ESC}[38;5;246m●${ESC}[39m a step\r\n`,
    `${ESC}[38;5;153mhomelab/vms.nix${ESC}[39m edited`,
    `${ESC}8${ESC}[?25h`,
  ].join("");
  const out = feed(frame, 10, 80);
  assert(!out.includes(ESC), "no raw escape bytes in rendered output");
  assert(!out.includes("[?25"), "no leftover private-mode sequences");
  assert(!out.includes("]0;"), "no leftover OSC title");
  assert(out.includes("homelab/vms.nix edited"), `content line missing: ${JSON.stringify(out)}`);
});

Deno.test("renderLog one-shot matches streamed pushes", () => {
  const raw = te.encode(`${ESC}[2;1Hhello${ESC}[3;1Hworld`);
  assertEquals(renderLog(raw), feed(`${ESC}[2;1Hhello${ESC}[3;1Hworld`, 120, 400));
});

Deno.test("a long unterminated escape is bounded, not buffered forever", () => {
  // 100k bytes of an OSC that never terminates: must not hang or OOM; the guard
  // flushes it (stripping ESC) so the trailing real text still shows.
  const f = new TermFilter(10, 80);
  f.push(te.encode(`${ESC}]0;` + "x".repeat(100_000)));
  f.push(te.encode("DONE"));
  const out = f.render();
  assert(out.includes("DONE"), `expected DONE after a flushed runaway sequence: ${JSON.stringify(out.slice(-40))}`);
});
