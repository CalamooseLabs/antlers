// Terminal-screen reconstruction for captured session logs. ZERO external imports.
//
// `claude --remote-control` is a full-screen TUI: it runs on the alternate screen
// (CSI ?1049h), positions the cursor absolutely (CSI 24;1H), repaints in place,
// and constantly rewrites the window title (OSC 0) and a spinner. Captured raw off
// the PTY (see sessions.ts `script …`), that byte stream is an unreadable wall of
// escape sequences — and naive ANSI-stripping doesn't help, because the content is
// laid out by cursor positioning (CSI …G / CSI …;…H), so stripping just concatenates
// fragments out of order.
//
// So instead we *interpret* the stream through a small VT/xterm grid emulator and
// render the screen the terminal would actually show — exactly what you'd see
// glancing at the session's terminal. The grid is intentionally oversized and the
// renderer trims trailing blank rows/columns, so we don't need to know the PTY's
// real width/height (claude draws within its own assumed size; our grid contains
// it and trims the slack) — i.e. no terminal-size coupling.
//
// Scope: a pragmatic VT100/xterm subset (cursor movement, erase, scroll region,
// insert/delete line+char, SGR is dropped, OSC/DCS are dropped). Known limitation:
// every code point is treated as one cell wide — wide glyphs (CJK / some emoji)
// can nudge alignment by a column. Good enough for a read-only diagnostic view.

const DEFAULT_ROWS = 120;
const DEFAULT_COLS = 400;

function blankRow(cols: number): string[] {
  return new Array(cols).fill(" ");
}

export class TermScreen {
  readonly rows: number;
  readonly cols: number;
  private grid: string[][];
  private row = 0;
  private col = 0;
  // Deferred autowrap (DECAWM): writing the last column sets this; the *next*
  // printable wraps first. Matches real terminals and keeps line wrapping faithful.
  private wrapPending = false;
  private scrollTop: number;
  private scrollBottom: number;
  private savedRow = 0;
  private savedCol = 0;

  constructor(rows = DEFAULT_ROWS, cols = DEFAULT_COLS) {
    this.rows = rows;
    this.cols = cols;
    this.grid = Array.from({ length: rows }, () => blankRow(cols));
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
  }

  // ---- rendering ----

  // The current screen as text: each row right-trimmed, trailing blank rows dropped.
  render(): string {
    const lines = this.grid.map((r) => r.join("").replace(/\s+$/u, ""));
    let last = lines.length;
    while (last > 0 && lines[last - 1] === "") last--;
    return lines.slice(0, last).join("\n");
  }

  // ---- grid primitives ----

  private clampRow(r: number): number {
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }
  private clampCol(c: number): number {
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private scrollRegionUp(n: number): void {
    for (let k = 0; k < n; k++) {
      this.grid.splice(this.scrollTop, 1);
      this.grid.splice(this.scrollBottom, 0, blankRow(this.cols));
    }
  }

  private scrollRegionDown(n: number): void {
    for (let k = 0; k < n; k++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.scrollTop, 0, blankRow(this.cols));
    }
  }

  // Line feed: down one row; scroll the region up when at the bottom margin.
  private lineFeed(): void {
    if (this.row === this.scrollBottom) this.scrollRegionUp(1);
    else this.row = this.clampRow(this.row + 1);
    this.wrapPending = false;
  }

  // Reverse index (ESC M): up one row; scroll down when at the top margin.
  private reverseIndex(): void {
    if (this.row === this.scrollTop) this.scrollRegionDown(1);
    else this.row = this.clampRow(this.row - 1);
    this.wrapPending = false;
  }

  private putChar(ch: string): void {
    if (this.wrapPending) {
      this.col = 0;
      this.lineFeed();
      this.wrapPending = false;
    }
    this.grid[this.row][this.col] = ch;
    if (this.col === this.cols - 1) this.wrapPending = true;
    else this.col++;
  }

  private eraseCells(r: number, from: number, to: number): void {
    const row = this.grid[r];
    for (let c = from; c <= to && c < this.cols; c++) row[c] = " ";
  }

  reset(): void {
    this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols));
    this.row = 0;
    this.col = 0;
    this.wrapPending = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
  }

  // ---- public byte feed ----
  //
  // Feed a decoded chunk of terminal output. Incomplete trailing escape sequences
  // are buffered by the owning TermFilter (which decodes bytes and stitches
  // chunks); this method assumes `text` is well-formed up to any trailing escape,
  // and returns the index it consumed up to (so the caller can re-feed the rest).
  // Returns text.length when everything was consumed.
  feed(text: string): number {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === "\x1b") {
        const end = this.parseEscape(text, i);
        if (end < 0) return i; // incomplete escape at the tail — buffer it
        i = end;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code === 0x0a) { // LF
        this.lineFeed();
        i++;
      } else if (code === 0x0d) { // CR
        this.col = 0;
        this.wrapPending = false;
        i++;
      } else if (code === 0x08) { // BS
        if (this.col > 0) this.col--;
        this.wrapPending = false;
        i++;
      } else if (code === 0x09) { // HT — next 8-col tab stop
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        this.wrapPending = false;
        i++;
      } else if (code < 0x20 || code === 0x7f) {
        // Other C0 controls (incl. BEL) and DEL: ignore.
        i++;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate: a non-BMP code point (emoji / astral). Keep the pair as
        // ONE glyph in ONE cell so right-margin autowrap never splits it into two
        // lone surrogates on different rows (which UTF-8-encode to U+FFFD garbage).
        if (i + 1 >= n) return i; // incomplete pair at the tail — buffer and retry
        this.putChar(text.slice(i, i + 2));
        i += 2;
      } else {
        // BMP printable (a lone/orphan low surrogate, if any, is written as-is).
        this.putChar(c);
        i++;
      }
    }
    return i;
  }

  // Parse one escape sequence starting at `s[start]` (which is ESC). Returns the
  // index just past the sequence, or -1 if the sequence is incomplete (caller
  // buffers and retries with more input).
  private parseEscape(s: string, start: number): number {
    const n = s.length;
    if (start + 1 >= n) return -1;
    const t = s[start + 1];
    switch (t) {
      case "[":
        return this.parseCSI(s, start);
      case "]":
        return this.parseString(s, start + 2); // OSC — dropped
      case "P": // DCS
      case "X": // SOS
      case "^": // PM
      case "_": // APC
        return this.parseString(s, start + 2); // dropped
      case "(":
      case ")":
      case "*":
      case "+":
      case "-":
      case ".":
      case "/":
        // Designate character set: one more byte (the set id). Ignore it.
        return start + 2 >= n ? -1 : start + 3;
      case "7": // DECSC — save cursor
        this.savedRow = this.row;
        this.savedCol = this.col;
        return start + 2;
      case "8": // DECRC — restore cursor
        this.row = this.clampRow(this.savedRow);
        this.col = this.clampCol(this.savedCol);
        this.wrapPending = false;
        return start + 2;
      case "M": // RI — reverse index
        this.reverseIndex();
        return start + 2;
      case "D": // IND — index (line feed)
        this.lineFeed();
        return start + 2;
      case "E": // NEL — next line
        this.col = 0;
        this.lineFeed();
        return start + 2;
      case "c": // RIS — full reset
        this.reset();
        return start + 2;
      default:
        // ESC =, ESC >, ESC \ (lone ST), and any other 2-byte escape: ignore.
        return start + 2;
    }
  }

  // Consume an OSC/DCS/etc. string: everything up to BEL (\x07) or ST (ESC \).
  // Content is dropped (titles, hyperlinks, palette ops carry nothing for a text
  // view). Returns index past the terminator, or -1 if not yet terminated.
  private parseString(s: string, from: number): number {
    let i = from;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === "\x07") return i + 1; // BEL
      if (c === "\x1b") {
        if (i + 1 >= n) return -1; // maybe ST split across chunks
        if (s[i + 1] === "\\") return i + 2; // ST
        // A stray ESC inside the string that isn't ST — treat as terminator-ish:
        // stop here so a malformed/unterminated OSC can't swallow the rest.
        return i;
      }
      i++;
    }
    return -1; // unterminated — wait for more
  }

  // Parse a CSI sequence: ESC [ , optional private-marker + params/intermediates,
  // then a final byte in 0x40–0x7e. Returns index past the final byte, or -1 if
  // incomplete.
  private parseCSI(s: string, start: number): number {
    let i = start + 2; // skip ESC [
    const n = s.length;
    let priv = "";
    if (i < n && (s[i] === "?" || s[i] === ">" || s[i] === "=" || s[i] === "!")) {
      priv = s[i];
      i++;
    }
    let params = "";
    while (i < n) {
      const code = s.charCodeAt(i);
      if (code >= 0x30 && code <= 0x3f) { // 0-9 : ; < = > ?
        params += s[i];
        i++;
      } else break;
    }
    // Intermediate bytes (0x20–0x2f), e.g. the space in "CSI Ps SP q".
    while (i < n) {
      const code = s.charCodeAt(i);
      if (code >= 0x20 && code <= 0x2f) i++;
      else break;
    }
    if (i >= n) return -1; // no final byte yet
    const final = s[i];
    const fc = final.charCodeAt(0);
    if (fc < 0x40 || fc > 0x7e) {
      // Not a valid CSI final byte (0x40–0x7e). Per ECMA-48 a C0 control must be
      // executed and an ESC aborts the sequence — either way, bail WITHOUT
      // consuming this byte so feed()'s main loop re-handles it (it dispatches ESC
      // and C0 controls correctly). Without this, an LF/ESC sitting where a final
      // byte is expected — common when a CSI is split at a chunk boundary — would
      // be eaten as the "final" byte, silently dropping a real line break.
      return i;
    }
    this.dispatchCSI(priv, params, final);
    return i + 1;
  }

  private dispatchCSI(priv: string, params: string, final: string): void {
    // Private sequences (?, >, =, !) are mode sets / device queries with no effect
    // on the rendered text — alt-screen toggles, cursor visibility, mouse, bracketed
    // paste, soft reset, etc. Ignore them all.
    if (priv) return;

    const parts = params.length ? params.split(";") : [];
    const num = (idx: number, def: number): number => {
      const v = parts[idx];
      if (v === undefined || v === "") return def;
      const p = parseInt(v, 10);
      return Number.isNaN(p) ? def : p;
    };
    const p0 = num(0, 1);

    switch (final) {
      case "A": // CUU — up
        this.row = this.clampRow(this.row - p0);
        this.wrapPending = false;
        break;
      case "B": // CUD — down
        this.row = this.clampRow(this.row + p0);
        this.wrapPending = false;
        break;
      case "C": // CUF — right
        this.col = this.clampCol(this.col + p0);
        this.wrapPending = false;
        break;
      case "D": // CUB — left
        this.col = this.clampCol(this.col - p0);
        this.wrapPending = false;
        break;
      case "E": // CNL — down, col 0
        this.row = this.clampRow(this.row + p0);
        this.col = 0;
        this.wrapPending = false;
        break;
      case "F": // CPL — up, col 0
        this.row = this.clampRow(this.row - p0);
        this.col = 0;
        this.wrapPending = false;
        break;
      case "G": // CHA — absolute column
      case "`": // HPA — same
        this.col = this.clampCol(num(0, 1) - 1);
        this.wrapPending = false;
        break;
      case "d": // VPA — absolute row
        this.row = this.clampRow(num(0, 1) - 1);
        this.wrapPending = false;
        break;
      case "H": // CUP — row;col
      case "f": // HVP — row;col
        this.row = this.clampRow(num(0, 1) - 1);
        this.col = this.clampCol(num(1, 1) - 1);
        this.wrapPending = false;
        break;
      case "J": // ED — erase in display
        this.eraseInDisplay(num(0, 0));
        break;
      case "K": // EL — erase in line
        this.eraseInLine(num(0, 0));
        break;
      case "L": // IL — insert blank lines
        this.insertLines(p0);
        break;
      case "M": // DL — delete lines
        this.deleteLines(p0);
        break;
      case "P": // DCH — delete chars
        this.deleteChars(p0);
        break;
      case "@": // ICH — insert blank chars
        this.insertChars(p0);
        break;
      case "X": // ECH — erase chars
        this.eraseCells(this.row, this.col, this.col + p0 - 1);
        break;
      case "S": // SU — scroll up
        this.scrollRegionUp(p0);
        break;
      case "T": // SD — scroll down
        this.scrollRegionDown(p0);
        break;
      case "r": { // DECSTBM — set scrolling region (1-based, inclusive)
        const top = num(0, 1) - 1;
        const bottom = parts[1] ? num(1, this.rows) - 1 : this.rows - 1;
        if (top < bottom && top >= 0 && bottom < this.rows) {
          this.scrollTop = top;
          this.scrollBottom = bottom;
          this.row = top; // DECSTBM homes the cursor
          this.col = 0;
          this.wrapPending = false;
        }
        break;
      }
      case "s": // SCOSC — save cursor (ANSI.SYS variant)
        this.savedRow = this.row;
        this.savedCol = this.col;
        break;
      case "u": // SCORC — restore cursor
        this.row = this.clampRow(this.savedRow);
        this.col = this.clampCol(this.savedCol);
        this.wrapPending = false;
        break;
      // SGR ("m"), device queries, window ops ("t"), etc.: no text effect, ignore.
      default:
        break;
    }
  }

  private eraseInDisplay(mode: number): void {
    if (mode === 0) {
      // Cursor to end of screen.
      this.eraseCells(this.row, this.col, this.cols - 1);
      for (let r = this.row + 1; r < this.rows; r++) this.eraseCells(r, 0, this.cols - 1);
    } else if (mode === 1) {
      // Start of screen to cursor.
      for (let r = 0; r < this.row; r++) this.eraseCells(r, 0, this.cols - 1);
      this.eraseCells(this.row, 0, this.col);
    } else {
      // 2 / 3 — whole screen.
      for (let r = 0; r < this.rows; r++) this.eraseCells(r, 0, this.cols - 1);
    }
  }

  private eraseInLine(mode: number): void {
    if (mode === 0) this.eraseCells(this.row, this.col, this.cols - 1);
    else if (mode === 1) this.eraseCells(this.row, 0, this.col);
    else this.eraseCells(this.row, 0, this.cols - 1);
  }

  private insertLines(n: number): void {
    if (this.row < this.scrollTop || this.row > this.scrollBottom) return;
    for (let k = 0; k < n; k++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.row, 0, blankRow(this.cols));
    }
  }

  private deleteLines(n: number): void {
    if (this.row < this.scrollTop || this.row > this.scrollBottom) return;
    for (let k = 0; k < n; k++) {
      this.grid.splice(this.row, 1);
      this.grid.splice(this.scrollBottom, 0, blankRow(this.cols));
    }
  }

  private insertChars(n: number): void {
    const row = this.grid[this.row];
    for (let k = 0; k < n; k++) {
      row.splice(this.col, 0, " ");
      row.pop();
    }
  }

  private deleteChars(n: number): void {
    const row = this.grid[this.row];
    for (let k = 0; k < n; k++) {
      row.splice(this.col, 1);
      row.push(" ");
    }
  }
}

// Streaming wrapper: decodes raw PTY bytes (UTF-8, chunk-boundary safe) and feeds
// the screen, buffering any incomplete trailing escape sequence between pushes.
export class TermFilter {
  private screen: TermScreen;
  private decoder = new TextDecoder();
  private pending = ""; // undecoded-into-screen tail (an incomplete escape)

  constructor(rows?: number, cols?: number) {
    this.screen = new TermScreen(rows, cols);
  }

  push(bytes: Uint8Array): void {
    const text = this.pending + this.decoder.decode(bytes, { stream: true });
    const consumed = this.screen.feed(text);
    this.pending = consumed < text.length ? text.slice(consumed) : "";
    // Guard against an unbounded buffer if a malformed sequence never terminates.
    if (this.pending.length > 1 << 16) {
      // deno-lint-ignore no-control-regex -- stripping a stuck ESC is intentional.
      this.screen.feed(this.pending.replace(/\x1b/g, ""));
      this.pending = "";
    }
  }

  render(): string {
    return this.screen.render();
  }
}

// One-shot: render a whole captured raw log into the screen text it represents.
export function renderLog(bytes: Uint8Array): string {
  const f = new TermFilter();
  f.push(bytes);
  return f.render();
}
