# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Nix-packaged system for generating a **Commercial Master Lease** PDF from LaTeX. `src/` holds the
full lease as a tree of LaTeX "nodes"; a Python wizard (`create-lease`) fills the deal-specific
variables and toggles which sections to include, then builds the PDF. LaTeX produces the typeset
output; Nix pins the toolchain. The Word/ODT/PDF originals the lease was transcribed from live in
`resources/` (git-ignored), and a worked amendment instance lives in `example/` (git-ignored).

## Commands

```sh
create-lease                 # interactive wizard: fill variables, pick sections, build the PDF
create-lease --no-build      # regenerate the .tex from answers but skip the build
create-lease --defaults      # non-interactive: regenerate from settings.json / lease.json / defaults
create-lease --save-settings # write the firm fields to settings.json and exit
nix build                    # compile src/main.tex -> ./result/main.pdf  (latexmk + texliveFull)
nix develop                  # enter the dev shell (or just `cd` in — .envrc runs `use flake`)
alejandra <file.nix>         # format Nix
```

- `create-lease` is the primary entry point (a `writeShellApplication` wrapper defined in `shell.nix`
  that runs `scripts/create_lease.py` under a Python with `questionary` + `rich` + `num2words`).
- **`settings.json`** (repo root, tracked) holds firm-wide defaults — the Lessor block, copy-to counsel,
  emails, and governing law. It's auto-seeded on first run and overrides the manifest defaults; edit it
  once and every new lease prefills from it. **Precedence: this deal's `lease.json` > `settings.json` >
  manifest default.** Deal-specific fields default to empty (text) or render as a blank rule (unfilled
  numbers), so an unfilled template shows clean fill-in blanks, not `____` or `zero (0)`.
- `src/main.tex` is the **only** compile root — individual nodes are not independently compilable
  (they have no preamble; they rely on the root's imported `style`/`variables`).
- No tests/linters beyond formatters (`alejandra` for Nix, `texlab` LSP for LaTeX).
- **Flake/git caveat:** this directory is **not** a git repo, so the flake resolves as a `path:` flake
  and `nix build` copies the *whole* working tree (untracked files included) — this is why `nix build`
  works with no commits. If you ever `git init` here, untracked files become invisible to the build;
  `git add` the `src/` tree and `scripts/` or the build will break.

## Architecture: the recursive node tree

The document is a tree of **nodes**; every node is a directory with exactly three files. This pattern
repeats at every depth and is the key to the whole repo.

| File | Role |
|------|------|
| `main.tex` | Imports its own `variables`, then `\ifthenelse{\boolean{includeXXX}}` → emit the heading + `\subimport content`, **else** emit `\section{\omitText}` ("Intentionally Deleted") + `\blankspace`. |
| `content.tex` | The node's body prose (hand-authored), plus `\subimport{child}{main}` lines for child nodes. |
| `variables.tex` | Declares & sets this node's `includeXXX` boolean. |

Compile flow: `src/main.tex` imports `style` + `variables`, then `\subimport{./src}{content}`.
`src/content.tex` is the document spine: the parties intro paragraph, the Basic Lease Information
cover table, `\tableofcontents`, Witnesseth, the 27 articles (`article_i` … `article_xxvii`),
`signatures`, then exhibits (`exhibit_a` … `exhibit_f`). Articles `\subimport` their `section_n`
children, which `\subimport` their `subsection_n` children.

Conventions that matter:

- **Heading level = node depth / htype.** `article` → `\section` ("ARTICLE <Roman>"); `section` →
  `\subsection` (`7.3`); `subsection` → `\subsubsection` (`7.3.2`). Front-matter, signatures, and
  exhibits use no `\section` (so they stay out of the article numbering and TOC); exhibits use the
  `\exhibithead{letter}{title}` helper. The master lease never goes deeper than `X.Y.Z`, so the
  hand-rolled `\subsubsubsection` (4th level) in `style.tex` is unused here.
- **`includeXXX` is a legal toggle, not a delete.** Setting a boolean `false` swaps the body for
  "Intentionally Deleted" while keeping the article/section number in sequence. Never drop a clause
  by deleting a node. Boolean names mirror the path: `includeVII`, `include7_3`, `include7_3_2`,
  `includeExhibitB`.
- **Header-only parents** (e.g. 7.2, 7.3, 7.6, 2.6, 27.7) have no prose — their `content.tex` is just
  `\blankspace` + `\subimport` of children.
- **Cross-references** use `\label`/`\ref` (e.g. `Section~\ref{sec:estimated-payments}`), not literal
  numbers — the source's "Section 1.x" citations were a stale flat scheme and were remapped by meaning.
  A `\label` lives at the top of the target node's `content.tex`. After changing structure, rebuild and
  check the log for `undefined references`.
- **Defined terms** (Lessor, Premises, Fair Market Value, …) render in **small caps** and hyperlink to
  their definition. `\dtdef{key}` marks the definition (link target); `\<key>` (e.g. `\lessor`) is a
  use. `scripts/link_terms.py` wrapped these across the prose deterministically (first occurrence →
  `\dtdef`, rest → `\<key>`). The key→display map is `DEFINED_TERMS` in `manifest.py`, emitted to the
  generated `src/defined_terms.tex`.

## scripts/ — the source of truth and the wizard

| File | Role |
|------|------|
| `scripts/manifest.py` | **Single source of truth.** `NODES` (every node: path, boolean, htype, TOC label, `\label` ref, header-only/lead-in flags), `INPUTS` (typed deal inputs: group, prompt, `kind` — text/address/date/floor/count/sqft/money/percent/choice —, default), `DEFINED_TERMS` (key→display map for the linked terms), `GENERATED_CONTENT`, `CROSSREF_MAP`. |
| `scripts/render.py` | Formatters + renderers. `derive(inputs)` turns the typed inputs into spelled-out `\newcommand` values (num2words for words; US address parser; MM/DD/YYYY → legal date forms; `$`/`%` legalese). Also renders per-node `main.tex`/`variables.tex`, the generated `defined_terms.tex`, and the computed Exhibit B/D tables (B is a breakable `xltabular`; D honors the abatement mode). |
| `scripts/scaffold.py` | One-time tree builder. Regenerates every `main.tex` + `variables.tex` and the structural parent `content.tex`; **never overwrites a leaf `content.tex` that already has prose** (guards on a `% TODO-PROSE` marker). `nix shell nixpkgs#python3 --command python3 scripts/scaffold.py` — but it imports `render`, which needs `num2words`, so run it via the dev-shell Python (see below). |
| `scripts/link_terms.py` | One-time deterministic defined-term linker. Wraps uses with `\<key>` (first occurrence → `\dtdef`); longest-first, word-boundary, comment-aware, idempotent, and **aborts without writing if its expand-and-compare corruption guard trips**. |
| `scripts/create_lease.py` | The `create-lease` wizard. Per-kind prompts (parses + previews addresses, validates dates/numbers), prefilled via `settings.json` then `lease.json`; `same_as` inputs (lessee notice address, abatement start date) offer to reuse a prior answer; abatement-mode choice; formatted-preview summary; regenerates **only** the value-bearing files. |

Dev-shell Python (has `questionary`/`rich`/`num2words`) for running the scripts manually:
`nix develop --command bash -c 'PY=$(grep -oE "/nix/store/[^ ]+-env/bin/python" "$(command -v create-lease)"|head -1); "$PY" scripts/<script>.py'`

**What the wizard regenerates vs. what is hand-authored.** The wizard (and scaffold) only ever write
`src/variables.tex` (all `\newcommand` values), `src/defined_terms.tex`, each node's `variables.tex`
(the include boolean), and `src/exhibit_b`/`exhibit_d/content.tex` (computed tables). **Every other
`content.tex` is hand-authored prose and is never touched** — the repo deliberately separates
values/booleans (`variables.tex`) from prose (`content.tex`). Generated files carry a
`% GENERATED by create-lease` header. Per-deal answers persist in `lease.json` (repo root, git-ignored),
so re-runs are prefilled and idempotent.

To add a variable: add it to `INPUTS` in `manifest.py` (pick a `kind`), have `derive()` emit the
`\newcommand`, reference `\theNewVar` in the relevant `content.tex`, and re-run `create-lease`/`--defaults`.
To add/remove a section: edit `NODES` in `manifest.py` and re-run `scripts/scaffold.py`.

## Styling (`src/style.tex`)

KOMA-Script `scrartcl`, heavily redefined — prefer editing `style.tex` over per-node hacks:

- Sections render as centered "ARTICLE <Roman>" + underlined uppercase title.
- Subsections/subsubsections are **run-in** (negative afterskip), underlined, trailing period, dotted
  numbering (`\arabic{section}.\arabic{subsection}…`).
- Custom `\maketitle`, custom `\tableofcontents` (its own page, with widened number columns so wide
  Roman/2-digit numbers don't collide), footer "-- <page> of <totpages> --" via `zref`.
- **Font: Century Schoolbook** (TeX Gyre Schola, `tgschola` + `T1` fontenc); headings forced to the
  serif family via `\addtokomafont{disposition}{\rmfamily}` (the only embedded font is Schola — any
  `cmss` font-shape warnings in the log are measurement noise, not output).
- `hyperref` (loaded **last**, `hidelinks`) makes the TOC, cross-refs, and defined-term uses clickable
  while staying black/borderless in print.
- Defined-term machinery: `\dtregister`/`\dtuse`/`\dtdef` (+ `\xspace`); `\input` of the generated
  `defined_terms.tex`.
- Helpers: `\formaltext{}`, `\blankspace`, `\omitText` (= "Intentionally Deleted"),
  `\exhibithead{letter}{title}`. Tables use `tabularx`/`booktabs`; breakable cover/rent tables (BLI,
  Exhibit B) use `xltabular`.

## `example/` and templates

`example/` (git-ignored) is a complete worked "First Amendment to Lease" using the same node pattern —
consult it for how levels nest. `templates/default.nix` registers `nix flake new -t .#<name>` skeletons
(only `article` at the root; the fuller set lives in `example/templates/`), but the master-lease tree is
already built, so the day-to-day workflow is `create-lease`, not scaffolding new flakes.
