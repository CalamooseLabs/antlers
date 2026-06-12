"""One-time scaffolder: materialize the full src/ node tree from manifest.py.

Writes (deterministically) every node's main.tex + variables.tex, the structural
content.tex of parent nodes, the computed Exhibit B/D tables, and the root
variables.tex. Leaf prose content.tex files are seeded with a TODO placeholder
(+ their \\label) and are NEVER overwritten if they already contain real prose, so
re-running is safe and prose transcription is preserved.

Run from the repo root:  python scripts/scaffold.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import manifest
import render

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "src")

TODO_MARK = "% TODO-PROSE"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def is_placeholder(path):
    if not os.path.exists(path):
        return True
    with open(path) as f:
        return TODO_MARK in f.read()


def main():
    todo = []
    for node in manifest.NODES:
        node_dir = os.path.join(SRC, node["path"])
        os.makedirs(node_dir, exist_ok=True)

        # main.tex + variables.tex are fully deterministic — always (re)write.
        write(os.path.join(node_dir, "main.tex"), render.render_main(node))
        write(os.path.join(node_dir, "variables.tex"), render.render_node_variables(node, include=True))

        content_path = os.path.join(node_dir, "content.tex")
        kids = manifest.children_of(node["path"])

        if kids:
            # Parent node: body is its children (+ optional lead-in / blankspace).
            parts = []
            if node["ref"]:
                # Cross-reference target: \label must follow the heading (emitted by main.tex).
                parts.append("\\label{%s}\n" % node["ref"])
            if node["htype"] in ("section", "subsection") or node["header_only"]:
                parts.append("\\blankspace\n")
            if node["lead_in"]:
                parts.append("%s (lead-in paragraph) — %s\n" % (TODO_MARK, node["label"]))
                todo.append(node["path"] + "  (lead-in + children)")
            parts.append(render.child_subimports(node))
            # Don't clobber a hand-edited lead-in once written.
            if node["lead_in"] and not is_placeholder(content_path):
                pass
            else:
                write(content_path, "".join(parts))
        elif node["path"] in manifest.GENERATED_CONTENT:
            # Computed exhibit tables — render from default inputs.
            defaults = {i["name"]: i["default"] for i in manifest.INPUTS}
            if node["path"] == "exhibit_b":
                write(content_path, render.render_exhibit_b_content(defaults))
            elif node["path"] == "exhibit_d":
                write(content_path, render.render_exhibit_d_content(defaults))
        else:
            # Leaf prose node — seed a placeholder only if not yet transcribed.
            if is_placeholder(content_path):
                seed = "%s: %s  [%s]\n" % (TODO_MARK, node["label"], node["path"])
                if node["ref"]:
                    seed += "\\label{%s}\n" % node["ref"]
                write(content_path, seed)
                todo.append(node["path"] + ("  (label %s)" % node["ref"] if node["ref"] else ""))

    # Root variables.tex from defaults (wizard regenerates later) + the defined-terms file.
    defaults = {i["name"]: i["default"] for i in manifest.INPUTS}
    write(os.path.join(SRC, "variables.tex"), render.render_root_variables(defaults))
    write(os.path.join(SRC, "defined_terms.tex"), render.render_defined_terms())

    print("Scaffolded %d nodes under src/." % len(manifest.NODES))
    print("Leaf/lead-in content.tex still needing prose (%d):" % len(todo))
    for t in todo:
        print("  -", t)


if __name__ == "__main__":
    main()
