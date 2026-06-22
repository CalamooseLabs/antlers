# moosefetch

A Cala-M-OS flavored [fastfetch](https://github.com/fastfetch-cli/fastfetch)
wrapper. The system-info readout is driven by a **list of keywords that reads
like a Cala-M-OS user's module imports**, and the logo is a brand mark rendered
to truecolor ANSI art at build time.

```
moosefetch
```

## The keyword list

`modules` is an ordered list of keywords. Each non-empty entry is a fastfetch
module type (anything from `fastfetch --list-modules`); an **empty string `""`
inserts a blank spacer line**. It reads exactly like importing modules:

```nix
programs.moosefetch = {
  enable = true;
  logo = "cala-m-os";          # "calamoose" | "cala-m-os" | "none"
  modules = [
    "title" "separator"
    "os" "kernel" "uptime"
    ""                         # <- a blank line
    "cpu" "memory"
    ""
    "colors"
  ];
};
```

Leave `modules` empty (`[]`) to use moosefetch's opinionated default layout
(identity / desktop / hardware / power groups, separated by spacers).

`""` maps to fastfetch's `break` module (a literal empty string is not a valid
fastfetch module). Note the clock module is `datetime`, not `clock`.

## Logos

Two brand marks ship in `./logos/`:

| `logo`        | Mark                                   |
|---------------|----------------------------------------|
| `"calamoose"` | Calamoose Labs moose head              |
| `"cala-m-os"` | The Cala-M-OS gear + moose emblem       |
| `"none"`      | No logo                                |

Each PNG is rendered to **truecolor ANSI symbol art at build time** with
`chafa --format symbols -c full` (cursor/private-mode escapes stripped) and fed
to fastfetch as a `file-raw` logo — so it works anywhere truecolor does, with no
sixel/kitty graphics protocol and no runtime dependency beyond fastfetch.
fastfetch auto-detects the logo's width/height from the text, so the info column
aligns automatically.

To use a custom image, set `logoFile` (a path); it is rendered the same way and
overrides `logo`.

## Filling the width (logo left, info right)

fastfetch always renders logo-left / info-right, but it does **not** auto-stretch
to the terminal width — the total width is just `logo + gap + info text`. To make
it span the screen, widen the logo and the gap:

```nix
programs.moosefetch = {
  enable = true;
  logoSize = "70x34";    # wide logo render (cells) — was 24x12
  logoPaddingRight = 8;  # bigger gap pushes the info column toward the right
};
```

Aim the logo width at ~40–50% of your terminal's columns; the info column then
lands on the right half. Two caveats: the logo is rendered to ANSI art **at build
time**, so it's sized for one target width (a much narrower terminal wraps it) and
changing `logoSize` needs a rebuild — and chafa preserves the image's aspect
ratio, so widen the height proportionally (a tall logo beside a short `modules`
list leaves blank rows). For a runtime nudge to just the gap, pass it through:
`moosefetch --logo-padding-right "$(( COLUMNS > 110 ? 12 : 4 ))"`.

## Usage

```bash
# As a flake output
nix run github:CalamooseLabs/antlers#moosefetch

# As a NixOS / home-manager module
#   inputs.antlers.nixosModules.moosefetch        -> environment.systemPackages
#   inputs.antlers.homeManagerModules.moosefetch  -> home.packages
imports = [ inputs.antlers.homeManagerModules.moosefetch ];
programs.moosefetch.enable = true;

# As a parameterized builder
inputs.antlers.lib.x86_64-linux.mkMoosefetch { logo = "calamoose"; }
```

`MOOSEFETCH_CONFIG=<path> moosefetch` overrides the baked config at runtime, and
any extra args pass straight through to fastfetch (e.g. `moosefetch --logo none`,
`moosefetch --format json`).

## Run it on terminal / shell startup (ghostty, bash, SSH)

A terminal like **ghostty** just launches your shell, so there's nothing
ghostty-specific to configure — drop `moosefetch` into your bash init and it
greets every new interactive shell, whether you open a local ghostty window or
SSH into a box.

The one rule: **only run it in _interactive_ shells.** Emitting output from a
non-interactive shell corrupts `scp`/`sftp`/`rsync` and `ssh <host> <command>`,
so gate on `$-` containing `i`. NixOS's `interactiveShellInit` and home-manager's
`initExtra` already target the interactive path; a hand-written `~/.bashrc` must
guard itself.

**NixOS** — system-wide, runs for every interactive shell incl. SSH logins:

```nix
programs.bash.interactiveShellInit = "moosefetch";
```

**home-manager** — per-user `~/.bashrc`:

```nix
programs.bash = {
  enable = true;
  initExtra = "moosefetch"; # initExtra is the interactive-shell init
};
```

**Plain `~/.bashrc`** (no Nix), with the guard spelled out:

```bash
case $- in
  *i*) moosefetch ;; # interactive only — keeps scp/sftp/ssh-command intact
esac
```

For this to fire on an **SSH login shell**, make sure `~/.bash_profile` (or
`~/.profile`) sources `~/.bashrc` — the home-manager bash module and most distros
wire that up; if yours doesn't, add `[ -f ~/.bashrc ] && . ~/.bashrc`.

Handy variations:

```bash
# Only when arriving over SSH (skip local ghostty windows):
case $- in *i*) [ -n "$SSH_CONNECTION" ] && moosefetch ;; esac

# A lighter readout for remote boxes:
case $- in *i*) moosefetch --logo none ;; esac
```

## Options (`programs.moosefetch`)

| Option        | Default       | Purpose                                              |
|---------------|---------------|------------------------------------------------------|
| `enable`      | `false`       | Install moosefetch.                                  |
| `logo`        | `"cala-m-os"` | `"calamoose"`, `"cala-m-os"`, or `"none"`.            |
| `logoFile`    | `null`        | Custom logo image (path); overrides `logo`.          |
| `modules`     | `[]`          | Keyword list; `[]` = the built-in default layout.    |
| `logoSize`    | `"24x12"`     | chafa render size in cells (`WxH`).                  |
| `logoColors`  | `"full"`      | chafa color depth (`full`/`256`/`16`/…).             |
| `logoPaddingRight` | `4`      | Cells of gap between logo and info (widen to fill width). |
| `separator`   | `"  "`        | Key/value separator.                                 |
| `keyColor`    | `""`          | fastfetch color name for keys, or `""` for default.  |
| `keyMap`      | `{}`          | Upgrade a keyword into a full module object.         |
| `extraConfig` | `{}`          | Extra fastfetch config, recursively merged.          |
