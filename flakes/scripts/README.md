# scripts

A reusable collection of shell-script commands — `rebuild-config`, `edit-config`,
the `*-restore` family, an ISO flasher, an installer, and more — extracted from
the Cala-M-OS NixOS config so they ship as **standalone, host-agnostic binaries**.
Each command is a thin [`writeShellApplication`](https://nixos.org/manual/nixpkgs/stable/#trivial-builder-writeShellApplication)
(shebang + `set -euo pipefail` + a build-time `shellcheck` gate) wrapping a shell
body in the repo's top-level `scripts/` directory. Every value that used to be
hardcoded in the config is now read from an env var with the original value as
its default (e.g. `${CONFIG_PATH:-/etc/nixos}`), so a script runs anywhere with
its defaults, takes a runtime env override, **or** has a default baked in by the
companion `programs.antlers-scripts` module.

`package.nix` is the unusual one: it returns an **attrset of derivations** (one
per command), so the root flake wires it with **`callPackages`** (plural — not
`callPackage`) and fans the set out across every output kind. The repo is
[`github:CalamooseLabs/antlers`](https://github.com/CalamooseLabs/antlers).

## Outputs

`scripts = pkgs.callPackages ./flakes/scripts/package.nix {}` is the raw
derivation set; the root flake spreads it across these outputs (here `<system>`
is `x86_64-linux`, the flake's only system):

| Output                                    | What it is                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages.<system>.<script>`              | each script as its own buildable package (`scripts` merged in via `// scripts`)     |
| `apps.<system>.<script>`                  | a `nix run .#<script>` target per command (`mapAttrs` over `scripts`)               |
| `lib.<system>.scripts`                    | the raw derivation set, for downstream reuse                                         |
| `overlays.default.<script>`               | each script added to the overlay (`// (callPackages ./flakes/scripts/package.nix {})`) |
| `nixosModules.antlers-scripts`            | `programs.antlers-scripts` — **system** variant (`environment.systemPackages`)      |
| `homeManagerModules.antlers-scripts`      | `programs.antlers-scripts` — **home** variant (`home.packages`)                     |

Both modules are produced from the **same** `module.nix`, which is a function of
one string argument: `import ./flakes/scripts/module.nix "system"` and
`import ./flakes/scripts/module.nix "home"`. They expose an identical
`programs.antlers-scripts` option tree; only the `config` side differs — `home`
emits `home.packages`, anything else emits `environment.systemPackages`. The
module carries a stable `key = "antlers-scripts-${location}"` so it **dedups**
when many per-user shims import it.

## The scripts

`mk name runtimeInputs` reads `scripts/<name>.sh` into a `writeShellApplication`
with `runtimeInputs` prepended to `PATH`. System tools (`sudo`, `systemctl`,
`nixos-install`, `disko`, `nixos-enter`, `chpasswd`, `dd`, `lsblk`, …) are
**deliberately not** listed as inputs — `writeShellApplication` keeps the
inherited `$PATH`, so they resolve from the host or ISO the script runs on.

| Command              | What it does                                                                                                           | runtimeInputs |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------- |
| `rebuild-config`     | Opens `lazygit` when the config tree is dirty, then `nh os switch <CONFIG_PATH>`. Re-adds `set -x` so the run stays traced (`set -eux`). | `git lazygit nh` |
| `edit-config`        | `direnv exec <EDIT_CONFIG_DIR> zeditor <EDIT_CONFIG_DIR>` (`zeditor` resolves from the dev-shell PATH).                | `direnv` |
| `restore-config`     | `sudo nix-store --verify --repair`, `nh os switch <RESTORE_CONFIG_PATH>`, then restarts NetworkManager.               | `nh nix` |
| `ssh-key-import`     | Downloads resident YubiKey SSH keys (`ssh-keygen -K`) into `~/.ssh/<SSH_KEY_NAME>` and `ssh-add`s them. Refuses to run as root; `--force` re-extracts. | `openssh coreutils gnugrep` |
| `github-repo-puller` | Clones/fast-forwards the repos in `REPO_MAP` (`github:Owner/Repo` → one repo; `github:Owner` → every public repo). Idempotent; refuses root. | `git curl jq coreutils` |
| `chromium-ephemeral` | Launches `${CHROMIUM_EPHEMERAL_BIN}` against a throwaway profile in a tmpfs runtime dir, deleted on exit; passes `"$@"` through. | `ungoogled-chromium coreutils` |
| `bridge-internet`    | Shares internet from one device to another: assigns an IP, adds an `nft` NAT masquerade rule, runs `dnsmasq` DHCP, and cleans up on exit. `-i`/`-e` required; `-r`/`-n`/`-t` optional; root-only. | `dnsmasq nftables iproute2 coreutils procps gnugrep gawk` |
| `flash-iso`          | Interactive USB flasher: lists USB drives, builds `<FLAKE>#<FLASH_ISO_ATTR>`, then `dd`s the ISO with a `YES` confirmation. | `git jq util-linux coreutils nix` |
| `install-cala-m-os`  | Full installer (`disko` wipe → minimal install → prefetch → full rebuild → set passwords). Ships with a bash-completion. See below. | `git nix util-linux coreutils` |
| `gpg-key-import`     | Imports the YubiKey GPG public key (`GPG_KEY_FILE`, id `GPG_KEY_ID`) into the invoking user's keyring; idempotent, refuses root. | `gnupg coreutils` |
| `remote-kvm`         | Opens a named KVM in Chromium `--app` mode; probes the DNS URL first and falls back to the IP URL off-network. Per-target persistent profile (reused across runs, not deleted on exit). | `curl chromium coreutils` |
| `pi-imager`          | `exec rpi-imager "$@"` with `QT_STYLE_OVERRIDE`/`QT_QPA_PLATFORM` exported (Wayland/fusion by default).                | `rpi-imager` |
| `arr-restore`        | Generic Servarr restore: restores the newest backup zip's `<app>.db` + `config.xml` from the mounted NAS share, stop/start the unit, `/ping` health-check. Re-execs under `sudo`. **The module renames this to `<app>-restore` per instance** (see below). | `coreutils findutils util-linux systemd curl gnugrep gnused unzip` |
| `plex-restore`       | Restores Plex `Preferences.xml` + the newest DB snapshot; `--list`/`--from <dir>`/`--prefs-only`; `/identity` health-check. Re-execs under `sudo`. | `coreutils findutils util-linux systemd curl gnugrep` |
| `plex-backup`        | Snapshots Plex `Preferences.xml` + a verified `sqlite3 .backup` of the library/blobs DBs to `<BACKUP_DIR>/automated`, with `PLEX_RETENTION` rotation. | `coreutils findutils util-linux sqlite` |

### `install-cala-m-os` (bundled completion)

`install-cala-m-os` is built specially: rather than the bare `writeShellApplication`,
it is re-wrapped in a `runCommandLocal` that installs the binary **plus** a
companion bash-completion (`scripts/install-cala-m-os.completion.bash`, which
completes a host name for arg 1 and an optional machine name for arg 2) via
`installShellFiles`. Run it as `install-cala-m-os <host-flake> [machine]`; the
optional machine override is exported as `MACHINE_OVERRIDE` and persisted to
`machine-override.nix` so future rebuilds keep targeting it.

## Env-var overrides

Every script reads its tunables from the environment, so an override needs **no
rebuild** — set the var inline (`CONFIG_PATH=/srv/cfg rebuild-config`). These are
the same vars the module bakes as defaults via `makeWrapper --set-default`:

| Command              | Env vars (default)                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rebuild-config`     | `CONFIG_PATH` (`/etc/nixos`)                                                                                                                                                                                          |
| `edit-config`        | `EDIT_CONFIG_DIR` (`/etc/nixos`)                                                                                                                                                                                      |
| `restore-config`     | `RESTORE_CONFIG_PATH` (`/etc/nixos`)                                                                                                                                                                                  |
| `ssh-key-import`     | `SSH_KEY_NAME` (`id_ed25519_sk`)                                                                                                                                                                                     |
| `github-repo-puller` | `REPO_MAP` (newline-separated `ref dir`), `GITHUB_API` (`https://api.github.com`), `GITHUB_TOKEN` (unset)                                                                                                            |
| `chromium-ephemeral` | `CHROMIUM_EPHEMERAL_BIN` (`chromium`)                                                                                                                                                                                 |
| `bridge-internet`    | `BRIDGE_IP_RANGE` (`10.0.0`), `BRIDGE_NETMASK` (`24`), `BRIDGE_LEASE_TIME` (`24h`), `BRIDGE_DHCP_PORT` (`5353`) — plus `-i`/`-e`/`-r`/`-n`/`-t` flags                                                                |
| `flash-iso`          | `FLASH_ISO_FLAKE` (git toplevel of `$PWD`), `FLASH_ISO_ATTR` (`nixosConfigurations.iso.config.system.build.isoImage`), `FLASH_ISO_TITLE` (`Cala-M-OS ISO Flash Tool`)                                                |
| `install-cala-m-os`  | `INSTALL_FLAKE_REF`, `INSTALL_CLONE_URL`, `INSTALL_VERSION_ATTR`, `INSTALL_TARGET_DIR`, `INSTALL_MNT_DIR`, `INSTALL_PREFETCH_REL`, `INSTALL_PASSWD_USERS`                                                            |
| `gpg-key-import`     | `GPG_KEY_FILE` (`/run/agenix/yubigpg.asc`), `GPG_KEY_ID` (`50D56BF0B93CA212`)                                                                                                                                        |
| `remote-kvm`         | `REMOTE_KVM_TARGETS` (newline-separated `name dns ip`), `REMOTE_KVM_DEFAULT` (`broadcast`), `REMOTE_KVM_PROFILE_DIR` (`$HOME/.local/share/remote-kvm`) — plus a positional target arg                                |
| `pi-imager`          | `PI_IMAGER_QT_STYLE_OVERRIDE` (`fusion`), `PI_IMAGER_QT_QPA_PLATFORM` (`wayland`)                                                                                                                                    |
| `arr-restore`        | `ARR_APP` (`sonarr`), `ARR_PORT` (`8989`), `ARR_DATA_DIR` (`/var/lib/sonarr/.config/NzbDrone`), `ARR_BACKUP_DIR` (`/mnt/backups/sonarr`), `ARR_DB` (`<app>.db`), `ARR_SERVICE` (`<app>.service`) — plus `--list`/`--from <zip>`/`--help` |
| `plex-restore`       | `PLEX_DATA_DIR`, `BACKUP_DIR`, `PLEX_USER`, `PLEX_GROUP`, `PLEX_PRIMARY_DB`, `PLEX_BLOBS_DB`, `PLEX_SERVICE`, `PLEX_PORT` — plus `--list`/`--from`/`--prefs-only`/`--help`                                            |
| `plex-backup`        | `PLEX_DATA_DIR`, `BACKUP_DIR`, `PLEX_PRIMARY_DB`, `PLEX_BLOBS_DB`, `PLEX_RETENTION` (`7`)                                                                                                                            |

## `programs.antlers-scripts`

The module installs only the scripts you enable, each wrapped to bake the chosen
options in as **defaults** (a runtime env var still wins). The wrap is lazy: a
script with no non-empty `--set-default` and no rename is installed as the bare
package; otherwise it is re-wrapped with `makeWrapper`. An empty-string option is
**dropped**, so the script's own built-in default applies (e.g.
`flash-iso.flake = ""` keeps the git-toplevel autodetect).

| Option                                | Default                | Notes                                                                                  |
| ------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `enable`                              | `false`                | master switch — nothing is installed unless this is on                                 |
| `rebuild-config.enable`               | `false`                | install `rebuild-config`                                                                |
| `rebuild-config.configPath`           | `/etc/nixos`           | → `CONFIG_PATH`                                                                          |
| `edit-config.enable`                  | `false`                | install `edit-config`                                                                    |
| `edit-config.configDir`               | `/etc/nixos`           | → `EDIT_CONFIG_DIR`                                                                      |
| `restore-config.enable`               | `false`                | install `restore-config`                                                                 |
| `restore-config.configPath`           | `/etc/nixos`           | → `RESTORE_CONFIG_PATH`                                                                  |
| `ssh-key-import.enable`               | `false`                | install `ssh-key-import`                                                                 |
| `ssh-key-import.keyName`              | `id_ed25519_sk`        | → `SSH_KEY_NAME`                                                                         |
| `chromium-ephemeral.enable`           | `false`                | install `chromium-ephemeral`                                                             |
| `chromium-ephemeral.binary`           | `chromium`             | → `CHROMIUM_EPHEMERAL_BIN`                                                               |
| `pi-imager.enable`                    | `false`                | install `pi-imager`                                                                      |
| `pi-imager.qtStyleOverride`           | `fusion`               | → `PI_IMAGER_QT_STYLE_OVERRIDE`                                                          |
| `pi-imager.qtQpaPlatform`             | `wayland`              | → `PI_IMAGER_QT_QPA_PLATFORM`                                                            |
| `gpg-key-import.enable`               | `false`                | install `gpg-key-import`                                                                 |
| `gpg-key-import.keyFile`              | `/run/agenix/yubigpg.asc` | → `GPG_KEY_FILE`                                                                       |
| `gpg-key-import.keyId`                | `50D56BF0B93CA212`     | → `GPG_KEY_ID`                                                                           |
| `bridge-internet.enable`              | `false`                | install `bridge-internet`                                                                |
| `bridge-internet.ipRange`             | `10.0.0`               | → `BRIDGE_IP_RANGE`                                                                      |
| `bridge-internet.netmask`             | `24`                   | → `BRIDGE_NETMASK`                                                                       |
| `bridge-internet.leaseTime`           | `24h`                  | → `BRIDGE_LEASE_TIME`                                                                    |
| `bridge-internet.dhcpPort`            | `5353`                 | `types.port` → `BRIDGE_DHCP_PORT`                                                        |
| `flash-iso.enable`                    | `false`                | install `flash-iso`                                                                      |
| `flash-iso.flake`                     | `""`                   | → `FLASH_ISO_FLAKE`; `""` keeps the script's git-toplevel autodetect                    |
| `flash-iso.attr`                      | `nixosConfigurations.iso.config.system.build.isoImage` | → `FLASH_ISO_ATTR`                                      |
| `flash-iso.title`                     | `Cala-M-OS`            | → `FLASH_ISO_TITLE`                                                                      |
| `install-cala-m-os.enable`            | `false`                | install `install-cala-m-os` (+ completion)                                              |
| `install-cala-m-os.flakeRef`          | `github:CalamooseLabs/cala-m-os` | → `INSTALL_FLAKE_REF`                                                          |
| `install-cala-m-os.cloneUrl`          | `https://github.com/calamooselabs/cala-m-os.git` | → `INSTALL_CLONE_URL`                                          |
| `install-cala-m-os.versionAttr`       | `calamoose.version`    | → `INSTALL_VERSION_ATTR`                                                                 |
| `install-cala-m-os.targetDir`         | `/etc/nixos`           | → `INSTALL_TARGET_DIR`                                                                   |
| `install-cala-m-os.mntDir`            | `/mnt/etc/nixos`       | → `INSTALL_MNT_DIR`                                                                      |
| `install-cala-m-os.prefetchRel`       | `prefetch/displaylink-620.zip` | → `INSTALL_PREFETCH_REL`                                                        |
| `install-cala-m-os.passwdUsers`       | `[ "hub" "root" ]`     | `listOf str`, space-joined → `INSTALL_PASSWD_USERS`                                      |
| `github-repo-puller.enable`           | `false`                | install `github-repo-puller`                                                             |
| `github-repo-puller.repos`            | `{}`                   | `attrsOf str`: `github:Owner[/Repo]` → parent dir; rendered newline-joined → `REPO_MAP` |
| `github-repo-puller.githubApi`        | `https://api.github.com` | → `GITHUB_API`                                                                        |
| `github-repo-puller.githubToken`      | `null`                 | `nullOr str` → `GITHUB_TOKEN` (prefer env/agenix over baking it in)                      |
| `remote-kvm.enable`                   | `false`                | install `remote-kvm`                                                                     |
| `remote-kvm.targets`                  | `{}`                   | `attrsOf { dns; ip; }`; rendered `name dns ip` per line → `REMOTE_KVM_TARGETS`           |
| `remote-kvm.defaultTarget`            | `broadcast`            | → `REMOTE_KVM_DEFAULT`                                                                   |
| `remote-kvm.profileDir`               | `""`                   | → `REMOTE_KVM_PROFILE_DIR`; `""` keeps the script's `$HOME/.local/share/remote-kvm`      |
| `arr-restore.instances`               | `{}`                   | `attrsOf` submodule — one `<app>-restore` command per entry (see below)                  |
| `plex.backup.enable`                  | `false`                | install `plex-backup`                                                                    |
| `plex.restore.enable`                 | `false`                | install `plex-restore`                                                                   |
| `plex.dataDir`                        | `/var/lib/plex`        | → `PLEX_DATA_DIR` (both)                                                                 |
| `plex.backupDir`                      | `/mnt/backup`          | → `BACKUP_DIR` (both)                                                                    |
| `plex.user` / `plex.group`            | `plex` / `plex`        | → `PLEX_USER` / `PLEX_GROUP` (both)                                                      |
| `plex.service`                        | `plex.service`         | → `PLEX_SERVICE` (restore)                                                               |
| `plex.port`                           | `32400`                | `types.port` → `PLEX_PORT` (restore)                                                     |
| `plex.primaryDb`                      | `com.plexapp.plugins.library.db` | → `PLEX_PRIMARY_DB` (both)                                                     |
| `plex.blobsDb`                        | `com.plexapp.plugins.library.blobs.db` | → `PLEX_BLOBS_DB` (both)                                                 |
| `plex.retention`                      | `7`                    | `types.int` → `PLEX_RETENTION` (backup)                                                  |

### `arr-restore.instances.<name>`

`arr-restore` is the one **generic** tool the module fans out: each entry in
`instances` produces a separately-named `<app>-restore` binary (the `wrap`'s
`bin = "${i.app}-restore"`), wrapping the same `arr-restore` package with that
instance's env baked in. So `sonarr`, `radarr`, `prowlarr`, … each get their own
command.

| Option       | Default        | Notes                                                            |
| ------------ | -------------- | ---------------------------------------------------------------- |
| `app`        | `<name>`       | the attr name; → `ARR_APP`, names the binary `<app>-restore`     |
| `port`       | (required)     | `types.port` → `ARR_PORT` (the `/ping` health check)             |
| `dataDir`    | (required)     | → `ARR_DATA_DIR` (`services.<app>.dataDir`)                       |
| `backupDir`  | (required)     | → `ARR_BACKUP_DIR` (the mounted NAS backup share)                |
| `db`         | `""`           | → `ARR_DB`; `""` ⇒ the script defaults it to `<app>.db`          |
| `service`    | `""`           | → `ARR_SERVICE`; `""` ⇒ the script defaults it to `<app>.service`|

## Consume it

As a flake input, importing the module and enabling a few scripts (NixOS shown;
swap `nixosModules` → `homeManagerModules` for the home-manager variant):

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.antlers-scripts ];

  programs.antlers-scripts = {
    enable = true;

    rebuild-config = { enable = true; configPath = "/etc/nixos"; };
    edit-config.enable = true;
    flash-iso.enable = true;                       # keeps the iso-image autodetect default

    github-repo-puller = {
      enable = true;
      repos = { "github:CalamooseLabs/OpenReturn" = "/home/hub/nkc"; };
    };

    # One <app>-restore command per Servarr app.
    arr-restore.instances = {
      sonarr  = { port = 8989; dataDir = "/var/lib/sonarr/.config/NzbDrone";  backupDir = "/mnt/backups/sonarr"; };
      radarr  = { port = 7878; dataDir = "/var/lib/radarr/.config/Radarr";    backupDir = "/mnt/backups/radarr"; };
    };

    plex = {
      backup.enable = true;
      restore.enable = true;
      backupDir = "/mnt/backup";
    };
  };
}
```

Or pull a single script in without the module — via the overlay, or straight from
`packages`:

```nix
# overlay: every script lands in pkgs
nixpkgs.overlays = [ inputs.antlers.overlays.default ];
environment.systemPackages = [ pkgs.rebuild-config pkgs.flash-iso ];

# or one package directly
home.packages = [ inputs.antlers.packages.x86_64-linux.chromium-ephemeral ];
```

## Build

Build or run any script by name (`scripts` is merged into `packages` and each is
an `apps` entry):

```sh
nix build github:CalamooseLabs/antlers#rebuild-config   # → ./result/bin/rebuild-config
nix run   github:CalamooseLabs/antlers#flash-iso
```

`package.nix` is called with `callPackages` (plural), because it returns an
**attrset** of `writeShellApplication` derivations — one per `scripts/<name>.sh`
body — rather than a single derivation; `install-cala-m-os` is additionally
re-wrapped with its bash-completion via `runCommandLocal` + `installShellFiles`.
The flake builds for `x86_64-linux`.
