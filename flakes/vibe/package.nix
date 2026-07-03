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
# Remote Control session name: when none is given explicitly (no positional name
# after --remote-control, no VIBE_NAME, no configured remoteControlName), vibe
# auto-generates `[<namePrefix>-]<repo>-<YYYYMMDD>` where <repo> is the basename of
# the working directory's git toplevel (falling back to the cwd) and <YYYYMMDD> is
# today's date. So a session in /srv/projects/antlers on 2026-06-20 with
# namePrefix = "work" is named `work-antlers-20260620`.
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
  git,
  curl,
}: {
  model ? "opus[1m]",
  effort ? null,
  ultracode ? false,
  permissionMode ? "auto",
  remoteControl ? false,
  remoteControlName ? null,
  namePrefix ? "",
  permissions ? {},
  subscriptionAuth ? true,
  extraSettings ? {},
  extraArgs ? [],
  # Named presets: attrset name -> { directories, branch, model, effort, ultracode,
  # permissionMode, permissions, ... }. `vibe @<name>` applies one: cd to its first
  # directory, `--add-dir` the rest, use its (resolved) settings/permission-mode,
  # optionally check out its branch. Pins here are assumed already resolved against
  # the top-level defaults by the caller (the programs.vibe module).
  presets ? {},
}: let
  # Report this session's interaction state to a local vibe-server, IF one injected
  # the callback env (VIBE_STATE_URL/TOKEN/SESSION_ID — server-spawned sessions
  # only). A no-op otherwise, so interactive / hand-run `vibe` is unaffected; always
  # best-effort (never fails a hook). curl is bundled so it needs nothing on PATH.
  reportState = writeShellApplication {
    name = "vibe-report-state";
    runtimeInputs = [curl];
    text = ''
      [ -n "''${VIBE_STATE_URL:-}" ] || exit 0
      curl -fsS -m 5 -X POST "''${VIBE_STATE_URL}" \
        -H 'content-type: application/json' \
        --data-binary "{\"id\":\"''${VIBE_SESSION_ID:-}\",\"token\":\"''${VIBE_STATE_TOKEN:-}\",\"state\":\"$1\"}" \
        >/dev/null 2>&1 || true
    '';
  };

  # Claude Code hooks that map turn lifecycle → vibe-server interaction state:
  # UserPromptSubmit → thinking, Stop → completed, Notification (idle/waiting) →
  # ready. Hooks fire LOCALLY even for --remote-control sessions, so this works for
  # the browser-driven sessions vibe-server spawns.
  stateHooks = {
    UserPromptSubmit = [
      {
        hooks = [
          {
            type = "command";
            command = "${reportState}/bin/vibe-report-state thinking";
          }
        ];
      }
    ];
    Stop = [
      {
        hooks = [
          {
            type = "command";
            command = "${reportState}/bin/vibe-report-state completed";
          }
        ];
      }
    ];
    Notification = [
      {
        hooks = [
          {
            type = "command";
            command = "${reportState}/bin/vibe-report-state ready";
          }
        ];
      }
    ];
  };

  mkSettings = {
    model,
    effort,
    ultracode,
    permissions,
  }: let
    base =
      (lib.optionalAttrs (model != null) {inherit model;})
      // (lib.optionalAttrs (effort != null) {effortLevel = effort;})
      # ultracode is a Claude Code settings.json toggle (xhigh effort + dynamic
      # workflow orchestration), orthogonal to effortLevel — delivered via --settings.
      // (lib.optionalAttrs ultracode {ultracode = true;})
      // (lib.optionalAttrs (permissions != {}) {inherit permissions;});
    merged = base // extraSettings;
  in
    # Bake the state-reporting hooks; an operator's extraSettings.hooks override
    # per-event (shallow merge, so their event wins; others keep reporting).
    merged // {hooks = stateHooks // (merged.hooks or {});};

  settings = mkSettings {inherit model effort ultracode permissions;};

  settingsFile = writeText "vibe-settings.json" (builtins.toJSON settings);

  # One settings file per preset + a runtime manifest (name -> primary dir,
  # add-dirs, branch, settings path, permission mode), baked in and read by jq.
  presetEntry = name: p: {
    dir = builtins.head p.directories;
    addDirs = builtins.tail p.directories;
    branch = p.branch;
    permissionMode = p.permissionMode or "";
    settings = "${writeText "vibe-preset-${name}.json" (builtins.toJSON (mkSettings {
      inherit (p) model effort ultracode permissions;
    }))}";
  };
  presetsFile = writeText "vibe-presets.json" (builtins.toJSON (lib.mapAttrs presetEntry presets));

  # An explicitly configured name; empty string means "auto-generate at runtime".
  configuredName =
    if remoteControlName != null
    then remoteControlName
    else "";
in
  writeShellApplication {
    name = "vibe";
    runtimeInputs = [claude-code jq coreutils git curl];
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
            '  vibe @<preset> [args...]       start a configured preset (dirs + branch + pins)' \
            '  vibe --remote-control [name]   drive from claude.ai / mobile' \
            '  vibe --show-config             print the pinned settings.json and exit' \
            '  vibe --help                    this help' \
            'Remote Control name defaults to [<prefix>-]<repo>-<YYYYMMDD>' \
            '  (<repo> = basename of the working dir git toplevel); [name] overrides it.' \
            'If a vibe-server runs on this host, the session self-registers so it' \
            '  appears in the web UI (set VIBE_NO_REGISTER=1 to opt out).' \
            'Env overrides: VIBE_MODEL, VIBE_EFFORT, VIBE_ULTRACODE=1,' \
            '  VIBE_PERMISSION_MODE=<mode>, VIBE_REMOTE_CONTROL=1, VIBE_NAME=<name>,' \
            '  VIBE_NAME_PREFIX=<prefix>, VIBE_API_KEY_AUTH=1 (API billing),' \
            '  VIBE_NO_REGISTER=1, VIBE_SERVER_ENDPOINT=<path to endpoint.json>.'
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

      # Presets: `vibe @<name>` applies a configured preset (programs.vibe.presets)
      # — cd to its primary directory, `--add-dir` the rest so the session can reach
      # them all, use its pinned settings + permission mode, optionally check out its
      # branch, and seed the session name. Must come before --remote-control parsing
      # so `vibe @proj --remote-control` works.
      PRESETS_FILE=${presetsFile}
      ADD_DIR_ARGS=()
      PRESET_PERM=""
      PRESET_NAME=""
      case "''${1:-}" in
        @?*)
          PRESET_NAME="''${1#@}"
          shift
          if ! jq -e --arg n "$PRESET_NAME" 'has($n)' "$PRESETS_FILE" >/dev/null 2>&1; then
            echo "vibe: unknown preset '@$PRESET_NAME'" >&2
            echo "available presets: $(jq -r 'keys | join(", ") | if . == "" then "(none configured)" else . end' "$PRESETS_FILE" 2>/dev/null)" >&2
            exit 1
          fi
          P_DIR="$(jq -r --arg n "$PRESET_NAME" '.[$n].dir // empty' "$PRESETS_FILE")"
          P_BRANCH="$(jq -r --arg n "$PRESET_NAME" '.[$n].branch // empty' "$PRESETS_FILE")"
          P_SETTINGS="$(jq -r --arg n "$PRESET_NAME" '.[$n].settings // empty' "$PRESETS_FILE")"
          PRESET_PERM="$(jq -r --arg n "$PRESET_NAME" '.[$n].permissionMode // empty' "$PRESETS_FILE")"
          # Each remaining directory becomes a `--add-dir` so Claude can access it.
          while IFS= read -r d; do
            [ -n "$d" ] && ADD_DIR_ARGS+=(--add-dir "$d")
          done < <(jq -r --arg n "$PRESET_NAME" '.[$n].addDirs[]?' "$PRESETS_FILE")
          if [ -n "$P_DIR" ]; then
            cd "$P_DIR" || {
              echo "vibe: preset '@$PRESET_NAME' working dir not accessible: $P_DIR" >&2
              exit 1
            }
          fi
          [ -n "$P_SETTINGS" ] && BAKED_SETTINGS="$P_SETTINGS"
          # Work on the preset's branch, creating it from the current HEAD if it
          # doesn't exist. Best-effort: a dirty tree / lock warns but never blocks
          # the session (you can still commit via vibe-server's signed flow).
          if [ -n "$P_BRANCH" ]; then
            CUR_BR="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
            if [ "$CUR_BR" != "$P_BRANCH" ]; then
              if git rev-parse --verify --quiet "refs/heads/$P_BRANCH" >/dev/null 2>&1; then
                git checkout "$P_BRANCH" 2>/dev/null || echo "vibe: warning: could not switch to branch '$P_BRANCH'" >&2
              else
                git checkout -b "$P_BRANCH" 2>/dev/null || echo "vibe: warning: could not create branch '$P_BRANCH'" >&2
              fi
            fi
          fi
          ;;
      esac

      # Remote-control mode: `vibe --remote-control [name]` or VIBE_REMOTE_CONTROL=1.
      # The session can then be driven from claude.ai / the mobile app.
      REMOTE=${lib.boolToString remoteControl}
      # NAME stays empty to mean "not explicitly set" → auto-generate below.
      NAME=""
      CONFIGURED_NAME=${lib.escapeShellArg configuredName}
      NAME_PREFIX=${lib.escapeShellArg namePrefix}
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
      [ -n "''${VIBE_NAME_PREFIX:-}" ] && NAME_PREFIX="$VIBE_NAME_PREFIX"

      # Permission mode is delivered via the top-level `--permission-mode` FLAG, not
      # settings.json: `defaultMode` from a --settings file is treated as a
      # project/local setting, and `auto` from those is deliberately ignored
      # (a repo can't self-grant auto) — the CLI flag is the reliable launch-time
      # override. An ineligible model/version makes claude fall back silently.
      PERMISSION_MODE=${lib.escapeShellArg permissionMode}
      [ -n "$PRESET_PERM" ] && PERMISSION_MODE="$PRESET_PERM"
      [ -n "''${VIBE_PERMISSION_MODE:-}" ] && PERMISSION_MODE="$VIBE_PERMISSION_MODE"
      PERM_ARGS=()
      [ -n "$PERMISSION_MODE" ] && PERM_ARGS=(--permission-mode "$PERMISSION_MODE")

      # Subscription-first auth: vibe targets Claude Code subscription plans
      # (Max/Team/Pro), which authenticate via the OAuth login in ~/.claude /
      # CLAUDE_CONFIG_DIR. A stray ANTHROPIC_API_KEY would silently bill the API,
      # and a stray ANTHROPIC_AUTH_TOKEN is checked AHEAD of the stored OAuth login
      # (so it overrides even a valid subscription login) — drop both. Opt out
      # (genuine API-key billing) with subscriptionAuth = false or VIBE_API_KEY_AUTH=1.
      SUBSCRIPTION_AUTH=${lib.boolToString subscriptionAuth}
      [ -n "''${VIBE_API_KEY_AUTH:-}" ] && SUBSCRIPTION_AUTH=false
      if [ "$SUBSCRIPTION_AUTH" = true ]; then
        unset ANTHROPIC_API_KEY
        unset ANTHROPIC_AUTH_TOKEN
      fi

      # Single cleanup for the temp settings dir, the heartbeat loop, and the
      # self-registration — run once on exit. So we must NOT `exec` when any of
      # these is active, or the EXIT trap would never fire.
      SETTINGS_DIR=""
      HEARTBEAT_PID=""
      REG_ID=""
      REG_DEREG=""
      REG_URL=""
      cleanup() {
        if [ -n "$HEARTBEAT_PID" ]; then kill "$HEARTBEAT_PID" 2>/dev/null || true; fi
        if [ -n "$REG_ID" ] && [ -n "$REG_URL" ]; then
          curl -fsS -m 2 -X DELETE "$REG_URL/api/register" \
            -H 'content-type: application/json' \
            --data "$(jq -nc --arg id "$REG_ID" --arg token "$REG_DEREG" '{id: $id, token: $token}')" \
            >/dev/null 2>&1 || true
        fi
        if [ -n "$SETTINGS_DIR" ]; then rm -rf "$SETTINGS_DIR" || true; fi
      }
      trap cleanup EXIT

      # Resolve the session name — used both for `--remote-control` and for
      # self-registration (so a plain interactive `vibe` is listed too). Precedence:
      # an explicit --remote-control <name> / VIBE_NAME (already in $NAME), then a
      # configured remoteControlName, then auto-generated [<prefix>-]<repo>-<YYYYMMDD>
      # from the working directory's git toplevel (cwd fallback).
      if [ -z "$NAME" ]; then
        if [ -n "$CONFIGURED_NAME" ]; then
          NAME="$CONFIGURED_NAME"
        elif [ -n "$PRESET_NAME" ]; then
          # A preset seeds the session name (overridable by an explicit name / VIBE_NAME).
          NAME="$PRESET_NAME"
        else
          REPO="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
          # Restrict the repo segment to a safe session-name charset.
          REPO="$(printf '%s' "$REPO" | tr -c 'A-Za-z0-9_-' '-')"
          DATE="$(date +%Y%m%d)"
          if [ -n "$NAME_PREFIX" ]; then
            NAME="$NAME_PREFIX-$REPO-$DATE"
          else
            NAME="$REPO-$DATE"
          fi
        fi
      fi

      # Remote control uses the top-level `--remote-control [name]` FLAG, not the
      # `claude remote-control` SUBCOMMAND, so `--settings` (model / effort /
      # permissions) is fully honoured. The session is driven from claude.ai / mobile.
      RC_ARGS=()
      if [ "$REMOTE" = true ]; then
        RC_ARGS=(--remote-control "$NAME")
      fi

      # Resolve the settings file. Both modes deliver the pinned model / effort /
      # ultracode / permissions identically — via `claude --settings <file>`. Layer
      # optional VIBE_MODEL / VIBE_EFFORT / VIBE_ULTRACODE overrides on top of the
      # baked settings; a real file (not a process substitution) is used so Claude
      # Code can stat/reload it.
      SETTINGS="$BAKED_SETTINGS"
      if [ -n "''${VIBE_MODEL:-}" ] || [ -n "''${VIBE_EFFORT:-}" ] || [ -n "''${VIBE_ULTRACODE:-}" ]; then
        SETTINGS_DIR="$(mktemp -d)"
        SETTINGS="$SETTINGS_DIR/settings.json"
        jq \
          --arg model "''${VIBE_MODEL:-}" \
          --arg effort "''${VIBE_EFFORT:-}" \
          --arg ultracode "''${VIBE_ULTRACODE:-}" \
          '. + (if $model == "" then {} else {model: $model} end)
             + (if $effort == "" then {} else {effortLevel: $effort} end)
             + (if $ultracode == "" then {} else {ultracode: ($ultracode == "1" or $ultracode == "true")} end)' \
          "$BAKED_SETTINGS" > "$SETTINGS"
      fi

      # Self-register with a local vibe-server, if one is present. When vibe-server
      # runs on this host it drops a discovery file (URL + token) at
      # /run/vibe/endpoint.json; we POST our name/dir/pid so the session shows up in
      # the web UI, heartbeat while we run, and deregister on exit. Server-spawned
      # sessions set VIBE_MANAGED=1 (already tracked) and skip this; opt out per-run
      # with VIBE_NO_REGISTER=1, or point elsewhere with VIBE_SERVER_ENDPOINT. All
      # best-effort: a missing file or any curl failure just skips registration.
      ENDPOINT_FILE="''${VIBE_SERVER_ENDPOINT:-/run/vibe/endpoint.json}"
      if [ -z "''${VIBE_MANAGED:-}" ] && [ -z "''${VIBE_NO_REGISTER:-}" ] && [ -r "$ENDPOINT_FILE" ]; then
        REG_URL="$(jq -r '.url // empty' "$ENDPOINT_FILE" 2>/dev/null || true)"
        REG_TOKEN="$(jq -r '.token // empty' "$ENDPOINT_FILE" 2>/dev/null || true)"
        if [ -n "$REG_URL" ] && [ -n "$REG_TOKEN" ]; then
          REG_RESP="$(curl -fsS -m 2 -X POST "$REG_URL/api/register" \
            -H 'content-type: application/json' \
            --data "$(jq -nc --arg t "$REG_TOKEN" --arg n "$NAME" --arg d "$PWD" --argjson p "$$" \
              '{token: $t, name: $n, dir: $d, pid: $p}')" 2>/dev/null || true)"
          REG_ID="$(printf '%s' "$REG_RESP" | jq -r '.id // empty' 2>/dev/null || true)"
          REG_DEREG="$(printf '%s' "$REG_RESP" | jq -r '.token // empty' 2>/dev/null || true)"
          if [ -n "$REG_ID" ] && [ -n "$REG_DEREG" ]; then
            # Heartbeat in the background so the server keeps the session "running"
            # (it can't rely on /proc visibility for a cross-user process).
            (
              while sleep 30; do
                curl -fsS -m 2 -X PUT "$REG_URL/api/register" \
                  -H 'content-type: application/json' \
                  --data "$(jq -nc --arg id "$REG_ID" --arg token "$REG_DEREG" '{id: $id, token: $token}')" \
                  >/dev/null 2>&1 || true
              done
            ) &
            HEARTBEAT_PID=$!
          else
            # Registration did not take — nothing to heartbeat or clean up.
            REG_ID=""
            REG_URL=""
          fi
        else
          REG_URL=""
        fi
      fi

      # Launch. `exec` only when there is nothing for the EXIT trap to do (no temp
      # settings, not registered); otherwise run claude as a child so cleanup() fires.
      if [ "$SETTINGS" = "$BAKED_SETTINGS" ] && [ -z "$REG_ID" ]; then
        exec claude --settings "$SETTINGS" "''${ADD_DIR_ARGS[@]}" "''${RC_ARGS[@]}" "''${PERM_ARGS[@]}" ${lib.escapeShellArgs extraArgs} "$@"
      else
        claude --settings "$SETTINGS" "''${ADD_DIR_ARGS[@]}" "''${RC_ARGS[@]}" "''${PERM_ARGS[@]}" ${lib.escapeShellArgs extraArgs} "$@"
      fi
    '';
  }
