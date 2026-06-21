# NixOS module for the `vibe` launcher (lives in-tree under antlers/flakes/vibe).
#
# Wired into the root flake as `nixosModules.vibe = import ./flakes/vibe/module.nix self`.
# This module exposes ONLY `programs.vibe` — it installs a configured `vibe`
# Claude Code launcher system-wide. The web session manager is a separate module:
# `nixosModules.vibe-server` (→ `services.vibe-server`); import it too to run the service.
flake: {
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  pcfg = config.programs.vibe;

  mkVibeWrapper = pkgs.callPackage ./package.nix {};

  # Resolve each preset's null pin overrides against the top-level programs.vibe.*
  # defaults (shared with the vibe-server module so both bake identical presets).
  resolvedPresets = import ./presets.nix lib pcfg;

  # The launcher built from programs.vibe options.
  vibeWrapper =
    if pcfg.package != null
    then pcfg.package
    else
      mkVibeWrapper {
        inherit (pcfg) model effort ultracode permissionMode permissions subscriptionAuth extraSettings extraArgs;
        remoteControl = pcfg.remoteControl.enable;
        remoteControlName = pcfg.remoteControl.name;
        namePrefix = pcfg.remoteControl.prefix;
        presets = resolvedPresets;
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

    ultracode = mkOption {
      type = types.bool;
      default = false;
      description = "Enable Claude Code ultracode for vibe sessions (settings.json `ultracode = true`): sends xhigh effort to the model and has Claude orchestrate dynamic multi-agent workflows for substantive tasks. A separate toggle, orthogonal to `effort`/`effortLevel`. Delivered via `--settings`, so it applies to both interactive and Remote Control sessions. Override per-run with `VIBE_ULTRACODE=1`.";
    };

    permissionMode = mkOption {
      type = types.enum ["" "default" "acceptEdits" "plan" "auto" "dontAsk" "bypassPermissions"];
      default = "auto";
      description = "Permission mode for vibe sessions, passed as the top-level `claude --permission-mode <mode>` FLAG — the reliable launch-time override (settings.json `defaultMode` is treated as project/local, and `auto` from there is deliberately ignored). Defaults to `auto` (auto-execute except classifier-blocked actions). `auto` needs claude-code ≥ 2.1.83 and an eligible model (e.g. Opus/Sonnet 4.6+); if ineligible, Claude Code silently falls back to `default`. Other values: `default` (prompt), `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` (containers/VMs only). Empty string leaves it unset. Applies to interactive and Remote Control sessions. Override per-run with `VIBE_PERMISSION_MODE`.";
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
        description = "Explicit Remote Control session name. When null (the default), vibe auto-generates `[<prefix>-]<repo>-<YYYYMMDD>` from the working directory (see `prefix`). A positional name after `--remote-control` or `VIBE_NAME` overrides this at runtime.";
      };
      prefix = mkOption {
        type = types.str;
        default = "";
        example = "work";
        description = "Prefix for the auto-generated Remote Control session name. With no explicit name, vibe names the session `<prefix>-<repo>-<YYYYMMDD>` (`<repo>` = the working directory's git-toplevel basename, cwd fallback; `<YYYYMMDD>` = today). Empty → `<repo>-<YYYYMMDD>`. Ignored when an explicit name is set. Override at runtime with `VIBE_NAME_PREFIX`.";
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

    presets = mkOption {
      default = {};
      example = literalExpression ''
        {
          antlers = {
            directories = [ "/home/me/antlers" "/home/me/notes" ];
            branch = "vibe";
            effort = "xhigh";
          };
        }
      '';
      description = ''
        Named launch presets. `vibe @<name>` starts one: it `cd`s into the preset's
        first directory, passes the rest as `claude --add-dir` (so one session can
        access several directories), applies the preset's pinned settings + permission
        mode, optionally checks out its `branch` (creating it from the current HEAD if
        absent), and seeds the session name. `services.vibe-server` also surfaces these
        presets (when the vibe module is imported). Pin fields left null inherit the
        top-level `programs.vibe.*` default; the `pushRemote`/`*RequiresTouch`/`branch`
        fields are consumed by vibe-server's Commit & Push.
      '';
      type = types.attrsOf (types.submodule {
        options = {
          directories = mkOption {
            type = types.listOf types.str;
            example = ["/srv/projects/app" "/srv/projects/shared-lib"];
            description = "Directories for this preset. The FIRST is the session's working dir (cwd); the rest are passed as `claude --add-dir`. At least one is required.";
          };
          branch = mkOption {
            type = types.nullOr types.str;
            default = null;
            example = "vibe";
            description = "Branch this preset works on: `vibe @<name>` checks it out (creating it from HEAD if absent), and vibe-server's Commit & Push targets it. null = use whatever branch the dir is currently on.";
          };
          model = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Model override for this preset (null = inherit programs.vibe.model).";
          };
          effort = mkOption {
            type = types.nullOr (types.enum ["low" "medium" "high" "xhigh" "max"]);
            default = null;
            description = "Effort override for this preset (null = inherit programs.vibe.effort).";
          };
          ultracode = mkOption {
            type = types.nullOr types.bool;
            default = null;
            description = "ultracode override for this preset (null = inherit programs.vibe.ultracode).";
          };
          permissionMode = mkOption {
            type = types.nullOr (types.enum ["" "default" "acceptEdits" "plan" "auto" "dontAsk" "bypassPermissions"]);
            default = null;
            description = "Permission-mode override for this preset (null = inherit programs.vibe.permissionMode).";
          };
          permissions = mkOption {
            type = types.nullOr types.attrs;
            default = null;
            description = "Claude Code `permissions` object override for this preset (null = inherit programs.vibe.permissions).";
          };
          pushRemote = mkOption {
            type = types.str;
            default = "";
            description = "vibe-server Commit & Push remote for this preset ('' = the branch's upstream / origin).";
          };
          commitRequiresTouch = mkOption {
            type = types.bool;
            default = false;
            description = "vibe-server: this preset's signing key needs a touch → its Commit & Push button is withheld.";
          };
          pushRequiresTouch = mkOption {
            type = types.bool;
            default = false;
            description = "vibe-server: pushing this preset needs a touch → commit is offered but push is disabled.";
          };
        };
      });
    };
  };

  config = mkIf pcfg.enable {
    environment.systemPackages = [vibeWrapper];

    assertions = [
      {
        assertion = all (p: p.directories != []) (attrValues pcfg.presets);
        message = "programs.vibe.presets: every preset needs at least one directory (the first is the session's working dir).";
      }
      {
        assertion = all (p: all (d: hasPrefix "/" d) p.directories) (attrValues pcfg.presets);
        message = "programs.vibe.presets: every preset directory must be an absolute path (start with /).";
      }
      {
        assertion = all (p: p.branch == null || builtins.match "[A-Za-z0-9_][A-Za-z0-9._/-]*" p.branch != null) (attrValues pcfg.presets);
        message = "programs.vibe.presets: each branch must be a valid branch name (start with a letter/digit/underscore; no spaces or leading '-'), or null.";
      }
    ];
  };
}
