if [ -z "${1:-}" ]; then
  echo "Usage: $0 <flake> [machine]"
  echo "  <flake>    host configuration to install (e.g. devbox)"
  echo "  [machine]  optional machine to build onto instead of the host's"
  echo "             default (e.g. MS-01). Persisted for future rebuilds."
  exit 1
fi
HOST_FLAKE=$1

# Optional machine override (e.g. build 'devbox' onto an 'MS-01' machine).
# Exported so disko (which evaluates the flake with --impure) and the
# install passes all resolve to the overridden machine.
MACHINE_OVERRIDE=${2:-}
export MACHINE_OVERRIDE
if [ -n "$MACHINE_OVERRIDE" ]; then
  echo "Machine override: building '$HOST_FLAKE' onto machine '$MACHINE_OVERRIDE'"
  echo
fi

# Flake reference used for the version read AND the disko destroy/format/mount.
FLAKE_REF="${INSTALL_FLAKE_REF:-github:CalamooseLabs/cala-m-os}"
# Git clone URL written into /mnt/etc/nixos for the minimal install pass.
CLONE_URL="${INSTALL_CLONE_URL:-https://github.com/calamooselabs/cala-m-os.git}"
# Target config path on the installed system.
TARGET_NIXOS_DIR="${INSTALL_TARGET_DIR:-/etc/nixos}"
# Where the config is mounted during install (under /mnt).
MNT_NIXOS_DIR="${INSTALL_MNT_DIR:-/mnt/etc/nixos}"
# DisplayLink prefetch zip (path is relative to each nixos dir).
PREFETCH_REL="${INSTALL_PREFETCH_REL:-prefetch/displaylink-620.zip}"
# Accounts whose passwords are set in Step Five.
PASSWD_USERS="${INSTALL_PASSWD_USERS:-hub root}"

# Read this host's version mark from the flake (best-effort).
VERSION=$(nix eval --raw --impure "$FLAKE_REF#nixosConfigurations.$HOST_FLAKE.config.${INSTALL_VERSION_ATTR:-calamoose.version}" 2>/dev/null || echo "unknown")
echo "=================================================="
echo " Installing Cala-M-OS host '$HOST_FLAKE' — version $VERSION"
echo "=================================================="
echo

echo "Step One: Erasing and Formatting Disk"
# disko is shipped on the installer ISO's PATH (iso/default.nix systemPackages),
# so this stays offline-capable rather than fetching disko over the network.
disko --mode destroy,format,mount --flake "$FLAKE_REF#$HOST_FLAKE" --yes-wipe-all-disks
echo "Step One Completed!"
echo
echo "Step Two: Installing Minimal NixOS Configuration"
mkdir "$MNT_NIXOS_DIR" -p
git clone "$CLONE_URL" "$MNT_NIXOS_DIR"
INITIAL_INSTALL_MODE=1 nixos-install --flake "$MNT_NIXOS_DIR#$HOST_FLAKE" --impure --no-root-password
echo "Step Two Completed!"
echo
echo  "Step Three: Prefetching"
nix-prefetch-url "file://$MNT_NIXOS_DIR/$PREFETCH_REL"
nixos-enter -- nix-prefetch-url "file://$TARGET_NIXOS_DIR/$PREFETCH_REL"
echo "Step Three Completed!"
echo
# Persist the machine override so future rebuilds on this box keep
# targeting the overridden machine (the env var is gone after install).
if [ -n "$MACHINE_OVERRIDE" ]; then
  printf '{\n  %s = "%s";\n}\n' "$HOST_FLAKE" "$MACHINE_OVERRIDE" > "$MNT_NIXOS_DIR/machine-override.nix"
fi
echo "Step Four: Building Cala-M-OS"
nixos-enter -- env MACHINE_OVERRIDE="$MACHINE_OVERRIDE" nixos-rebuild boot --flake "$TARGET_NIXOS_DIR#$HOST_FLAKE" --impure
echo "Step Four Completed!"
echo
echo "Step Five: Setting User Passwords"
read -rsp "Enter password for ${PASSWD_USERS// /, }: " PASSWORD
echo
read -rsp "Confirm password: " PASSWORD_CONFIRM
echo
if [ "$PASSWORD" != "$PASSWORD_CONFIRM" ]; then
  echo "Error: Passwords do not match!"
  exit 1
fi
# shellcheck disable=SC2086  # intentional word-split of the space-separated user list
for _u in $PASSWD_USERS; do
  printf '%s\n' "$_u:$PASSWORD"
done | nixos-enter -- chpasswd
unset PASSWORD PASSWORD_CONFIRM
echo "Step Five Completed!"
echo
echo "=================================================="
echo " Cala-M-OS host '$HOST_FLAKE' — version $VERSION installed."
echo " Please reboot the system."
echo "=================================================="
exit
