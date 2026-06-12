#!/usr/bin/env python3
"""create-lease — interactive wizard that fills the master lease and builds the PDF.

You type simple values — a number (4000), a date (01/01/2025), a one-line US address,
a dollar figure (2000) or a percent (3) — and the tool spells them out in proper legal
form (e.g. "Two Thousand and 00/100 dollars ($2,000.00)", "first (1st)", "January 1, 2025").
It then lets you toggle which sections to include (at every level), regenerates only the
value-bearing LaTeX, saves your answers to lease.json, and runs `nix build`.

  create-lease                 # interactive
  create-lease --no-build      # regenerate the .tex but skip the build
  create-lease --defaults      # non-interactive: regenerate from lease.json / defaults
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import manifest          # noqa: E402
import render            # noqa: E402


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
STATE_PATH = os.path.join(REPO, "lease.json")        # per-deal answers (git-ignored)
SETTINGS_PATH = os.path.join(REPO, "settings.json")  # firm-wide default overrides

NUM_KINDS = {"floor", "count", "sqft", "money", "money_simple", "percent", "percent_legal"}


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
    """Create settings.json from the firm-constant inputs so it's there to edit."""
    if os.path.exists(SETTINGS_PATH):
        return False
    firm = {i["name"]: i["default"] for i in manifest.INPUTS if i.get("firm")}
    with open(SETTINGS_PATH, "w") as f:
        json.dump(firm, f, indent=2)
    return True


def save_settings(inputs):
    """Persist the current firm-field values as the firm defaults."""
    firm = {i["name"]: inputs.get(i["name"], i["default"])
            for i in manifest.INPUTS if i.get("firm")}
    with open(SETTINGS_PATH, "w") as f:
        json.dump(firm, f, indent=2)


def effective_default(name, state, settings):
    """Prefill precedence: this deal's prior answer > firm settings > manifest default."""
    if name in state.get("inputs", {}):
        return state["inputs"][name]
    if name in settings:
        return settings[name]
    return next((i["default"] for i in manifest.INPUTS if i["name"] == name), "")


def merged_inputs(state):
    inp = {i["name"]: i["default"] for i in manifest.INPUTS}
    inp.update(load_settings())
    inp.update(state.get("inputs", {}))
    return inp


# ------------------------------------------------------------------------- generation
def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def generate(state):
    inp = merged_inputs(state)
    includes = state.get("includes", {})
    _write(os.path.join(SRC, "variables.tex"), render.render_root_variables(inp))
    _write(os.path.join(SRC, "defined_terms.tex"), render.render_defined_terms())
    for node in manifest.NODES:
        _write(os.path.join(SRC, node["path"], "variables.tex"),
               render.render_node_variables(node, include=includes.get(node["boolean"], True)))
    _write(os.path.join(SRC, "exhibit_b", "content.tex"), render.render_exhibit_b_content(inp))
    _write(os.path.join(SRC, "exhibit_d", "content.tex"), render.render_exhibit_d_content(inp))


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
    if kind in ("floor", "count", "sqft"):
        return int(round(float(value)))
    if kind in ("money", "money_simple", "percent", "percent_legal"):
        return float(value)
    return value


def validator(kind):
    def _v(text):
        text = text.strip()
        if kind in ("floor", "count", "sqft", "money", "money_simple", "percent", "percent_legal"):
            try:
                float(text)
                return True
            except ValueError:
                return "Enter a number (e.g. 4000, 20.00, 3)."
        if kind == "date":
            if text and render._parse_date(text) is None:
                return "Use MM/DD/YYYY."
        return True
    return _v


def section_number(node):
    return node["boolean"][len("include"):].replace("_", ".")


def top_component(path):
    return path.split("/")[0]


# ----------------------------------------------------------------------------- wizard
def run_wizard(state):
    import questionary
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table

    console = Console()
    console.print(Panel.fit("Commercial Master Lease — interactive setup",
                            subtitle="numbers/dates/addresses are auto-formatted; answers saved to lease.json",
                            style="bold cyan"))

    settings = load_settings()
    inputs = dict(state.get("inputs", {}))
    prompt_of = {i["name"]: i["prompt"] for i in manifest.INPUTS}
    last_group = None
    for spec in manifest.INPUTS:
        if spec["group"] != last_group:
            console.rule("[bold]%s" % spec["group"])
            last_group = spec["group"]
        name, kind = spec["name"], spec["kind"]

        # Offer to reuse a previously-entered field (e.g. notice address = principal).
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
                console.print("  parsed → [cyan]street[/cyan] %s | [cyan]suite[/cyan] %s | "
                              "[cyan]city[/cyan] %s | [cyan]state[/cyan] %s | [cyan]zip[/cyan] %s"
                              % (p["street"] or "—", p["suite"] or "—", p["city"] or "—",
                                 p["state"] or "—", p["zip"] or "—"))
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

    # ---- Section toggles (top-level, then optional fine-tune) ----
    console.rule("[bold]Sections to include")
    console.print("Unchecked items render as [italic]“Intentionally Deleted”[/italic] (numbering preserved).")
    prev = state.get("includes", {})

    def was_included(b):
        return prev.get(b, True)

    def top_title(n):
        if n["htype"] == "article":
            return "Article %s — %s" % (n["boolean"][len("include"):], n["label"])
        if n["htype"] == "exhibit":
            return "Exhibit %s — %s" % (n["letter"], n["label"])
        return n["label"]

    tops = manifest.top_level_nodes()
    kept_tops = questionary.checkbox(
        "Parts to INCLUDE (↑↓ move, space toggles, enter confirms):",
        choices=[questionary.Choice(title=top_title(n), value=n["path"], checked=was_included(n["boolean"]))
                 for n in tops]).ask()
    if kept_tops is None:
        raise KeyboardInterrupt
    kept_tops = set(kept_tops)

    sub_nodes = [n for n in manifest.NODES if "/" in n["path"] and top_component(n["path"]) in kept_tops]
    kept_subs = set(n["path"] for n in sub_nodes)
    if sub_nodes and questionary.confirm("Fine-tune individual sections within the kept parts?",
                                         default=False).ask():
        picked = questionary.checkbox(
            "Sections / subsections to INCLUDE:",
            choices=[questionary.Choice(
                title="  " * n["path"].count("/") + section_number(n) + "  " + n["label"],
                value=n["path"], checked=was_included(n["boolean"])) for n in sub_nodes]).ask()
        if picked is None:
            raise KeyboardInterrupt
        kept_subs = set(picked)

    includes = {}
    for n in manifest.NODES:
        if "/" not in n["path"]:
            includes[n["boolean"]] = n["path"] in kept_tops
        else:
            includes[n["boolean"]] = top_component(n["path"]) in kept_tops and n["path"] in kept_subs

    # ---- Summary (show a few formatted previews) ----
    g = render.derive(inputs)
    table = Table(title="Summary — formatted output", show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Renders as")
    for label, key in [("Lessor", "lessorName"), ("Lessee", "lesseeName"),
                       ("Premises RSF", "premisesRSF"), ("Floor", "premisesFloorText"),
                       ("Effective date", "effectiveDateText"), ("Term", "termYearsText"),
                       ("Base rent/SF", "baseRentPerSFText"), ("Increase", "baseRentIncreasePctText"),
                       ("Lessee's %", "lesseesPercentageText")]:
        table.add_row(label, g.get(key, ""))
    excluded = [n for n in manifest.NODES if not includes.get(n["boolean"], True)]
    table.add_row("Sections excluded", str(len(excluded)))
    console.print(table)

    if questionary.confirm("Save the firm fields (Lessor block, counsel, governing law) as your "
                           "defaults in settings.json?", default=False).ask():
        save_settings(inputs)
        console.print("[green]Updated settings.json.[/green]")

    proceed = questionary.confirm("Generate the LaTeX and build the PDF?", default=True).ask()
    state["inputs"] = inputs
    state["includes"] = includes
    return state, bool(proceed)


# ------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Fill the master lease and build the PDF.")
    ap.add_argument("--defaults", action="store_true",
                    help="non-interactive: regenerate from lease.json / manifest defaults")
    ap.add_argument("--no-build", action="store_true", help="regenerate the .tex but skip nix build")
    ap.add_argument("--save-settings", action="store_true",
                    help="write the firm fields (from lease.json / defaults) to settings.json and exit")
    args = ap.parse_args()

    if seed_settings_if_missing():
        print("Created settings.json (firm defaults) — edit it to set your firm's standing info.")

    state = load_state()
    if args.save_settings:
        save_settings(merged_inputs(state))
        print("Wrote firm defaults to settings.json.")
        return 0

    proceed = True
    if not args.defaults:
        try:
            state, proceed = run_wizard(state)
        except (KeyboardInterrupt, EOFError):
            print("\nCancelled — no files changed.")
            return 1

    save_state(state)
    generate(state)
    print("Regenerated src/variables.tex, defined_terms.tex, %d node booleans, and Exhibit B/D."
          % len(manifest.NODES))

    if proceed and not args.no_build:
        build()
    elif args.no_build:
        print("Skipped build (--no-build). Run `nix build` when ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
