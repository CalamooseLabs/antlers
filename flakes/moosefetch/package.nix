# moosefetch — a Cala-M-OS flavored fastfetch wrapper.
#
# Like ../vibe/package.nix, this file is a plain `callPackage`-able BUILDER, not
# a flake: it returns a FUNCTION of a config attrset and produces a `moosefetch`
# launcher (a thin wrapper over `fastfetch` with a generated config baked in).
#
# The whole point is that the system info readout is driven by a LIST OF KEYWORDS
# that reads like a Cala-M-OS user's module imports:
#
#   modules = [
#     "title" "separator"
#     "os" "kernel" "uptime"
#     ""              # a blank string => a blank line (fastfetch `break` module)
#     "cpu" "memory"
#     ""
#     "colors"
#   ];
#
# Each non-empty keyword is a fastfetch module type (passed through verbatim, so
# any module from `fastfetch --list-modules` works); an empty string "" inserts a
# spacer line. `keyMap` upgrades a bare keyword into a full module object
# ({type, key, format, ...}) and `extraConfig` is recursively merged over the
# generated config for anything else.
#
# The logo is one of the brand marks (./logos/*.png) rendered to TRUECOLOR ANSI
# symbol art at BUILD TIME via chafa, then fed to fastfetch as a `file-raw` logo.
# Pre-rendering keeps runtime dependency-light (only fastfetch) and deterministic
# (no terminal probing in the build sandbox) and works anywhere truecolor does —
# no sixel/kitty graphics protocol required.
#
# Consumed by the root flake as `lib.<system>.mkMoosefetch`; a ready-to-run
# derivation (default config) is exposed as `packages.<system>.moosefetch`, and
# the companion ./module.nix wires it to `programs.moosefetch`.
{
  lib,
  runCommandLocal,
  writeText,
  writeShellApplication,
  fastfetch,
  chafa,
  coreutils,
  gnused,
}: {
  # Which brand mark to show: "calamoose" (Calamoose Labs moose head),
  # "cala-m-os" (the gear + moose OS emblem), or "none" (no logo). To use a
  # custom image instead, set `logoFile` (a path) — it takes precedence.
  logo ? "cala-m-os",
  # A custom logo image (PNG/JPG/SVG …) rendered at build time. null => use `logo`.
  logoFile ? null,
  # Ordered keyword list (see the header). "" => a blank line. null/[] => the
  # opinionated default layout below (a function arg default can't reference a
  # let-binding, so the fallback is resolved in the body).
  modules ? null,
  # chafa render geometry (cells) and color depth. "full" = 24-bit truecolor.
  logoSize ? "24x12",
  logoColors ? "full",
  # The "<key>:<value>" separator and an optional key color (a fastfetch color
  # name like "blue"/"green" or "" for the fastfetch default).
  separator ? "  ",
  keyColor ? "",
  # keyword -> module object, e.g. { cpu = { type = "cpu"; key = " cpu"; }; }.
  keyMap ? {},
  # Recursively merged over the generated config (escape hatch for anything).
  extraConfig ? {},
}: let
  # A comprehensive, opinionated default that reads top-to-bottom like an import
  # list; spacers ("") group it into identity / desktop / hardware / power.
  defaultModules = [
    "title"
    "separator"
    "os"
    "host"
    "kernel"
    "uptime"
    "packages"
    "shell"
    ""
    "de"
    "wm"
    "terminal"
    "terminalfont"
    ""
    "cpu"
    "gpu"
    "memory"
    "swap"
    "disk"
    ""
    "battery"
    "poweradapter"
    "localip"
    ""
    "colors"
  ];

  builtinLogos = {
    calamoose = ./logos/calamoose.png;
    "cala-m-os" = ./logos/cala-m-os.png;
  };

  # Resolve the logo source. logoFile wins; then a builtin name; "none" => no
  # logo; any other string is assumed to already name a builtin (and errors
  # clearly if not) — custom paths go through `logoFile` so they land in the store.
  logoSrc =
    if logoFile != null
    then logoFile
    else if logo == "none"
    then null
    else
      builtinLogos.${logo}
      or (throw "moosefetch: unknown logo \"${logo}\" — use \"calamoose\", \"cala-m-os\", \"none\", or set logoFile.");

  # Render PNG -> cleaned truecolor ANSI symbol art. chafa wraps the frame in
  # cursor/private-mode escapes (\e[?25l … \e[?25h, autowrap toggles); those are
  # stripped so the file is pure SGR + text and fastfetch's file-raw line/width
  # accounting stays correct. SGR color runs (\e[…m) are kept.
  logoArt =
    if logoSrc == null
    then null
    else
      runCommandLocal "moosefetch-logo.ansi" {
        nativeBuildInputs = [chafa coreutils gnused];
      } ''
        esc=$(printf '\033')
        chafa --format symbols -c ${lib.escapeShellArg logoColors} \
          --size ${lib.escapeShellArg logoSize} --animate off ${logoSrc} \
          | sed -E "s/''${esc}\[\?[0-9;]*[a-zA-Z]//g" > "$out"
      '';

  # null or [] => the opinionated default layout.
  actualModules =
    if modules == null || modules == []
    then defaultModules
    else modules;

  # keyword -> fastfetch config entry.
  mkEntry = k:
    if k == ""
    then {type = "break";}
    else if keyMap ? ${k}
    then keyMap.${k}
    else k;

  logoBlock =
    if logoArt == null
    then {type = "none";}
    else {
      type = "file-raw";
      source = "${logoArt}";
      padding = {
        top = 1;
        left = 1;
        right = 4;
      };
    };

  baseConfig = {
    "$schema" = "https://github.com/fastfetch-cli/fastfetch/raw/dev/doc/json_schema.json";
    logo = logoBlock;
    display =
      {inherit separator;}
      // lib.optionalAttrs (keyColor != "") {color.keys = keyColor;};
    modules = map mkEntry actualModules;
  };

  configFile = writeText "moosefetch-config.jsonc" (builtins.toJSON (lib.recursiveUpdate baseConfig extraConfig));
in
  writeShellApplication {
    name = "moosefetch";
    runtimeInputs = [fastfetch];
    text = ''
      # moosefetch — fastfetch with the Cala-M-OS config baked in.
      # MOOSEFETCH_CONFIG overrides the baked config at runtime; extra args pass
      # straight through (e.g. `moosefetch --logo none`, `moosefetch --format json`).
      exec fastfetch --config "''${MOOSEFETCH_CONFIG:-${configFile}}" "$@"
    '';
  }
