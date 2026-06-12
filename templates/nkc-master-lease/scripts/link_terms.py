#!/usr/bin/env python3
"""Deterministically wrap defined-term uses in the prose with their \\<key> commands
(which render small caps + a link to the definition). The first occurrence of a term in
document order becomes the \\dtdef{key} anchor; the rest become \\<key> links.

Safe + idempotent: it never touches text already inside a command (\\foo), pre-seeds the
"already defined" set from existing \\dtdef anchors, and ABORTS without writing if expanding
all wrapping back to plain text does not reproduce the original file (a corruption guard).

Run once after transcription:  python scripts/link_terms.py
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import manifest

REPO = os.path.dirname(HERE)
SRC = os.path.join(REPO, "src")

# Option Term keys carry an escaped '#' in their display; leave those literal in prose.
OPTION_KEYS = {"optionI", "optionII", "optionTermI", "optionTermII"}
ALL = dict(manifest.DEFINED_TERMS)
WRAP = sorted(((k, d) for k, d in ALL.items() if k not in OPTION_KEYS),
              key=lambda kd: len(kd[1]), reverse=True)         # longest display first
_KEYS_BY_LEN = sorted(ALL, key=len, reverse=True)


def files_in_order():
    fs = [os.path.join(SRC, "content.tex")]
    for n in manifest.NODES:
        if n["path"] in manifest.GENERATED_CONTENT:
            continue
        p = os.path.join(SRC, n["path"], "content.tex")
        if os.path.exists(p):
            fs.append(p)
    return fs


def normalize(text):
    """Expand every \\dtdef{k}/\\dtuse{k}/\\k back to its display text, for comparison."""
    text = re.sub(r"\\dtdef\{(\w+)\}", lambda m: ALL.get(m.group(1), m.group(0)), text)
    text = re.sub(r"\\dtuse\{(\w+)\}", lambda m: ALL.get(m.group(1), m.group(0)), text)
    text = re.sub(r"\\(" + "|".join(_KEYS_BY_LEN) + r")(?![A-Za-z])",
                  lambda m: ALL.get(m.group(1), m.group(0)), text)
    return text


def main():
    files = files_in_order()
    seen = set()
    for f in files:                                  # pre-seed from existing anchors
        for m in re.finditer(r"\\dtdef\{(\w+)\}", open(f).read()):
            seen.add(m.group(1))

    pending = {}
    for f in files:
        orig = open(f).read()
        out_lines = []
        for line in orig.split("\n"):
            # Never wrap inside a LaTeX comment.
            cm = re.search(r"(?<!\\)%", line)
            code, comment = (line[:cm.start()], line[cm.start():]) if cm else (line, "")
            for key, disp in WRAP:
                pat = re.compile(r"(?<![\\A-Za-z])" + re.escape(disp) + r"(?![A-Za-z])")

                def repl(m, _key=key):
                    if _key in seen:
                        return "\\" + _key
                    seen.add(_key)
                    return "\\dtdef{%s}" % _key

                code = pat.sub(repl, code)
            out_lines.append(code + comment)
        text = "\n".join(out_lines)
        if text != orig:
            if normalize(orig) != normalize(text):
                sys.exit("CORRUPTION GUARD TRIPPED in %s — not writing anything." % f)
            pending[f] = text

    for f, text in pending.items():
        open(f, "w").write(text)

    print("Wrapped defined terms in %d files; %d terms anchored." % (len(pending), len(seen)))
    missing = [k for k in ALL if k not in seen and k not in OPTION_KEYS]
    if missing:
        print("No prose occurrence (so no anchor/link) for:", ", ".join(sorted(missing)))


if __name__ == "__main__":
    main()
