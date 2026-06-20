# NixOS module for the `vibe` launcher (lives in-tree under antlers/flakes/vibe).
#
# Wired into the root flake as `nixosModules.vibe = import ./flakes/vibe/module.nix self`.
# This module exposes ONLY `programs.vibe` — it installs a configured `vibe`
# Claude Code launcher system-wide. The web session manager is a separate module:
# `nixosModules.vibe-server` (→ `services.vibe`); import it too to run the service.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  pcfg = config.programs.vibe;

  mkVibeWrapper = pkgs.callPackage ./package.nix {};

  # The launcher built from programs.vibe options.
  vibeWrapper =
    if pcfg.package != null
    then pcfg.package
    else
      mkVibeWrapper {
        inherit (pcfg) model effort permissions subscriptionAuth extraSettings extraArgs;
        remoteControl = pcfg.remoteControl.enable;
        remoteControlName = pcfg.remoteControl.name;
        namePrefix = pcfg.remoteControl.prefix;
      };
in {
  options.programs.vibe = {
    enable = mkEnableOption "the vibe Claude Code launcher (`vibe` command)";

    package = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = "Override the built `vibe` launcher. When null it is built from the options below.";
    };

    model = mkOption {
      type = types.nullOr types.str;
      default = "opus[1m]";
      example = "claude-opus-4-8[1m]";
      description = "Model alias or full id pinned for vibe sessions (settings.json `model`). Defaults to `opus[1m]` (latest Opus + 1M context) — included on Max/Team/Enterprise plans; on Pro the 1M window draws usage credits. Use `\"opus\"` for the standard 200K window, or null to leave the model unpinned. Applies to both interactive and Remote Control sessions (delivered via `--settings`); the remote client at claude.ai / mobile may still switch model client-side.";
    };

    effort = mkOption {
      type = types.nullOr (types.enum ["low" "medium" "high" "xhigh" "max"]);
      default = null;
      description = "Reasoning effort pinned for vibe sessions (settings.json `effortLevel`). Applies to both interactive and Remote Control sessions (delivered via `--settings`).";
    };

    remoteControl = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Launch `vibe` in Claude Code Remote Control mode by default.";
      };
      name = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Explicit Remote Control session name. When null (the default), vibe auto-generates `[<prefix>-]<repo>-<YYMMDD>` from the working directory (see `prefix`). A positional name after `--remote-control` or `VIBE_NAME` overrides this at runtime.";
      };
      prefix = mkOption {
        type = types.str;
        default = "";
        example = "work";
        description = "Prefix for the auto-generated Remote Control session name. With no explicit name, vibe names the session `<prefix>-<repo>-<YYMMDD>` (`<repo>` = the working directory's git-toplevel basename, cwd fallback; `<YYMMDD>` = today). Empty → `<repo>-<YYMMDD>`. Ignored when an explicit name is set. Override at runtime with `VIBE_NAME_PREFIX`.";
      };
    };

    permissions = mkOption {
      type = types.attrs;
      default = {};
      example = literalExpression ''{ defaultMode = "acceptEdits"; }'';
      description = "Claude Code `permissions` object baked into the session settings.json. Applies to both interactive and Remote Control sessions — delivered via `--settings`, so the full object is honoured, not just `defaultMode`.";
    };

    subscriptionAuth = mkOption {
      type = types.bool;
      default = true;
      description = "Target Claude Code subscription plans (Max/Team/Pro): the wrapper drops a stray ANTHROPIC_API_KEY so sessions use the plan's OAuth login (from ~/.claude / CLAUDE_CONFIG_DIR) instead of silently billing the API. Set false (or VIBE_API_KEY_AUTH=1 at runtime) for genuine API-key billing.";
    };

    extraSettings = mkOption {
      type = types.attrs;
      default = {};
      description = "Extra keys merged into the generated settings.json.";
    };

    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [];
      description = "Extra arguments appended to every `claude` invocation.";
    };
  };

  config = mkIf pcfg.enable {
    environment.systemPackages = [vibeWrapper];
  };
}
