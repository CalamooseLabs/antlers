# NixOS module: activation-time secret decryption from Proton Pass — an agenix-shaped
# "online" backend.
#
# Wired as `nixosModules.proton-secrets = import ./flakes/proton-secrets/module.nix self`.
# For each `services.proton-secrets.secrets.<name>` it fetches the value with
# `pass-cli` at ACTIVATION time and installs it into a ramfs generation under
# `secretsDir` (default /run/proton-secrets) with the requested owner/group/mode.
# Plaintext NEVER enters the Nix store — only `pass://` references and paths do.
#
# The activation ordering mirrors ryantm/agenix EXACTLY (newGeneration -> install ->
# users.deps -> chown -> barrier) so `hashedPasswordFile` consumers work during a
# `nixos-rebuild switch`. See the sibling agenix module for the reference.
#
# DIVERGENCE FROM AGENIX: agenix decrypts offline with an on-disk identity; this
# needs NETWORK + a live Proton Pass session at activation. On a running host during
# `switch` the network is up and this works; a fresh install / a reboot before the
# network is up cannot fetch. Hence: bootstrap offline (agenix), run `proton-secrets
# login`, then switch to online. `failClosed` (default true) aborts the rebuild with
# a clear message when there is no session/network rather than blocking.
#
# The bundled proton-pass-cli is UNFREE — consumers must allowUnfree it.
flake: {
  config,
  options,
  lib,
  pkgs,
  ...
}:
with lib; let
  cfg = config.services.proton-secrets;

  system = pkgs.stdenv.hostPlatform.system;
  wrapper = flake.packages.${system}.proton-secrets;
  rawCli = "${pkgs.proton-pass-cli}/bin/pass-cli";

  users = config.users.users;

  sysusersEnabled =
    options.systemd ? sysusers && (config.systemd.sysusers.enable || config.services.userborn.enable);

  # ---- ramfs generation dance (verbatim shape from agenix) ----
  mountCommand = ''
    grep -q "${cfg.secretsMountPoint} ramfs" /proc/mounts ||
      mount -t ramfs none "${cfg.secretsMountPoint}" -o nodev,nosuid,mode=0751
  '';

  newGeneration = ''
    _ps_generation="$(basename "$(readlink ${cfg.secretsDir})" || echo 0)"
    (( ++_ps_generation ))
    echo "[proton-secrets] creating new generation in ${cfg.secretsMountPoint}/$_ps_generation"
    mkdir -p "${cfg.secretsMountPoint}"
    chmod 0751 "${cfg.secretsMountPoint}"
    ${mountCommand}
    mkdir -p "${cfg.secretsMountPoint}/$_ps_generation"
    chmod 0751 "${cfg.secretsMountPoint}/$_ps_generation"
  '';

  # NOTE: runs inside the `set -e` subshell of installSecrets, so avoid the
  # `[ … ] && cmd` / `(( … )) && { … }` idioms agenix uses (a false test would
  # abort under set -e); use explicit `if … fi` instead.
  cleanupAndLink = ''
    _ps_generation="$(basename "$(readlink ${cfg.secretsDir})" || echo 0)"
    (( ++_ps_generation )) || true
    echo "[proton-secrets] symlinking new secrets to ${cfg.secretsDir} (generation $_ps_generation)..."
    ln -sfT "${cfg.secretsMountPoint}/$_ps_generation" ${cfg.secretsDir}
    if (( _ps_generation > 1 )); then
      echo "[proton-secrets] removing old secrets (generation $(( _ps_generation - 1 )))..."
      rm -rf "${cfg.secretsMountPoint}/$(( _ps_generation - 1 ))"
    fi
  '';

  setTruePath = s:
    if s.symlink
    then ''_truePath="${cfg.secretsMountPoint}/$_ps_generation/${s.name}"''
    else ''_truePath="${s.path}"'';

  # `pass-cli item view` selector args. A whole-file secret is just a field whose
  # value is the file body (a secure-note field), so both value and file secrets
  # use the same `--field ... --output human` path (no jq / no JSON shape guessing).
  viewArgs = s:
    (optionals (s.reference != null) [(escapeShellArg s.reference)])
    ++ (optionals (s.vaultName != null) ["--vault-name" (escapeShellArg s.vaultName)])
    ++ (optionals (s.itemTitle != null) ["--item-title" (escapeShellArg s.itemTitle)])
    ++ (optionals (s.field != null) ["--field" (escapeShellArg s.field)]);

  # Runs inside the `set -e` subshell — use explicit `if … fi`, not `[ … ] && cmd`.
  installSecret = s: ''
    ${setTruePath s}
    echo "[proton-secrets] fetching '${s.name}' -> '$_truePath'..."
    TMP_FILE="$_truePath.tmp"
    mkdir -p "$(dirname "$_truePath")"
    if [ "${s.path}" != "${cfg.secretsDir}/${s.name}" ]; then
      mkdir -p "$(dirname "${s.path}")"
    fi
    if ! ( umask u=r,g=,o=; ${rawCli} item view ${concatStringsSep " " (viewArgs s)} --output human > "$TMP_FILE" ); then
      echo "[proton-secrets] ERROR: failed to fetch '${s.name}' (bad reference/field or session?)" >&2
      rm -f "$TMP_FILE"
      exit 1
    fi
    if [ ! -s "$TMP_FILE" ]; then
      echo "[proton-secrets] ERROR: empty result for '${s.name}' (bad reference/field or session?)" >&2
      rm -f "$TMP_FILE"
      exit 1
    fi
    chmod ${s.mode} "$TMP_FILE"
    mv -f "$TMP_FILE" "$_truePath"
    ${optionalString s.symlink ''
      if [ "${s.path}" != "${cfg.secretsDir}/${s.name}" ]; then
        ln -sfT "${cfg.secretsDir}/${s.name}" "${s.path}"
      fi
    ''}
  '';

  # Runs once before the per-secret loop: env, optional PAT login, session preflight.
  authPrelude = ''
    export PROTON_PASS_SESSION_DIR=${escapeShellArg cfg.sessionDir}
    export PROTON_PASS_KEY_PROVIDER=${escapeShellArg cfg.keyProvider}
    export PROTON_PASS_NO_UPDATE_CHECK=1
    ${optionalString (cfg.patFile != null) ''
      if [ -r ${escapeShellArg cfg.patFile} ]; then
        PROTON_PASS_PERSONAL_ACCESS_TOKEN="$(cat ${escapeShellArg cfg.patFile})"
        export PROTON_PASS_PERSONAL_ACCESS_TOKEN
        if ! ${rawCli} test >/dev/null 2>&1; then
          echo '[proton-secrets] establishing session from PAT...'
          # pass-cli defaults to web login and ignores the env var; the PAT must
          # be passed as --pat for a non-interactive (headless) session.
          ${rawCli} login --pat "$PROTON_PASS_PERSONAL_ACCESS_TOKEN" || true
        fi
      fi
    ''}
    echo '[proton-secrets] checking Proton Pass session + network...'
    _ps_tries=0
    until ${rawCli} test >/dev/null 2>&1; do
      _ps_tries=$((_ps_tries + 1))
      if [ "$_ps_tries" -ge ${toString cfg.preflightRetries} ]; then
        echo '[proton-secrets] ERROR: no usable Proton Pass session and/or no network.' >&2
        echo '  Fix: ensure this host has network, then run:  sudo proton-secrets login' >&2
        echo '  (A fresh install / a reboot before the network is up cannot fetch — bootstrap offline.)' >&2
        exit 1
      fi
      sleep ${toString cfg.preflightRetryDelay}
    done
  '';

  # The whole online body runs in a `set -e` subshell so a failure is scoped: with
  # failClosed=true it aborts the rebuild (exit 1); with failClosed=false it warns
  # and leaves the previous generation in place. newGeneration runs separately (it
  # must mount the ramfs early), so a skipped body just leaves secretsDir pointing
  # at the last good generation.
  installSecrets = ''
    (
      set -e
      ${authPrelude}
      echo '[proton-secrets] fetching secrets...'
      ${concatStringsSep "\n" (map installSecret (attrValues cfg.secrets))}
      ${cleanupAndLink}
    ) ${
      if cfg.failClosed
      then "|| exit 1"
      else ''|| echo "[proton-secrets] WARNING: refresh failed (failClosed=false); keeping previous secrets." >&2''
    }
  '';

  chownSecret = s: ''
    ${setTruePath s}
    [ -e "$_truePath" ] && chown ${s.owner}:${s.group} "$_truePath" || true
  '';

  chownSecrets = ''
    _ps_generation="$(basename "$(readlink ${cfg.secretsDir})" || echo 0)"
    echo '[proton-secrets] chowning...'
    ${concatStringsSep "\n" (map chownSecret (attrValues cfg.secrets))}
  '';

  secretType = types.submodule ({config, ...}: {
    options = {
      name = mkOption {
        type = types.str;
        default = config._module.args.name;
        defaultText = literalExpression "config._module.args.name";
        description = "File name used under services.proton-secrets.secretsDir.";
      };
      reference = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "pass://SHARE_ID/ITEM_ID/password";
        description = ''
          Proton Pass reference: a `pass://SHARE_ID/ITEM_ID[/FIELD]` URI. Combine
          with `field`, or use `vaultName`/`itemTitle` selectors instead.
        '';
      };
      vaultName = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Vault name selector (alternative to a pass:// reference).";
      };
      itemTitle = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Item title selector (alternative to a pass:// reference).";
      };
      field = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          Field to extract (e.g. "password", or a secure-note field holding a whole
          file). Omit if the pass:// reference already ends in /FIELD.
        '';
      };
      path = mkOption {
        type = types.str;
        default = "${cfg.secretsDir}/${config.name}";
        defaultText = literalExpression ''"''${cfg.secretsDir}/''${config.name}"'';
        description = "Path where the fetched secret is installed.";
      };
      mode = mkOption {
        type = types.str;
        default = "0400";
        description = "Permissions mode of the installed secret (chmod format).";
      };
      owner = mkOption {
        type = types.str;
        default = "0";
        description = "User of the installed secret.";
      };
      group = mkOption {
        type = types.str;
        default = users.${config.owner}.group or "0";
        defaultText = literalExpression ''users.''${config.owner}.group or "0"'';
        description = "Group of the installed secret.";
      };
      symlink = mkEnableOption "symlinking the secret to its destination" // {default = true;};
    };
  });
in {
  options.services.proton-secrets = {
    enable = mkEnableOption "Proton Pass activation-time secret decryption";

    package = mkOption {
      type = types.package;
      default = wrapper;
      defaultText = literalExpression "flake.packages.\${system}.proton-secrets";
      description = "The proton-secrets wrapper CLI installed system-wide.";
    };

    sessionDir = mkOption {
      type = types.str;
      default = "/var/lib/proton-pass-cli";
      description = ''
        Persistent, out-of-store directory holding the Proton Pass session. On
        impermanent hosts, add this to your persistence list.
      '';
    };

    secretsDir = mkOption {
      type = types.str;
      default = "/run/proton-secrets";
      description = "Directory (symlink to the current ramfs generation) where secrets live.";
    };

    secretsMountPoint = mkOption {
      type =
        types.addCheck types.str (
          s: (builtins.match "[ \t\n]*" s) == null && (builtins.match ".+/" s) == null
        )
        // {description = "${types.str.description} (non-empty, no trailing slash)";};
      default = "/run/proton-secrets.d";
      description = "Ramfs mount point where generations are created before symlinking.";
    };

    keyProvider = mkOption {
      type = types.enum ["fs" "keyring" "env"];
      default = "fs";
      description = "PROTON_PASS_KEY_PROVIDER. `fs` is headless (no dbus/keyring).";
    };

    patFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/var/lib/proton-pass-cli/pat";
      description = ''
        Path (a runtime filesystem path STRING, never a Nix store path) to a file
        holding a Personal Access Token (`pst_...::key`). Read at activation to mint
        a session non-interactively. Leave null to use an interactive login session.
      '';
    };

    failClosed = mkOption {
      type = types.bool;
      default = true;
      description = ''
        When true, abort the rebuild if no session/network is available at activation.
        When false, warn and keep the previous generation's secrets.
      '';
    };

    preflightRetries = mkOption {
      type = types.ints.positive;
      default = 3;
      description = "How many times to retry `pass-cli test` before giving up.";
    };

    preflightRetryDelay = mkOption {
      type = types.ints.positive;
      default = 5;
      description = "Seconds between preflight retries.";
    };

    secrets = mkOption {
      type = types.attrsOf secretType;
      default = {};
      description = "Secrets to fetch from Proton Pass at activation.";
    };
  };

  config = mkIf (cfg.enable && cfg.secrets != {}) (mkMerge [
    {
      assertions =
        mapAttrsToList (name: s: {
          assertion = s.reference != null || (s.vaultName != null && s.itemTitle != null);
          message = "services.proton-secrets.secrets.\"${name}\": set `reference` (pass://…) or both `vaultName` and `itemTitle`.";
        })
        cfg.secrets;

      environment.systemPackages = [cfg.package];

      # Keep interactive `proton-secrets`/`pass-cli` (run by root) aligned with the
      # session store + key provider the activation step uses.
      environment.variables = {
        PROTON_PASS_SESSION_DIR = cfg.sessionDir;
        PROTON_PASS_KEY_PROVIDER = cfg.keyProvider;
        PROTON_PASS_NO_UPDATE_CHECK = "1";
      };

      systemd.tmpfiles.rules = ["d ${cfg.sessionDir} 0700 root root -"];
    }

    # ---- Normal path: activation scripts (mirrors agenix names/deps) ----
    (mkIf (!sysusersEnabled) {
      system.activationScripts = {
        protonSecretsNewGeneration = {
          text = newGeneration;
          deps = ["specialfs"];
        };
        protonSecretsInstall = {
          text = installSecrets;
          deps = ["protonSecretsNewGeneration" "specialfs"];
        };
        # So user passwords (hashedPasswordFile) can be sourced online during switch.
        users.deps = ["protonSecretsInstall"];
        # Ownership after users and groups exist.
        protonSecretsChown = {
          text = chownSecrets;
          deps = ["users" "groups"];
        };
        # Barrier other activation scripts can depend on.
        protonSecrets = {
          text = "";
          deps = ["protonSecretsChown"];
        };
      };
    })

    # ---- sysusers/userborn path: a network-ordered oneshot (mirrors agenix) ----
    (mkIf sysusersEnabled {
      systemd.services.proton-secrets-install = {
        wantedBy = ["sysinit.target"];
        after = ["systemd-sysusers.service" "network-online.target"];
        wants = ["network-online.target"];
        unitConfig.DefaultDependencies = "no";
        path = [pkgs.mount];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = pkgs.writeShellScript "proton-secrets-install" ''
            ${newGeneration}
            ${installSecrets}
            ${chownSecrets}
          '';
        };
      };
    })
  ]);
}
