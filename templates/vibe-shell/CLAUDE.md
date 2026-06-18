# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

This project was scaffolded from the **`vibe-shell`** template: a Nix flake dev
shell built for working *with* Claude Code. Enter it with `direnv allow` (or
`nix develop`) — that puts `claude`, `git`, `gh`, `python3`, and the helper
commands below on `PATH`.

```
.
├── flake.nix        # nixpkgs (allowUnfree); devShells.default = ./shell.nix
├── shell.nix        # the dev shell: claude-code + git + gh + the helpers below
├── .envrc           # `use flake` (direnv auto-loads the shell)
├── .gitignore       # ignores .direnv, result, GIT_COMMIT_MSG, wiki-build, …
├── CLAUDE.md        # this file
├── docs/            # the wiki source of truth (any *.md, nested freely)
└── tools/
    └── build_wiki.py  # docs/ -> GitHub-wiki renderer (used by build/publish-wiki)
```

Build your project on top of this — add sources, a `packages.default`, etc. The
points below are the conventions that make this shell different from a plain one.

## Committing: write the message, never run `git commit`

**Every commit and tag here is cryptographically signed by a human's key.** You
cannot produce that signature, so you do **not** commit. Instead:

1. Stage the changes (`git add …`) as usual.
2. Write the proposed commit message to the file **`GIT_COMMIT_MSG`** at the repo
   root (it is gitignored — a scratchpad). Overwrite it; don't append.
3. Tell the user to run **`gcommit`**. It shows the message, asks for
   confirmation, runs `git commit -S -F GIT_COMMIT_MSG` (signing with their key),
   optionally cuts a signed tag (`git tag -s`), and on success clears the
   scratchpad.

Rules for the message you write into `GIT_COMMIT_MSG`:

- Write a normal, human-style commit message (concise subject line, body as
  needed).
- **Do not** add any "🤖 Generated with Claude Code", "Co-Authored-By: Claude",
  or similar attribution/trailer lines. Commits must read as the human author's
  own signed work.
- Do not run `git commit`, `git commit -S`, `git tag`, or `git push` yourself —
  leave signing and pushing to the human via `gcommit`.

## Documentation → wiki

`docs/` is the single source of truth and renders as plain markdown on
github.com. Two dev-shell commands mirror it into the project's GitHub wiki:

- `build-wiki` — preview; renders `docs/` into `./wiki-build/` (no clone/push).
- `publish-wiki` — clones the repo's `….wiki.git`, rebuilds it from `docs/`, and
  pushes.

`tools/build_wiki.py` auto-discovers every `*.md` under `docs/` (no page list to
maintain), flattens nested pages to flat wiki slugs, rewrites relative links to
those slugs, generates `_Sidebar.md`/`_Footer.md`, and **validates every internal
link and `#anchor`** — a broken link fails the build. So: write docs with normal
relative `.md` links, group pages with subdirectories, and run `build-wiki`
before `publish-wiki` to catch broken links. Never hand-edit the wiki.

## Conventions

- This is a Nix flake. After editing `.nix` files, run `nix flake check`; format
  with `nix fmt` if a formatter is wired up. New files must be `git add`-ed
  before Nix can see them.
- `GIT_COMMIT_MSG` and `wiki-build/` are gitignored — don't commit them.
