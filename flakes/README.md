# Packages

Reusable package definitions (wrappers / fixups) for NixOS.

Each subdirectory holds a plain, `callPackage`-able `package.nix` — **not** a
flake. They are aggregated and exposed by the repository's root `flake.nix`, so
there is a single source of truth and no per-package flakes to keep in sync.

| Directory      | Output                              | What it is                                        |
| -------------- | ----------------------------------- | ------------------------------------------------- |
| `antlers/`     | `packages.<system>.antlers`         | the CLI shorthand for the flake's templates/packages (`antlers new`/`build`/`run` …); also `apps.<system>.antlers` + `overlays.default.antlers` |
| `zed-editor/`  | `lib.<system>.mkZedWrapper`         | builder: settings → a `zeditor` launcher that runs Zed against a throwaway, project-pinned config merged over the user's global Zed settings |
| `zed-editor/`  | `packages.<system>.zed-editor`      | the above called with default settings (ready to run) |
| `plex-desktop/`| `packages.<system>.plex-desktop`    | `plex-desktop` wrapped with Hyprland/Stylix fixes |
| `fadein/`      | `packages.<system>.fadein`          | Fade In screenwriting app — a vendored, unfree `x86_64` tarball, autoPatchelf'd; also `overlays.default.fadein` |
| `lanserver/`   | `packages.<system>.lanserver`       | a Deno LAN command server (source in `lanserver/app`, compiled with `deno compile`) |
| `lanserver/`   | `nixosModules.lanserver`            | NixOS service module (`services.lanserver`) whose `ExecStart` is the package above |
| `scripts/`     | `packages.<system>.<script>`        | reusable shell-script commands (`rebuild-config`, `edit-config`, `*-restore`, …) — `callPackages` returns one `writeShellApplication` per command in `scripts/` (plus an `apps` entry each and `lib.<system>.scripts`) |
| `scripts/`     | `nixosModules.antlers-scripts` / `homeManagerModules.antlers-scripts` | `programs.antlers-scripts` — installs the scripts (system or home) and bakes per-host overrides into them |
| `vibe/`        | `lib.<system>.mkVibeWrapper`        | builder: cfg → a `vibe` launcher that runs Claude Code with pinned model/effort/permissions (and optional Remote Control) |
| `vibe/`        | `packages.<system>.vibe`            | the above with default settings (ready to run) |
| `vibe/`        | `nixosModules.vibe`                 | NixOS module: `programs.vibe` (the launcher) |
| `vibe-server/` | `packages.<system>.vibe-server`     | Deno web service behind `services.vibe-server` (source in `vibe-server/app`, compiled with `deno compile`) |
| `vibe-server/` | `nixosModules.vibe-server`          | NixOS module: `services.vibe-server` (browser session manager; import with `vibe` to inherit its pins) |
| `cobblemon-overlay/` | `packages.<system>.cobblemon-overlay` | OBS stream-overlay Deno web service for The Cobblemon Initiative — ingests the mod's streamsync pushes (`POST /ingest`, wire protocol v1), tracks hardcore attempts + the cemetery memorial, and serves transparent SSE-live overlay pages with bundled pokesprite box icons; also `overlays.default.cobblemon-overlay` |
| `cobblemon-overlay/` | `nixosModules.cobblemon-overlay`    | NixOS service module (`services.cobblemon-overlay`) whose `ExecStart` is the package above (hardened unit, LoadCredential-staged ingest token, source-restricted firewall knobs) |
| `proton-secrets/` | `packages.<system>.proton-secrets` | headless wrapper CLI around Proton Pass `pass-cli` (fixed session dir + `fs` key provider; `login`/`status`/`resolve`/`doctor`/`repair`/`refresh`); carries the fetch engine `proton-secrets-fetch` as `passthru.fetch`; also `apps.<system>.proton-secrets` + `overlays.default.proton-secrets` |
| `proton-secrets/` | `packages.<system>.proton-pass-cli` | re-export of nixpkgs' `proton-pass-cli` (UNFREE — needs a paid Proton plan + allowUnfree) |
| `proton-secrets/` | `nixosModules.proton-secrets`       | NixOS module: `services.proton-secrets` — agenix-shaped secrets from Proton Pass in a ramfs (`/run/proton-secrets`): fetched at activation, by a boot-time unit that retries until Proton answers, and optionally restored from a sealed last-known-good cache — see [below](#proton-secrets-servicesproton-secrets) |

Consume from the root flake:

```sh
nix build github:CalamooseLabs/antlers#zed-editor
nix run   github:CalamooseLabs/antlers#plex-desktop
```

Or as a flake input (custom Zed settings):

```nix
inputs.antlers.url = "github:CalamooseLabs/antlers";
# ...
# inputs.antlers.lib.x86_64-linux.mkZedWrapper { /* zed settings */ }
# or add inputs.antlers.overlays.default to nixpkgs.overlays
```

## Add a new package

1. Create `flakes/<name>/package.nix` as a `{ <deps>, ... }: <derivation>` function.
2. Wire it into the root `flake.nix`: `packages.${system}.<name> = pkgs.callPackage ./flakes/<name>/package.nix {};` (add an `apps`/overlay entry if it is runnable).
3. `git add` the new file (untracked `.nix` files are invisible to flake evaluation), then `nix flake check`.

## proton-secrets (`services.proton-secrets`)

Secrets are declared as `services.proton-secrets.secrets.<name>` (a `pass://`
reference, or `vaultName` + `itemTitle` + `field`) and end up as files in a ramfs
generation, linked at `/run/proton-secrets/<name>` with the declared
`owner`/`group`/`mode`. Plaintext never enters the Nix store, and never touches
the disk unless the sealed cache is switched on (switching it off again removes
the sealed copies at the next fetch).

One script does all of it — `proton-secrets-fetch` (`fetch.sh`), driven by a JSON
manifest the module generates — from three places:

| When | What runs | Behaviour |
| --- | --- | --- |
| `nixos-rebuild switch`, `nixos-install` | activation snippets `protonSecretsNewGeneration` → `protonSecretsInstall` → `users` → `protonSecretsChown` → `protonSecrets` (same names/order as agenix) | `failClosed = true` (default): a run that could not read every non-optional secret changes nothing and aborts the activation. `false`: installs what it read, keeps the rest, warns. Skipped inside the initrd. |
| boot, after `network-online.target` | `proton-secrets-fetch.service` | Retries with back-off until it succeeds (`Restart=on-failure`, no start limit); stops, visibly failed, only on exit 78. Safe to `systemctl restart` at any time: a run stopped after it linked new values still owes their consumers the restart, and the next run delivers it. |
| boot, before `sysinit.target` (only with `cache.enable`) | `proton-secrets-restore.service` | Decrypts the sealed cache into the first generation, no network. Never fatal, never overwrites a linked generation. |

What a fetch does:

- **Session.** Probed with `pass-cli info` (the authenticated check; `pass-cli test`
  cannot see a dead session and is gone from pass-cli 2.2.4+). pass-cli exits 1 for
  everything, so its stderr decides: *network* → wait a little, never log in or
  out; *no session* → log in from `patFile`, the PAT passed in the environment;
  *store unreadable*, *session rejected by Proton*, or reads failing because
  pass-cli's stored PAT key is gone (a power cut shortly after a login leaves it
  empty) → `pass-cli logout --force` and log in again, once per run and **only when
  a PAT exists** — an interactive session is never thrown away; *PAT rejected* → a
  distinct permanent error that names the file; anything unrecognised → retry
  later, touch nothing. Every pass-cli call runs under one flock (shared with the
  `proton-secrets` CLI); every call the fetch makes also has a timeout (what the
  CLI passes straight through — `status`, `resolve`, `logout`, an interactive
  `login` — does not), and the session files are fsynced after a login.
- **Per secret.** Each one is fetched on its own. A secret that cannot be fetched
  keeps the value that is linked now (or the cached one) and is marked stale; a
  blank field counts as a failure. `secrets.<name>.optional = true` keeps such a
  failure from failing an activation, and a missing or blank field from failing
  the unit; when Proton could not be asked at all the unit still retries for it.
  A value is 0600 from the moment it is fetched and gets its mode and owner
  before it enters the generation.
- **Change-aware.** If every value is byte-identical to what is linked, nothing is
  touched. Otherwise generation N+1 is built completely, the symlink is renamed
  onto it, then the old one is removed. Only the consumers of changed secrets are
  restarted: `secrets.<name>.restartUnits` plus the global `restartUnits`, and only
  units that are active, starting or failed.
- **Status.** `statusFile` (default `/run/proton-secrets.status`, JSON, no secret
  material): `state` (`ok` / `degraded` / `failed` / `restored`), time, attempt
  counter, session state, error class, and per secret its `source` (`fetched`,
  `unchanged`, `carried`, `cache`, `missing`), `changed`, plus the units restarted.

Exit codes of `proton-secrets-fetch unit` (and of a `failClosed` activation):

| Code | Meaning | systemd |
| --- | --- | --- |
| `0` | every non-optional secret was read from Proton in this run | unit active |
| `75` | temporary: Proton unreachable, 5xx/429, lock busy, an error not recognised, a value that could not be put at its `path`; from the unit also an optional secret that failed for such a reason | retried with back-off |
| `78` | a human must act: PAT rejected or malformed, no session and no PAT, a required field missing or blank, a vault the PAT cannot see | not retried (`RestartPreventExitStatus`), unit failed |

The texts pass-cli prints for a missing field and for an empty one come from the
binaries' strings, not from a run against a real vault; should they be worded
differently, such a secret is retried as "not recognised" (75) instead of
stopping the unit.

Options beyond the per-secret ones (`reference`/`vaultName`/`itemTitle`/`field`,
`path`, `mode`, `owner`, `group`, `symlink`, `optional`, `restartUnits`):

| Option | Default | |
| --- | --- | --- |
| `cliPackage` | `pkgs.proton-pass-cli` | the `pass-cli` used by the module and the CLI |
| `patFile` | `null` | file with a PAT; what allows unattended (re)login and repair |
| `failClosed` | `true` | activation path only, see above |
| `restartUnits` | `[]` | restarted when any secret changed |
| `preflightRetries` / `preflightRetryDelay` | `3` / `5` | attempts / seconds one run waits on a network error before it gives up as temporary |
| `fetchService.enable` | `true` | the boot-time unit |
| `fetchService.restartSec` / `restartMaxDelaySec` / `restartSteps` | `15` / `300` / `8` | its back-off |
| `fetchService.timeoutStartSec` | `300` | upper bound of one run |
| `cache.enable` / `cache.directory` / `cache.withKey` | `false` / `/var/lib/proton-secrets-cache` / `"host"` | sealed last-known-good cache |
| `statusFile` | `/run/proton-secrets.status` | |
| `sessionDir`, `secretsDir`, `secretsMountPoint`, `keyProvider`, `package` | | as before |

Consumers that read a secret at start (`LoadCredential=`) go into `restartUnits`
and are ordered `After=proton-secrets-fetch.service` — `After=` only: with
`Wants=`/`Requires=` every restart of a looping consumer starts the fetch unit
again at once and its back-off is lost.

**The sealed cache** (`cache.enable`) keeps a `systemd-creds`-encrypted copy of
each secret in `cache.directory`, bound to the secret's name and rewritten only
when the content changed. It exists so a boot without Proton (no internet, an
expired PAT) still has secrets. What it protects against depends on `withKey`:
with `"host"` the key is `/var/lib/systemd/credential.secret` on the same disk —
safe against a copy of the cache directory leaving the machine, **not** against
theft of the whole disk (where the PAT file opens the vault anyway). `"tpm2"` and
`"host+tpm2"` bind it to the machine's TPM; `"auto"` does when there is one and
falls back to the host key alone when there is not. A secret rotated or revoked
in Proton stays usable from the cache until the next successful fetch.

On an impermanent host the cache only survives a reboot together with its key:
persist `cache.directory` **and** (with `"host"` and `"host+tpm2"`, and with
`"auto"` unless it settled on the TPM alone) `/var/lib/systemd/credential.secret`,
and keep `/etc/machine-id` stable. systemd makes a new host key when there is
none; the old copies then no longer decrypt, the restore unit skips them with a
journal warning each, and the cache gives nothing on the boot it exists for.

**Secrets missing after a boot** — as root:

```sh
proton-secrets doctor     # pass-cli version, session files, session probe, PAT file,
                          # the last fetch per secret, cache entries; prints no secret
proton-secrets refresh    # run the fetch unit now and show the result
```

| `doctor` says | Meaning | Do |
| --- | --- | --- |
| `session probe: ok`, a secret `missing`/`carried` with `missing` or `blank` | the vault field is gone or empty | fix it in Proton Pass, `proton-secrets refresh` |
| `session probe: network` | Proton unreachable | nothing: the unit keeps retrying (`systemctl status proton-secrets-fetch`) |
| `session probe: no-session` | nobody is logged in and there is no PAT | `proton-secrets login` |
| `session probe: store-corrupt`, or `pat_key: 0 bytes` | session files damaged (power cut) | `proton-secrets repair` |
| `session probe: session-rejected` | Proton dropped the session | `proton-secrets repair` |
| `error: pat-invalid` | the PAT expired (one year at most), was deleted, or the file does not hold a PAT | `pass-cli personal-access-token renew` from an account login, or put a new PAT into `patFile`; then `proton-secrets repair` |
| a secret's line shows `<-- vault` | the PAT is not granted that vault, or the name is wrong | grant it / fix the name, `proton-secrets refresh` |
| a secret's line shows `<-- install` | its value was read but could not be put at its `path` (disk full, read-only, a file in the way) | fix the path; the unit retries by itself |

With no `patFile`, `repair` needs `--force` (it drops the interactive session) and
is followed by `proton-secrets login`. `PROTON_PASS_PERSONAL_ACCESS_TOKEN` /
`PROTON_PASS_PAT_FILE` in the caller's environment are only used when the module
names no `patFile` or that file holds nothing, so a stale variable in a root
shell cannot take the place of the file the fetch unit logs in from.

The module is covered offline by `checks.<system>.proton-secrets-fetch`: a NixOS
configuration with a stub `pass-cli` (`tests/pass-cli-stub.sh`), and the built
script run through `tests/scenarios.sh`.
