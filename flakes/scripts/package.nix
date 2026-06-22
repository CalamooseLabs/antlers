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
  age-plugin-yubikey,
  systemd,
  sqlite,
  dnsmasq,
  nftables,
  iproute2,
  ungoogled-chromium,
  chromium,
  rpi-imager,
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
    app = mk "install-cala-m-os" [git nix util-linux coreutils];
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
  edit-config = mk "edit-config" [direnv]; # zeditor resolves from the dev-shell PATH
  restore-config = mk "restore-config" [nh nix];
  ssh-key-import = mk "ssh-key-import" [openssh coreutils gnugrep];
  github-repo-puller = mk "github-repo-puller" [git curl jq coreutils];
  chromium-ephemeral = mk "chromium-ephemeral" [ungoogled-chromium coreutils];
  bridge-internet = mk "bridge-internet" [dnsmasq nftables iproute2 coreutils procps gnugrep gawk];
  flash-iso = mk "flash-iso" [git jq util-linux coreutils nix];
  inherit install-cala-m-os;

  # --- Tier 2: host-coupled, parameterized (defaults reproduce current hosts) ---
  gpg-key-import = mk "gpg-key-import" [gnupg coreutils];
  # Provision a spare Yubikey (clone OpenPGP git/SSH keys; fresh FIDO2 + age).
  yubikey-clone = mk "yubikey-clone" [gnupg yubikey-manager age-plugin-yubikey openssh coreutils gnugrep gnused gawk];
  remote-kvm = mk "remote-kvm" [curl chromium coreutils];
  pi-imager = mk "pi-imager" [rpi-imager];
  # One generic Servarr restore tool; the module instantiates <app>-restore wrappers.
  arr-restore = mk "arr-restore" [coreutils findutils util-linux systemd curl gnugrep gnused unzip];
  plex-restore = mk "plex-restore" [coreutils findutils util-linux systemd curl gnugrep];
  plex-backup = mk "plex-backup" [coreutils findutils util-linux sqlite];
}
