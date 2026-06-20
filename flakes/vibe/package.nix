# vibe — a configured Claude Code launcher.
#
# This file is a plain `callPackage`-able builder, NOT a flake. It returns a
# FUNCTION of a config attrset and produces a `vibe` launcher.
#
# Two modes:
#   * interactive (default): runs `claude --settings <generated>` where the
#     generated settings.json carries the pinned model / effort / permissions /
#     extraSettings, leaving the user's real ~/.claude config untouched.
#   * remote control (`vibe --remote-control [name]` or VIBE_REMOTE_CONTROL=1):
#     runs `claude remote-control --name <name>` so the session is driven from
#     claude.ai / the mobile app.
#
# IMPORTANT: `claude remote-control` accepts only `--name` and `--permission-mode`
# (verified against claude-code 2.1.170) — NOT `--settings`, `--model`, or
# `--effort`. So in remote-control mode the only pin we can deliver is the
# permission mode (from `permissions.defaultMode`); model/effort are chosen
# client-side from claude.ai / mobile. The model/effort/permissions pins below
# therefore fully apply only to interactive sessions.
#
# Consumed by the root flake as `lib.<system>.mkVibeWrapper`. A ready-to-run
# derivation (default settings) is exposed as `packages.<system>.vibe`.
{
  lib,
  writeShellApplication,
  writeText,
  claude-code,
  jq,
  coreutils,
}: {
  model ? null,
  effort ? null,
  remoteControl ? false,
  remoteControlName ? null,
  permissions ? {},
  extraSettings ? {},
  extraArgs ? [],
}: let
  settings =
    (lib.optionalAttrs (model != null) {inherit model;})
    // (lib.optionalAttrs (effort != null) {effortLevel = effort;})
    // (lib.optionalAttrs (permissions != {}) {inherit permissions;})
    // extraSettings;

  settingsFile = writeText "vibe-settings.json" (builtins.toJSON settings);

  defaultName =
    if remoteControlName != null
    then remoteControlName
    else "vibe";

  # The one pinned setting `claude remote-control` can accept as a flag.
  rcPermissionMode = permissions.defaultMode or null;
  rcPermissionArgs = lib.optionals (rcPermissionMode != null) ["--permission-mode" rcPermissionMode];
in
  writeShellApplication {
    name = "vibe";
    runtimeInputs = [claude-code jq coreutils];
    text = ''
      # vibe — run Claude Code with antlers-pinned settings.
      # (writeShellApplication supplies the shebang + `set -euo pipefail` + shellcheck.)

      BAKED_SETTINGS=${settingsFile}

      # Remote-control mode: `vibe --remote-control [name]` or VIBE_REMOTE_CONTROL=1.
      # The session can then be driven from claude.ai / the mobile app.
      REMOTE=${lib.boolToString remoteControl}
      NAME=${lib.escapeShellArg defaultName}
      if [ "''${1:-}" = "--remote-control" ]; then
        REMOTE=true
        shift
        # Treat the next arg as the session name only if it is not a flag.
        if [ -n "''${1:-}" ] && [ "''${1#-}" = "$1" ]; then
          NAME="$1"
          shift
        fi
      fi
      [ -n "''${VIBE_REMOTE_CONTROL:-}" ] && REMOTE=true
      [ -n "''${VIBE_NAME:-}" ] && NAME="$VIBE_NAME"

      if [ "$REMOTE" = true ]; then
        # `claude remote-control` does not accept --settings/--model/--effort;
        # only --name and --permission-mode apply (model/effort are chosen from
        # claude.ai / mobile). VIBE_MODEL/VIBE_EFFORT have no effect here.
        exec claude remote-control --name "$NAME" ${lib.escapeShellArgs rcPermissionArgs} ${lib.escapeShellArgs extraArgs} "$@"
      fi

      # Interactive mode: pass the pinned settings via --settings. Layer optional
      # VIBE_MODEL / VIBE_EFFORT overrides on top of the baked settings; a real
      # file (not a process substitution) is used so Claude Code can stat/reload it.
      if [ -n "''${VIBE_MODEL:-}" ] || [ -n "''${VIBE_EFFORT:-}" ]; then
        SETTINGS_DIR="$(mktemp -d)"
        trap 'rm -rf "$SETTINGS_DIR"' EXIT
        SETTINGS="$SETTINGS_DIR/settings.json"
        jq \
          --arg model "''${VIBE_MODEL:-}" \
          --arg effort "''${VIBE_EFFORT:-}" \
          '. + (if $model == "" then {} else {model: $model} end)
             + (if $effort == "" then {} else {effortLevel: $effort} end)' \
          "$BAKED_SETTINGS" > "$SETTINGS"
        # Not exec'd: the EXIT trap must still fire to clean up the temp settings.
        claude --settings "$SETTINGS" ${lib.escapeShellArgs extraArgs} "$@"
      else
        exec claude --settings "$BAKED_SETTINGS" ${lib.escapeShellArgs extraArgs} "$@"
      fi
    '';
  }
