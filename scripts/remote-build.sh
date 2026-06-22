# remote-build — pull the NixOS config from its git remote, then rebuild.
#
# The "remote" is the git remote: fetch the latest committed config and apply it,
# non-interactively (unlike `rebuild-config`, which stops at lazygit for *local*
# changes). Handy for headless / over-SSH rebuilds where the source of truth is
# the upstream repo.
#
# git is invoked through `nix run nixpkgs#git` so the script carries no git in its
# own closure and always uses the host's nixpkgs git — only `nix` (and `nh`) need
# to be on PATH, so it runs straight from the flake too:
#   nix run github:CalamooseLabs/antlers#remote-build
#
# Override the config path with REMOTE_BUILD_PATH (default /etc/nixos).

config_path="${REMOTE_BUILD_PATH:-/etc/nixos}"

# Trace each step (the antlers builder injects only `set -euo pipefail`, no -x);
# `set -e` means a failed pull aborts before we ever switch.
set -x

nix run nixpkgs#git -- -C "$config_path" pull
nh os switch "$config_path"
