# moosebroom

A storage-space cleaner-upper for NixOS, as a Rust/ratatui TUI. It finds
reclaimable space — old Nix generations, the store's garbage, `~/.cache` and
other junk, dev/container caches — and an ncdu-style disk scanner for hunting
down whatever else is eating the disk. It is the repo's sibling to
[`moosewire`](../moosewire) and shares its house style and lockfile shape
(ratatui + its transitive deps only, no other crates).

Everything destructive is expressed as a narrow `Step` value (argv-only command
runs, or `std::fs` removals that never follow symlinks) and executed in exactly
one place — the background reclaim worker — only after an explicit `y` confirm.

## Two views

Toggle between them with `s`.

### Reclaim (default)

A list of reclaimable **targets** grouped by category, each row showing its
label, a one-line detail, and an estimated size. Mark the ones you want, then
reclaim with a confirm. Every target is always shown for a stable UI; one with
nothing to reclaim (a tool that isn't installed, an empty dir, "only the current
generation") is shown **locked** and dimmed. Root-only targets (system
generations, the system journal, coredumps) are locked with a `(sudo)` hint
until you run under `sudo`.

Targets:

| Category | Target | What it does |
|----------|--------|--------------|
| Nix | `nix-collect-garbage -d` | collect garbage + delete old user generations |
| Nix | old system generations | `nix-env --delete-generations old` (needs root) |
| Nix | optimise store (dedup) | `nix-store --optimise` hardlinks identical files |
| Caches | `~/.cache` | clear the contents, keep the dir |
| Caches | trash | empty `${XDG_DATA_HOME:-~/.local/share}/Trash` |
| Caches | systemd journal | `journalctl --vacuum-size=200M` (needs root) |
| Caches | coredumps | clear `/var/lib/systemd/coredump` (needs root) |
| Dev | docker / podman | `… system prune -af` (never `--volumes`), if installed |
| Dev | `~/.cargo` cache | registry cache/src + git checkouts (never `bin`/`index`) |
| Dev | `~/.npm` cache | clear `~/.npm/_cacache` |

Pip/go caches live under `~/.cache` and are already counted there — moosebroom
does not double-count them.

### Disk scan (ncdu-style)

Rooted at a path (default `$HOME`, or a CLI argument). Shows the current
directory's immediate children sorted by full recursive size, descending, each
row also carrying a modification age so "big and old" is easy to spot. Sizes are
computed in the background (a child shows `…` until its size lands, then the list
re-sorts) and cached so navigating back is instant. Enter directories, go up
(never above the scan root), and delete the hovered entry with a confirm — the
delete runs through the same reclaim worker, so a big delete shows the gauge.

## Usage

```
moosebroom                 open the TUI in the reclaim view
moosebroom scan [PATH]     open the TUI in disk-scan mode at PATH (default $HOME)
moosebroom report          print the reclaim targets, no TUI (read-only smoke test)
moosebroom --version | --help
```

`report` is read-only: it runs the same probes the TUI does and prints them, but
never executes a destructive step.

## Keys

Reclaim view:

```
j / k · ↓ ↑     move            g / G   top / bottom
Space           toggle mark     a       mark all unlocked
c / Enter       reclaim marked  Esc     clear marks
s               disk scan       R       rescan
?               help            q       quit
```

Disk-scan view:

```
j / k · ↓ ↑     move            g / G   top / bottom
l / Enter       enter dir       h / ⌫   up a dir
d               delete hovered  R       rescan cwd
s / Esc         back to reclaim
?               help            q       quit
```

Confirm prompt: `y` proceeds, `n`/`Esc` cancels. While a reclaim job runs a
gauge is shown and action keys are ignored until it finishes.

## Safety

- A `Step` is never turned into a shell string — `Run` passes argv straight to
  the program (PATH-resolved, no shell), so paths with spaces or metacharacters
  are safe.
- Removals go through `std::fs` and never follow symlinks: a symlinked cache dir
  is skipped entirely, and a symlink child is unlinked (never recursed into).
- Nothing is deleted without an explicit `y` confirm, and the confirm spells out
  the exact paths it will delete and the commands it will run. Only the reclaim
  worker ever executes steps.
- Cache/trash targets lock themselves if `$XDG_CACHE_HOME` / `$XDG_DATA_HOME`
  resolve to `$HOME` or a filesystem root, so a misconfigured environment can't
  turn "clear ~/.cache" into "empty the home directory".
- Container prunes never pass `--volumes`; the cargo target never touches
  `~/.cargo/bin` or `registry/index`.

## Build

Wired into the flake exactly like moosewire:

```
nix build .#moosebroom
nix run   .#moosebroom -- report
```

The binary is wrapped with a PATH suffix for `nix` and `systemd` so the host's
own tools win; container runtimes are detected at runtime, not baked in.
