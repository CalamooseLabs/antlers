config_path="${CONFIG_PATH:-/etc/nixos}"

# Preserve the original `set -eux` command-trace behavior (the antlers builder
# injects only `set -euo pipefail`, without -x).
set -x

if [ -n "$(git -C "$config_path" status --porcelain)" ]; then
  lazygit -p "$config_path"
fi

nh os switch "$config_path"

