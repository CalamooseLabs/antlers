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

## Options (`programs.moosefetch`)

| Option        | Default       | Purpose                                              |
|---------------|---------------|------------------------------------------------------|
| `enable`      | `false`       | Install moosefetch.                                  |
| `logo`        | `"cala-m-os"` | `"calamoose"`, `"cala-m-os"`, or `"none"`.            |
| `logoFile`    | `null`        | Custom logo image (path); overrides `logo`.          |
| `modules`     | `[]`          | Keyword list; `[]` = the built-in default layout.    |
| `logoSize`    | `"24x12"`     | chafa render size in cells (`WxH`).                  |
| `logoColors`  | `"full"`      | chafa color depth (`full`/`256`/`16`/…).             |
| `separator`   | `"  "`        | Key/value separator.                                 |
| `keyColor`    | `""`          | fastfetch color name for keys, or `""` for default.  |
| `keyMap`      | `{}`          | Upgrade a keyword into a full module object.         |
| `extraConfig` | `{}`          | Extra fastfetch config, recursively merged.          |
