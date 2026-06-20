# vibe — a configured Claude Code launcher.
#
# This file is a plain `callPackage`-able builder, NOT a flake. It returns a
# FUNCTION of a config attrset and produces a `vibe` launcher.
#
# Both modes deliver the pinned model / effort / permissions / extraSettings the
# same way — via `claude --settings <generated>` — leaving the user's real
# ~/.claude config untouched:
#   * interactive (default): `claude --settings <generated>`.
#   * remote control (`vibe --remote-control [name]` or VIBE_REMOTE_CONTROL=1):
#     `claude --settings <generated> --remote-control <name>`, so the session is
#     driven from claude.ai / the mobile app.
#
# IMPORTANT: remote control uses the top-level `--remote-control [name]` FLAG on
# the main `claude` command — NOT the `claude remote-control` SUBCOMMAND. The flag
# starts the normal interactive command with Remote Control enabled, so every
# main-command flag composes with it, including `--settings` (and thus the pinned
# model / effort / permissions). The subcommand, by contrast, only accepts
# `--name` / `--permission-mode` (verified against claude-code 2.1.170) — which is
# why the older subcommand path could not deliver model/effort. The pins below
# therefore apply to BOTH interactive and remote-control sessions. (Caveat: the
# remote client at claude.ai / mobile can still switch model client-side;
# `--settings` only sets the session default.)
#
# Subscription-first defaults: vibe targets Claude Code subscription plans
# (Max/Team/Pro). `model` defaults to `opus[1m]` (latest Opus + 1M context —
# included on Max/Team; Pro draws usage credits), and `subscriptionAuth`
# (default true) drops a stray ANTHROPIC_API_KEY so sessions use the plan's OAuth
# login rather than silently billing the API. Opt out for API-key billing with
# subscriptionAuth = false (or VIBE_API_KEY_AUTH=1).
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
  model ? "opus[1m]",
  effort ? null,
  remoteControl ? false,
  remoteControlName ? null,
  permissions ? {},
  subscriptionAuth ? true,
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
in
  writeShellApplication {
    name = "vibe";
    runtimeInputs = [claude-code jq coreutils];
    text = ''
      # vibe — run Claude Code with antlers-pinned settings.
      # (writeShellApplication supplies the shebang + `set -euo pipefail` + shellcheck.)

      BAKED_SETTINGS=${settingsFile}

      # Diagnostics: `vibe --help` / `vibe --show-config` (short-circuit; no claude).
      case "''${1:-}" in
        -h | --help)
          printf '%s\n' \
            'vibe — Claude Code with antlers-pinned settings (subscription-first).' \
            'Usage:' \
            '  vibe [claude args...]          interactive Claude Code' \
            '  vibe --remote-control [name]   drive from claude.ai / mobile' \
            '  vibe --show-config             print the pinned settings.json and exit' \
            '  vibe --help                    this help' \
            'Env overrides: VIBE_MODEL, VIBE_EFFORT, VIBE_REMOTE_CONTROL=1,' \
            '  VIBE_NAME=<name>, VIBE_API_KEY_AUTH=1 (API billing not subscription).'
          echo
          echo "Pinned settings:"
          jq . "$BAKED_SETTINGS" 2>/dev/null || cat "$BAKED_SETTINGS"
          echo
          echo "Auth status:"
          claude auth status 2>&1 || echo "  (unavailable — run 'claude auth status' or /login in claude)"
          exit 0
          ;;
        --show-config)
          jq . "$BAKED_SETTINGS" 2>/dev/null || cat "$BAKED_SETTINGS"
          exit 0
          ;;
      esac

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

      # Subscription-first auth: vibe targets Claude Code subscription plans
      # (Max/Team/Pro), which authenticate via the OAuth login in ~/.claude /
      # CLAUDE_CONFIG_DIR. A stray ANTHROPIC_API_KEY would silently bill the API
      # instead of the plan, so drop it. Opt out (genuine API-key billing) with
      # subscriptionAuth = false or VIBE_API_KEY_AUTH=1.
      SUBSCRIPTION_AUTH=${lib.boolToString subscriptionAuth}
      [ -n "''${VIBE_API_KEY_AUTH:-}" ] && SUBSCRIPTION_AUTH=false
      if [ "$SUBSCRIPTION_AUTH" = true ]; then
        unset ANTHROPIC_API_KEY
      fi

      # Resolve the settings file. Both modes deliver the pinned model / effort /
      # permissions identically — via `claude --settings <file>`. Layer optional
      # VIBE_MODEL / VIBE_EFFORT overrides on top of the baked settings; a real
      # file (not a process substitution) is used so Claude Code can stat/reload it.
      SETTINGS="$BAKED_SETTINGS"
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
      fi

      # Remote control uses the top-level `--remote-control [name]` FLAG, not the
      # `claude remote-control` SUBCOMMAND. The flag runs the normal interactive
      # command with Remote Control enabled, so `--settings` (model / effort /
      # permissions) is fully honoured — the subcommand only accepts
      # --name / --permission-mode. The session is then driven from claude.ai /
      # the mobile app.
      RC_ARGS=()
      if [ "$REMOTE" = true ]; then
        RC_ARGS=(--remote-control "$NAME")
      fi

      if [ "$SETTINGS" = "$BAKED_SETTINGS" ]; then
        # No temp settings file to clean up — exec for a tighter process tree.
        exec claude --settings "$SETTINGS" "''${RC_ARGS[@]}" ${lib.escapeShellArgs extraArgs} "$@"
      else
        # Not exec'd: the EXIT trap must still fire to clean up the temp settings.
        claude --settings "$SETTINGS" "''${RC_ARGS[@]}" ${lib.escapeShellArgs extraArgs} "$@"
      fi
    '';
  }
