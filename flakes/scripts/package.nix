# antlers reusable script collection.
#
# Each command is a thin `writeShellApplication` (shebang + `set -euo pipefail`
# + a build-time shellcheck gate) wrapping a shell body that lives in the repo's
# top-level `scripts/` directory. The bodies are host-agnostic: every value that
# used to be hardcoded in the NixOS config is read from an env var with the
# original value as its default (e.g. `${CONFIG_PATH:-/etc/nixos}`), so:
#
#   * `nix run github:CalamooseLabs/antlers#rebuild-config`     uses the defaults
#   * `CONFIG_PATH=/srv/cfg rebuild-config`                     overrides at runtime
#   * programs.antlers-scripts.rebuild-config.configPath = …    bakes a default in
#     (see ./module.nix — it wraps the binary with `--set-default`)
#
# This returns an attrset of derivations; the root flake exposes each as its own
# package/app and via the overlay.
{
  lib,
  writeShellApplication,
  runCommandLocal,
  installShellFiles,
  # runtime dependencies prepended to PATH (system tools like sudo/systemctl/
  # nixos-install are intentionally NOT listed — writeShellApplication keeps the
  # inherited $PATH, so those resolve from the host/ISO they run on).
  coreutils,
  findutils,
  gnugrep,
  gnused,
  gawk,
  procps,
  util-linux,
  unzip,
  git,
  curl,
  jq,
  nix,
  nh,
  lazygit,
  direnv,
  openssh,
  gnupg,
  yubikey-manager,
  systemd,
  sqlite,
  dnsmasq,
  nftables,
  iproute2,
  ungoogled-chromium,
  chromium,
  rpi-imager,
  gum,
  pciutils,
  usbutils,
  dmidecode,
  nvme-cli,
  lshw,
  gptfdisk,
  dosfstools,
  parted,
  e2fsprogs,
  xfsprogs,
}: let
  scriptsDir = ../../scripts;

  mk = name: runtimeInputs:
    writeShellApplication {
      inherit name runtimeInputs;
      text = builtins.readFile (scriptsDir + "/${name}.sh");
    };

  # install-cala-m-os ships a companion bash-completion (host + machine names),
  # so it is bundled like the `antlers` CLI: the script plus its completion under
  # one derivation.
  install-cala-m-os = let
    # util-linux → blkid/lsblk/wipefs/mount; gptfdisk → sgdisk; e2fsprogs/xfsprogs
    # → mkfs.{ext4,xfs} for the Step One-B data-disk (re)format.
    app = mk "install-cala-m-os" [git nix util-linux coreutils findutils gawk gnused gnugrep gptfdisk e2fsprogs xfsprogs];
    completion = scriptsDir + "/install-cala-m-os.completion.bash";
  in
    runCommandLocal "install-cala-m-os" {
      nativeBuildInputs = [installShellFiles];
      meta = app.meta or {};
    } ''
      install -Dm755 ${app}/bin/install-cala-m-os "$out/bin/install-cala-m-os"
      installShellCompletion --cmd install-cala-m-os --bash ${completion}
    '';
in {
  # --- Tier 1: clean, portable CLIs ---
  rebuild-config = mk "rebuild-config" [git lazygit nh];
  # remote-build pulls the config from its git remote, then rebuilds. git comes
  # via `nix run nixpkgs#git` inside the body, so only nh + nix are baked in.
  remote-build = mk "remote-build" [nh nix];
  edit-config = mk "edit-config" [direnv]; # zeditor resolves from the dev-shell PATH
  restore-config = mk "restore-config" [nh nix];
  ssh-key-import = mk "ssh-key-import" [openssh coreutils gnugrep];
  github-repo-puller = mk "github-repo-puller" [git curl jq coreutils];
  chromium-ephemeral = mk "chromium-ephemeral" [ungoogled-chromium coreutils];
  bridge-internet = mk "bridge-internet" [dnsmasq nftables iproute2 coreutils procps gnugrep gawk];
  # flash-iso gains --with-pat: after dd it carves a CALAPAT FAT partition holding a
  # Proton PAT (sgdisk/mkfs.vfat/partprobe), which cala-installer auto-detects.
  flash-iso = mk "flash-iso" [git jq util-linux coreutils nix gnugrep gptfdisk dosfstools parted];
  inherit install-cala-m-os;
  # Auto-running gum TUI front-end for the ISO. Thin wrapper over
  # install-cala-m-os: network wait, hardware inspection, host/machine selection
  # (incl. a generated "self" profile), and an online-secrets login prompt.
  # Inspection tools are baked here; install-cala-m-os / proton-secrets / disko /
  # nixos-generate-config / nmtui resolve from the ISO's inherited PATH.
  cala-installer = mk "cala-installer" [gum pciutils usbutils iproute2 util-linux dmidecode nvme-cli lshw coreutils nix git];

  # --- Tier 2: host-coupled, parameterized (defaults reproduce current hosts) ---
  gpg-key-import = mk "gpg-key-import" [gnupg coreutils];
  # Generate a fresh on-card SSH key (PIV) + OpenPGP signing key on a YubiKey.
  yubikey-provision = mk "yubikey-provision" [yubikey-manager openssh gnupg coreutils gnused];
  # Provision a YubiKey from scratch with an on-card OpenPGP identity for a GitHub
  # account (present-but-no-touch), and print the Proton Pass / NixOS / GitHub follow-ups.
  yubikey-github-bootstrap = mk "yubikey-github-bootstrap" [yubikey-manager gnupg coreutils gnused gawk];
  remote-kvm = mk "remote-kvm" [curl chromium coreutils];
  pi-imager = mk "pi-imager" [rpi-imager];
  # One generic Servarr restore tool; the module instantiates <app>-restore wrappers.
  arr-restore = mk "arr-restore" [coreutils findutils util-linux systemd curl gnugrep gnused unzip];
  plex-restore = mk "plex-restore" [coreutils findutils util-linux systemd curl gnugrep];
  plex-backup = mk "plex-backup" [coreutils findutils util-linux sqlite];
}
