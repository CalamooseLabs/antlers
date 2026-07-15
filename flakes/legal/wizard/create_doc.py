#!/usr/bin/env python3
"""create-doc — interactive wizard that fills a The Company, Inc. legal document and builds
the PDF. It reads the template's own `scripts/manifest.py` (INPUTS + optional NODES tree +
optional DEFINED_TERMS), so one engine drives every `thecompanyinc-*` template.

You type simple values — a number (6), a date (05/01/2026), a one-line US address, a dollar
figure (1000000) or a percent (27.5) — and the tool spells them out in proper legal form.
It then lets you toggle which sections to include (where the doc has a node tree),
regenerates only the value-bearing LaTeX, saves your answers to doc.json, and runs nix build.

  create-doc                 # NEW instance (firm fields prefill from settings.json; the rest blank)
  create-doc --edit          # edit the existing doc.json — same prompts, prefilled (= edit-doc)
  create-doc --no-build      # regenerate the .tex but skip nix build
  create-doc --defaults      # non-interactive: regenerate from doc.json / settings.json / defaults
  create-doc --save-settings # write the firm fields to settings.json and exit
  create-doc --scaffold      # (authoring) (re)generate every node's main.tex + content stubs
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render_core as render  # noqa: E402


def find_repo_root():
    d = os.getcwd()
    while True:
        if os.path.exists(os.path.join(d, "flake.nix")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return os.getcwd()
        d = parent


REPO = find_repo_root()
SRC = os.path.join(REPO, "src")
STATE_PATH = os.path.join(REPO, "doc.json")          # per-instance answers (git-ignored)
SETTINGS_PATH = os.path.join(REPO, "settings.json")  # firm-wide default overrides

# Load the template's manifest from its scripts/ dir.
sys.path.insert(0, os.path.join(REPO, "scripts"))
import manifest  # noqa: E402

TITLE = getattr(manifest, "TITLE", "Legal Document")
INPUTS = getattr(manifest, "INPUTS", [])
NODES = getattr(manifest, "NODES", [])
DEFINED_TERMS = getattr(manifest, "DEFINED_TERMS", {})
SUMMARY_FIELDS = getattr(manifest, "SUMMARY_FIELDS", None)

NUM_KINDS = {"floor", "count", "sqft", "years", "money", "money_simple", "percent", "percent_legal"}


# --------------------------------------------------------------------- state / settings
def load_state():
    if os.path.exists(STATE_PATH):
        try:
            s = json.load(open(STATE_PATH))
            s.setdefault("inputs", {})
            s.setdefault("includes", {})
            return s
        except Exception:
            pass
    return {"inputs": {}, "includes": {}}


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def load_settings():
    if os.path.exists(SETTINGS_PATH):
        try:
            return json.load(open(SETTINGS_PATH))
        except Exception:
            pass
    return {}


def seed_settings_if_missing():
    if os.path.exists(SETTINGS_PATH):
        return False
    firm = {i["name"]: i["default"] for i in INPUTS if i.get("firm")}
    if not firm:
        return False
    with open(SETTINGS_PATH, "w") as f:
        json.dump(firm, f, indent=2)
    return True


def save_settings(inputs):
    firm = {i["name"]: inputs.get(i["name"], i["default"]) for i in INPUTS if i.get("firm")}
    with open(SETTINGS_PATH, "w") as f:
        json.dump(firm, f, indent=2)


def effective_default(name, state, settings):
    """Prefill precedence: this instance's prior answer > firm settings > manifest default."""
    if name in state.get("inputs", {}):
        return state["inputs"][name]
    if name in settings:
        return settings[name]
    return next((i["default"] for i in INPUTS if i["name"] == name), "")


def merged_inputs(state):
    inp = {i["name"]: i["default"] for i in INPUTS}
    inp.update(load_settings())
    inp.update(state.get("inputs", {}))
    return inp


# ------------------------------------------------------------------------- generation
def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def _extra_commands(inp):
    fn = getattr(manifest, "extra_commands", None)
    return fn(inp) if callable(fn) else None


def generate(state):
    inp = merged_inputs(state)
    includes = state.get("includes", {})
    _write(os.path.join(SRC, "variables.tex"),
           render.render_root_variables(inp, INPUTS, _extra_commands(inp)))
    _write(os.path.join(SRC, "defined_terms.tex"), render.render_defined_terms(DEFINED_TERMS))
    for node in NODES:
        _write(os.path.join(SRC, node["path"], "variables.tex"),
               render.render_node_variables(node, include=includes.get(node["boolean"], True)))
    gen = getattr(manifest, "render_generated", None)
    if callable(gen):
        for relpath, text in (gen(inp) or {}).items():
            _write(os.path.join(SRC, relpath), text)


def scaffold():
    """Author-time: (re)generate every node's main.tex + structural content, and drop an empty
    leaf content.tex stub (guarded by a TODO marker) where prose hasn't been written yet."""
    for node in NODES:
        d = os.path.join(SRC, node["path"])
        _write(os.path.join(d, "main.tex"), render.render_main(node))
        _write(os.path.join(d, "variables.tex"), render.render_node_variables(node, True))
        kids = render.child_subimports(NODES, node)
        content = os.path.join(d, "content.tex")
        existing = open(content).read() if os.path.exists(content) else ""
        if kids and "% TODO-PROSE" not in existing and not existing.strip():
            _write(content, kids)  # structural parent: just the child subimports
        elif not os.path.exists(content):
            _write(content, "%% TODO-PROSE: write the prose for %s here.\n%s" % (node["path"], kids))
    print("Scaffolded %d nodes under src/." % len(NODES))


def build():
    print("\nBuilding the PDF (nix build) …")
    r = subprocess.run(["nix", "build"], cwd=REPO)
    pdf = os.path.join(REPO, "result", "main.pdf")
    if r.returncode == 0 and os.path.exists(pdf):
        print("\n  PDF built: %s" % pdf)
        try:
            subprocess.Popen(["xdg-open", pdf], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            print("  (open it manually — no viewer on PATH)")
        return True
    print("\n  Build failed (exit %d). Run `nix build` to see the LaTeX errors." % r.returncode)
    return False


# ------------------------------------------------------------------------------- misc
def coerce(kind, value):
    value = str(value).strip()
    if not value:
        return 0 if kind in NUM_KINDS else value
    if kind in ("floor", "count", "sqft", "years"):
        return int(round(float(value)))
    if kind in ("money", "money_simple", "percent", "percent_legal"):
        return float(value)
    return value


def validator(kind):
    def _v(text):
        text = text.strip()
        if kind in NUM_KINDS:
            try:
                float(text)
                return True
            except ValueError:
                return "Enter a number (e.g. 6, 27.5, 1000000)."
        if kind == "date":
            if text and render.parse_date(text) is None:
                return "Use MM/DD/YYYY."
        return True
    return _v


def top_component(path):
    return path.split("/")[0]


def top_level_nodes():
    return [n for n in NODES if "/" not in n["path"]]


# ----------------------------------------------------------------------------- wizard
def run_wizard(state, edit=False):
    import questionary
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table

    console = Console()
    title = ("%s — edit existing instance" % TITLE) if edit else ("%s — interactive setup" % TITLE)
    subtitle = ("every prompt is prefilled from doc.json — Enter keeps, type to change" if edit
                else "numbers/dates/addresses are auto-formatted; answers saved to doc.json")
    console.print(Panel.fit(title, subtitle=subtitle, style="bold cyan"))

    settings = load_settings()
    inputs = dict(state.get("inputs", {}))
    prompt_of = {i["name"]: i["prompt"] for i in INPUTS}
    last_group = None
    for spec in INPUTS:
        grp = spec.get("group", "")
        if grp != last_group:
            console.rule("[bold]%s" % grp)
            last_group = grp
        name, kind = spec["name"], spec.get("kind", "text")

        ref = spec.get("same_as")
        if ref and str(inputs.get(ref, "")).strip():
            q = questionary.confirm("%s — same as %s (%s)?"
                                    % (spec["prompt"], prompt_of.get(ref, ref), inputs[ref]),
                                    default=True).ask()
            if q is None:
                raise KeyboardInterrupt
            if q:
                inputs[name] = inputs[ref]
                continue

        current = effective_default(name, state, settings)
        if kind == "choice":
            ans = questionary.select(spec["prompt"], choices=spec["choices"],
                                     default=current if current in spec["choices"] else spec["choices"][0]).ask()
            if ans is None:
                raise KeyboardInterrupt
            inputs[name] = ans
        elif kind == "address":
            while True:
                ans = questionary.text(spec["prompt"] + " (street, suite, city, ST zip)",
                                       default=str(current)).ask()
                if ans is None:
                    raise KeyboardInterrupt
                if not ans.strip():
                    inputs[name] = ""
                    break
                p = render.parse_us_address(ans)
                console.print("  parsed → [cyan]street[/cyan] %s | [cyan]city[/cyan] %s | "
                              "[cyan]state[/cyan] %s | [cyan]zip[/cyan] %s"
                              % (p["street"] or "—", p["city"] or "—", p["state"] or "—", p["zip"] or "—"))
                ok = questionary.confirm("  Parsed correctly?", default=True).ask()
                if ok is None:
                    raise KeyboardInterrupt
                if ok:
                    inputs[name] = ans
                    break
                current = ans
        else:
            ans = questionary.text(spec["prompt"], default=str(current),
                                   validate=validator(kind)).ask()
            if ans is None:
                raise KeyboardInterrupt
            inputs[name] = coerce(kind, ans)

    # ---- Section toggles (only where the doc has a node tree) ----
    includes = dict(state.get("includes", {}))
    tops = top_level_nodes()
    if tops:
        console.rule("[bold]Sections to include")
        console.print("Unchecked items render as [italic]“Intentionally Deleted”[/italic] "
                      "(or are omitted) with numbering preserved.")
        prev = state.get("includes", {})

        def was_included(b):
            return prev.get(b, True)

        def top_title(n):
            if n["htype"] == "exhibit":
                return "Exhibit %s — %s" % (n.get("letter", "?"), n["label"])
            if n["htype"] == "schedule":
                return "Schedule %s — %s" % (n.get("letter", "?"), n["label"])
            return n["label"]

        kept_tops = questionary.checkbox(
            "Parts to INCLUDE (↑↓ move, space toggles, enter confirms):",
            choices=[questionary.Choice(title=top_title(n), value=n["path"], checked=was_included(n["boolean"]))
                     for n in tops]).ask()
        if kept_tops is None:
            raise KeyboardInterrupt
        kept_tops = set(kept_tops)

        sub_nodes = [n for n in NODES if "/" in n["path"] and top_component(n["path"]) in kept_tops]
        kept_subs = set(n["path"] for n in sub_nodes)
        if sub_nodes and questionary.confirm("Fine-tune individual sections within the kept parts?",
                                             default=False).ask():
            picked = questionary.checkbox(
                "Sections / subsections to INCLUDE:",
                choices=[questionary.Choice(
                    title="  " * n["path"].count("/") + n["label"],
                    value=n["path"], checked=was_included(n["boolean"])) for n in sub_nodes]).ask()
            if picked is None:
                raise KeyboardInterrupt
            kept_subs = set(picked)

        includes = {}
        for n in NODES:
            if "/" not in n["path"]:
                includes[n["boolean"]] = n["path"] in kept_tops
            else:
                includes[n["boolean"]] = top_component(n["path"]) in kept_tops and n["path"] in kept_subs

    # ---- Summary preview ----
    g = render.derive(inputs, INPUTS)
    if _extra_commands(inputs):
        g.update(_extra_commands(inputs))
    table = Table(title="Summary — formatted output", show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Renders as")
    preview = SUMMARY_FIELDS or [(i["prompt"], render.command_of(i)) for i in INPUTS[:8]]
    for label, key in preview:
        table.add_row(label, g.get(key, ""))
    if NODES:
        table.add_row("Sections excluded", str(sum(1 for n in NODES if not includes.get(n["boolean"], True))))
    console.print(table)

    if any(i.get("firm") for i in INPUTS) and questionary.confirm(
            "Save the firm fields as your defaults in settings.json?", default=False).ask():
        save_settings(inputs)
        console.print("[green]Updated settings.json.[/green]")

    proceed = questionary.confirm("Generate the LaTeX and build the PDF?", default=True).ask()
    state["inputs"] = inputs
    state["includes"] = includes
    return state, bool(proceed)


# ------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Fill a The Company, Inc. legal document and build the PDF.")
    ap.add_argument("--edit", action="store_true", help="edit the existing doc.json (prefilled prompts)")
    ap.add_argument("--defaults", action="store_true", help="non-interactive: regenerate from doc.json / defaults")
    ap.add_argument("--no-build", action="store_true", help="regenerate the .tex but skip nix build")
    ap.add_argument("--save-settings", action="store_true", help="write firm fields to settings.json and exit")
    ap.add_argument("--scaffold", action="store_true", help="(authoring) (re)generate node main.tex + stubs")
    args = ap.parse_args()

    if args.scaffold:
        scaffold()
        return 0

    if seed_settings_if_missing():
        print("Created settings.json (firm defaults) — edit it to set standing info.")

    if args.edit and not os.path.exists(STATE_PATH):
        print("No doc.json found — nothing to edit yet. Run `create-doc` to start a new instance.")
        return 1

    state = load_state()
    if args.save_settings:
        save_settings(merged_inputs(state))
        print("Wrote firm defaults to settings.json.")
        return 0

    proceed = True
    if not args.defaults:
        if not args.edit:
            if os.path.exists(STATE_PATH):
                try:
                    import questionary
                    ok = questionary.confirm(
                        "A doc.json already exists. Start a NEW instance and overwrite it?",
                        default=False).ask()
                except (KeyboardInterrupt, EOFError):
                    ok = None
                if not ok:
                    print("Cancelled — to modify the existing instance, run `edit-doc`.")
                    return 1
            state = {"inputs": {}, "includes": {}}
        try:
            state, proceed = run_wizard(state, edit=args.edit)
        except (KeyboardInterrupt, EOFError):
            print("\nCancelled — no files changed.")
            return 1

    save_state(state)
    generate(state)
    print("Regenerated src/variables.tex, defined_terms.tex%s."
          % (", and %d node booleans" % len(NODES) if NODES else ""))

    if proceed and not args.no_build:
        build()
    elif args.no_build:
        print("Skipped build (--no-build). Run `nix build` when ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
