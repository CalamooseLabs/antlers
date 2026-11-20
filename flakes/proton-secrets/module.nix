# NixOS module: secrets fetched from Proton Pass into a ramfs — an agenix-shaped
# "online" backend.
#
# Wired as `nixosModules.proton-secrets = import ./flakes/proton-secrets/module.nix self`.
# For each `services.proton-secrets.secrets.<name>` it reads the value with
# `pass-cli` and installs it into a ramfs generation under `secretsDir` (default
# /run/proton-secrets) with the requested owner/group/mode. Plaintext NEVER enters
# the Nix store — only `pass://` references and paths do.
#
# All of the work is done by ONE script, proton-secrets-fetch (./fetch.sh, built in
# ./package.nix), driven by a JSON manifest of what is declared here. It runs from:
#
#   * activation (`nixos-rebuild switch`, nixos-install): the snippet names and
#     order mirror ryantm/agenix (newGeneration -> install -> users.deps -> chown ->
#     barrier) so `hashedPasswordFile` consumers work during a switch. `failClosed`
#     (default true) makes a switch that could not read every secret change nothing
#     and fail; false installs what it could and warns.
#   * proton-secrets-fetch.service, at boot once the network is up. Secrets live in
#     RAM, so every boot has to fetch them again, and the boot-time activation
#     cannot (no network; with systemd stage-1 it runs inside the initrd and is
#     skipped). The unit retries with back-off until Proton answers; it stops only
#     on an error retrying cannot fix (exit 78: the PAT was rejected, no session and
#     no PAT, a required field missing or blank), and then shows as failed.
#   * proton-secrets-restore.service (with `cache.enable`), before any normal
#     service: links the sealed last-known-good copies so consumers find their
#     files on their first start even with Proton unreachable.
#
# Consumers that read a secret file when they start (`LoadCredential=`) belong in
# `restartUnits` and should be ordered `After=proton-secrets-fetch.service` —
# After= only. With Wants=/Requires= every start of the consumer (each round of a
# restart loop included) queues a start job for the fetch unit, and a start job
# runs a unit that is waiting out its back-off immediately. That is harmless
# (StartLimitIntervalSec=0, one run at a time under the lock) but throws the
# back-off away; `systemctl start`/`restart` by hand do the same, on purpose.
#
# What the script guarantees (./fetch.sh has the details):
#   - every secret is fetched on its own; one bad field does not cost the others,
#     and a secret that cannot be fetched keeps the value that is linked (or cached);
#   - a new generation is only made when content changed, and only the consumers of
#     changed secrets are restarted (`restartUnits`);
#   - the session cannot get stuck: it is probed with `pass-cli info`, pass-cli's
#     error decides between "wait" (network), "log in from the PAT", "reset the
#     local store and log in again" (only when a PAT exists, once per run) and
#     "stop: the PAT is no longer valid";
#   - `statusFile` says what happened, without any secret material.
#
# Operator runbook — secrets missing after a boot:
#   sudo proton-secrets doctor      # session files, session probe, PAT file, last run, cache
#     session probe: ok            -> read the per-secret lines of the last run (a
#                                     missing/blank field is named there)
#     session probe: no-session    -> sudo proton-secrets login
#     session probe: store-corrupt -> sudo proton-secrets repair
#     session probe: network       -> wait; the fetch unit keeps retrying
#     session probe: session-rejected -> sudo proton-secrets repair
#     "invalid, expired or has been deleted" -> renew/replace the PAT in patFile
#                                     (a PAT lives one year at most), then repair
#     (without a patFile: `repair --force`, then `login`)
#   sudo proton-secrets refresh     # run the fetch unit now and show the result
#
# The bundled proton-pass-cli is UNFREE — consumers must allowUnfree it.
#
# (The flake argument is not used: the CLI is built against the host's own pkgs,
# so `cliPackage` and the host's systemd are what get baked in.)
_flake: {
  config,
  options,
  lib,
  pkgs,
  ...
}:
with lib; let
  cfg = config.services.proton-secrets;

  wrapper = pkgs.callPackage ./package.nix {
    proton-pass-cli = cfg.cliPackage;
    systemd = config.systemd.package;
    defaultSessionDir = cfg.sessionDir;
    defaultKeyProvider = cfg.keyProvider;
  };

  users = config.users.users;

  sysusersEnabled =
    options.systemd ? sysusers && (config.systemd.sysusers.enable || config.services.userborn.enable);

  fetchUnit = "proton-secrets-fetch.service";
  restoreUnit = "proton-secrets-restore.service";

  # Everything the script needs to know. Runtime paths and pass:// references only.
  manifest = {
    version = 1;
    inherit (cfg) sessionDir keyProvider patFile secretsDir secretsMountPoint statusFile failClosed restartUnits;
    lockFile = "/run/lock/proton-pass-cli.lock";
    # How long one run waits for Proton before it gives the turn back to the
    # unit's back-off (or fails the activation).
    probeAttempts = cfg.preflightRetries;
    probeDelay = cfg.preflightRetryDelay;
    # A second and third try for an error pass-cli gives no recognisable reason for.
    fetchRetries = 2;
    fetchRetryDelay = 3;
    # Measured worst cases of one pass-cli call: 30 s per stalled request (an
    # `item view` makes at least three), ~14 s of built-in retries on HTTP 429.
    timeouts = {
      probe = 45;
      login = 45;
      item = 120;
      lock = 120;
    };
    # The script stops by itself before TimeoutStartSec would kill it mid-write.
    runBudget = max 30 (cfg.fetchService.timeoutStartSec - 30);
    # Seconds a PAT that Proton rejected is not presented again (unless its file
    # changed, or someone runs `proton-secrets repair`).
    patRetryAfter = 900;
    unitName =
      if cfg.fetchService.enable
      then fetchUnit
      else null;
    cache = {inherit (cfg.cache) enable directory withKey;};
    secrets =
      map (s: {
        inherit (s) name reference vaultName itemTitle field path mode owner group symlink optional restartUnits;
      })
      (attrValues cfg.secrets);
  };

  manifestFile = pkgs.writeText "proton-secrets-manifest.json" (builtins.toJSON manifest);

  fetch = "${getExe cfg.fetchPackage} --manifest ${manifestFile}";

  # In systemd stage-1 (boot.initrd.systemd.enable) NixOS runs the system
  # `activate` INSIDE the initrd (IN_NIXOS_SYSTEMD_STAGE1=true), which has no
  # network — so a fetch there can only fail, and with failClosed=true its
  # `exit 1` aborts activation BEFORE the `etc` snippet sets up /etc on the new
  # root, leaving switch-root with "Switch root target contains no usable init".
  # There is never a reason to fetch in the initrd, so make these snippets a
  # no-op there. They still run normally during a real activation (stage-2 boot
  # or a live `nixos-rebuild switch`); proton-secrets-fetch.service repopulates
  # the secrets at boot.
  skipInInitrd = body: ''
    if [ "''${IN_NIXOS_SYSTEMD_STAGE1:-}" = true ]; then
      echo "[proton-secrets] initrd activation has no network — skipping (fetch runs post-switch-root)"
    else
    ${body}
    fi
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
      optional = mkOption {
        type = types.bool;
        default = false;
        description = ''
          A secret the host can run without. Failing to fetch it is reported (log
          and `statusFile`) but never fails an activation (also with `failClosed`),
          and a field that is missing or blank in Proton never fails the fetch
          unit. When Proton could not be asked at all (unreachable, an error
          nothing recognises) the unit does end as "temporary" and retries, so the
          secret still arrives once Proton answers. Its previous (or cached) value
          is kept all the same.
        '';
      };
      restartUnits = mkOption {
        type = types.listOf types.str;
        default = [];
        example = ["multichat.service"];
        description = ''
          Systemd units to restart when THIS secret's content changed (including
          the first time it appears) — for consumers that read the file at start,
          e.g. through `LoadCredential=`. Only units that are active, starting or
          failed are restarted (`systemctl reset-failed`, then `--no-block
          restart`); a unit someone stopped is left alone, and so is one whose
          start is still queued behind the fetch. Order such consumers
          `After=proton-secrets-fetch.service` (not `Wants=`/`Requires=`).
        '';
      };
    };
  });
in {
  options.services.proton-secrets = {
    enable = mkEnableOption "Proton Pass secret decryption (at activation and at boot)";

    cliPackage = mkOption {
      type = types.package;
      default = pkgs.proton-pass-cli;
      defaultText = literalExpression "pkgs.proton-pass-cli";
      description = ''
        The package providing `pass-cli`. Used everywhere: activation, the units and
        the default `package`. Set it to pin a pass-cli version on one host.
      '';
    };

    package = mkOption {
      type = types.package;
      default = wrapper;
      defaultText = literalExpression "pkgs.callPackage ./package.nix { proton-pass-cli = cfg.cliPackage; }";
      description = "The proton-secrets wrapper CLI installed system-wide.";
    };

    fetchPackage = mkOption {
      type = types.package;
      default = wrapper.fetch;
      defaultText = literalExpression "(pkgs.callPackage ./package.nix { proton-pass-cli = cfg.cliPackage; }).fetch";
      readOnly = true;
      internal = true;
      description = "The built proton-secrets-fetch script (what activation and the units run).";
    };

    manifestFile = mkOption {
      type = types.path;
      default = manifestFile;
      defaultText = literalMD "the generated manifest";
      readOnly = true;
      internal = true;
      description = "The JSON manifest proton-secrets-fetch is run with (also at /etc/proton-secrets/manifest.json).";
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

    statusFile = mkOption {
      type = types.str;
      default = "/run/proton-secrets.status";
      description = ''
        JSON file (world-readable, no secret material) rewritten at the end of every
        fetch: overall `state` (`ok` — every non-`optional` secret verified against
        Proton; `degraded` — not verified, but every required secret still has a value;
        `failed` — a required secret has none; `restored` — values come from the
        sealed cache and are not verified yet), time, attempt counter, session
        state / error class, and per secret where its value came from (`fetched`,
        `unchanged`, `carried`, `cache`, `missing`), whether it changed, and which
        units were restarted.
      '';
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
        holding a Personal Access Token (`pst_...::key`). It is used to log in
        whenever there is no usable session, and it is what lets the fetch reset a
        damaged session store by itself — without it nothing is ever logged out
        automatically and a broken session needs `proton-secrets repair --force` +
        `proton-secrets login` by hand. Leave null to use an interactive login
        session. A PAT always expires (one year at most): when Proton rejects it
        the fetch stops with a distinct error until the file holds a valid one.
      '';
    };

    failClosed = mkOption {
      type = types.bool;
      default = true;
      description = ''
        For the ACTIVATION path. When true, an activation that could not freshly
        read every non-`optional` secret changes nothing and aborts the rebuild.
        When false, it installs what it could read, keeps the previous value of the
        rest, warns and carries on. (The fetch unit always behaves like `false` and
        reports through its exit code instead.)
      '';
    };

    preflightRetries = mkOption {
      type = types.ints.positive;
      default = 3;
      description = ''
        How many times ONE run asks Proton for the session state (`pass-cli info`,
        or the PAT login) while the answer is a network error, before the run gives
        up as "temporary". This is only the short in-run wait; the long one is the
        fetch unit's back-off (`fetchService`).
      '';
    };

    preflightRetryDelay = mkOption {
      type = types.ints.positive;
      default = 5;
      description = "Seconds between those attempts.";
    };

    restartUnits = mkOption {
      type = types.listOf types.str;
      default = [];
      example = ["chat-cards.service"];
      description = ''
        Systemd units to restart when ANY secret's content changed. See
        `secrets.<name>.restartUnits` for the per-secret list and the rules.
      '';
    };

    fetchService = {
      enable =
        mkEnableOption "proton-secrets-fetch.service, the boot-time fetch that retries until it succeeds"
        // {default = true;};

      restartSec = mkOption {
        type = types.ints.positive;
        default = 15;
        description = "Seconds before the first retry of a failed fetch (the back-off grows from here).";
      };

      restartMaxDelaySec = mkOption {
        type = types.ints.positive;
        default = 300;
        description = "Longest pause between two retries, in seconds.";
      };

      restartSteps = mkOption {
        type = types.ints.positive;
        default = 8;
        description = "Number of retries over which the pause grows from `restartSec` to `restartMaxDelaySec`.";
      };

      timeoutStartSec = mkOption {
        type = types.ints.between 60 3600;
        default = 300;
        description = ''
          Upper bound for one run of the fetch, in seconds. multi-user.target waits
          for the first run to end (successfully or not), so this is also the
          longest a hung run can hold the boot. The script stops itself 30 s
          earlier and reports a temporary failure.
        '';
      };
    };

    cache = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Keep a sealed last-known-good copy of every secret on disk and restore
          it into the ramfs before any service starts (proton-secrets-restore.service),
          so a boot without Proton — no internet, an expired PAT, a broken session —
          still has secrets. Every successful fetch refreshes the copies; a restored
          value is stale until then, and a secret that was rotated or revoked in
          Proton stays usable from the cache until the next successful fetch.

          This puts the secrets at rest on the machine, encrypted by `systemd-creds`
          and bound to the secret's name. Mind what the key protects: with
          `withKey = "host"` it is /var/lib/systemd/credential.secret on the SAME
          disk, so the cache is safe against a copy of `cache.directory` leaving the
          box (a backup, a stray rsync) but NOT against theft of the whole disk —
          where the PAT in `patFile` already opens the vault anyway. The TPM modes
          bind the copies to this machine's TPM instead.

          Turning this off again removes the sealed copies at the next fetch.
        '';
      };

      directory = mkOption {
        type = types.str;
        default = "/var/lib/proton-secrets-cache";
        description = ''
          Where the sealed copies live (root-only, 0700). On an impermanent host,
          persist it TOGETHER with what opens it: with `host` and `host+tpm2`
          (and `auto`, unless it settled on the TPM alone) that is the host key
          /var/lib/systemd/credential.secret, and /etc/machine-id must stay the
          same. systemd makes a new host key when there is none, and copies
          sealed with the old one no longer decrypt: the restore unit then skips
          every entry (one journal warning each) and the cache silently gives
          nothing on the boot it exists for.
        '';
      };

      withKey = mkOption {
        type = types.enum ["host" "tpm2" "host+tpm2" "auto"];
        default = "host";
        description = ''
          `systemd-creds encrypt --with-key=`: `host` (the host key file),
          `tpm2` (the TPM only), `host+tpm2` (both needed), or `auto` (both when a
          TPM is there and /var is on persistent media).
        '';
      };
    };

    secrets = mkOption {
      type = types.attrsOf secretType;
      default = {};
      description = "Secrets to fetch from Proton Pass.";
    };
  };

  config = mkIf (cfg.enable && cfg.secrets != {}) (mkMerge [
    {
      assertions =
        mapAttrsToList (name: s: {
          assertion = s.reference != null || (s.vaultName != null && s.itemTitle != null);
          message = "services.proton-secrets.secrets.\"${name}\": set `reference` (pass://…) or both `vaultName` and `itemTitle`.";
        })
        cfg.secrets
        ++ mapAttrsToList (name: s: {
          # One file per secret, directly in the generation directory.
          assertion = builtins.match "[^/\n\t]+" s.name != null && !(hasPrefix "." s.name);
          message = "services.proton-secrets.secrets.\"${name}\": `name` must be a plain file name (no '/', tab or newline, not starting with '.').";
        })
        cfg.secrets
        ++ [
          {
            assertion = cfg.fetchService.restartMaxDelaySec >= cfg.fetchService.restartSec;
            message = "services.proton-secrets.fetchService: restartMaxDelaySec must not be smaller than restartSec.";
          }
          {
            assertion = !(elem fetchUnit (cfg.restartUnits ++ concatMap (s: s.restartUnits) (attrValues cfg.secrets)));
            message = "services.proton-secrets: ${fetchUnit} cannot be in restartUnits (it is the unit that restarts them).";
          }
          {
            # Without activation snippets (see below) the unit is the only fetch.
            assertion = !sysusersEnabled || cfg.fetchService.enable;
            message = "services.proton-secrets: with systemd-sysusers/userborn there is no activation-time fetch, so fetchService.enable must stay on.";
          }
        ];

      environment.systemPackages = [cfg.package];

      # Keep interactive `proton-secrets`/`pass-cli` (run by root) aligned with the
      # session store + key provider the fetch uses.
      environment.variables = {
        PROTON_PASS_SESSION_DIR = cfg.sessionDir;
        PROTON_PASS_KEY_PROVIDER = cfg.keyProvider;
        PROTON_PASS_NO_UPDATE_CHECK = "1";
      };

      # Where `proton-secrets doctor|repair|refresh` learn about this host (sudo
      # resets the environment, so a variable would not reach them).
      environment.etc."proton-secrets/manifest.json".source = manifestFile;

      systemd.tmpfiles.rules =
        ["d ${cfg.sessionDir} 0700 root root -"]
        ++ optional cfg.cache.enable "d ${cfg.cache.directory} 0700 root root -";
    }

    # ---- Boot: fetch once the network is up, and keep trying ----
    (mkIf cfg.fetchService.enable {
      systemd.services.proton-secrets-fetch = {
        description = "Fetch Proton Pass secrets into ${cfg.secretsDir}";
        wantedBy = ["multi-user.target"];
        wants = ["network-online.target"];
        after =
          ["network-online.target"]
          ++ optional cfg.cache.enable restoreUnit
          # sysusers/userborn: the owners must exist before the chown.
          ++ optionals sysusersEnabled ["systemd-sysusers.service" "userborn.service"];
        # The unit the sysusers path used to have; keep the name resolvable.
        aliases = optional sysusersEnabled "proton-secrets-install.service";
        # network-online.target is no promise of a route to Proton, and a power
        # cut that also restarts the router can keep the internet away for
        # minutes: retry for as long as it takes, never give up on a counter.
        startLimitIntervalSec = 0;
        unitConfig.RequiresMountsFor = [cfg.sessionDir] ++ optional cfg.cache.enable cfg.cache.directory;
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          # Only the fetch — never switch-to-configuration: that starts
          # multi-user.target, whose job would wait on this unit's own job.
          ExecStart = "${fetch} unit";
          Restart = "on-failure";
          RestartSec = cfg.fetchService.restartSec;
          RestartSteps = cfg.fetchService.restartSteps;
          RestartMaxDelaySec = cfg.fetchService.restartMaxDelaySec;
          # 78 = a human must act (see ./fetch.sh). The unit then stays failed and
          # visible instead of asking Proton every five minutes with a dead PAT.
          RestartPreventExitStatus = 78;
          TimeoutStartSec = cfg.fetchService.timeoutStartSec;
        };
      };
    })

    # ---- Boot, before everything else: the sealed last-known-good copies ----
    (mkIf cfg.cache.enable {
      systemd.services.proton-secrets-restore = {
        description = "Restore Proton Pass secrets from the sealed cache";
        wantedBy = ["sysinit.target"];
        # Before sysinit.target is before every normal service, so a consumer's
        # first start already finds its files.
        before = ["sysinit.target" "shutdown.target"];
        after =
          ["local-fs.target" "systemd-sysusers.service" "userborn.service"]
          # The TPM device shows up asynchronously. Ordered after its target and
          # nothing more: systemd starts tpm2.target itself when there is a TPM,
          # while Wants= on a machine without one holds this unit — and
          # sysinit.target behind it — for the 90 s device timeout.
          ++ optional (cfg.cache.withKey != "host") "tpm2.target";
        conflicts = ["shutdown.target"];
        # A switch must not re-run it: it never touches a linked generation anyway.
        restartIfChanged = false;
        unitConfig = {
          DefaultDependencies = false;
          # The host key lives in /var/lib/systemd.
          RequiresMountsFor = [cfg.cache.directory "/var/lib/systemd"];
        };
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${fetch} restore";
        };
      };
    })

    # ---- Normal path: activation scripts (mirrors agenix names/deps) ----
    (mkIf (!sysusersEnabled) {
      system.activationScripts = {
        protonSecretsNewGeneration = {
          # The generation itself is built by the install step; this only makes
          # sure the ramfs is there.
          text = skipInInitrd "${fetch} mount || true";
          deps = ["specialfs"];
        };
        protonSecretsInstall = {
          text = skipInInitrd (
            if cfg.failClosed
            then "${fetch} activate || exit 1"
            else ''${fetch} activate || echo "[proton-secrets] WARNING: refresh failed (failClosed=false); keeping previous secrets." >&2''
          );
          deps = ["protonSecretsNewGeneration" "specialfs"];
        };
        # So user passwords (hashedPasswordFile) can be sourced online during switch.
        users.deps = ["protonSecretsInstall"];
        # Ownership after users and groups exist.
        protonSecretsChown = {
          text = skipInInitrd "${fetch} chown || true";
          deps = ["users" "groups"];
        };
        # Barrier other activation scripts can depend on.
        protonSecrets = {
          text = "";
          deps = ["protonSecretsChown"];
        };
      };
    })
  ]);
}
