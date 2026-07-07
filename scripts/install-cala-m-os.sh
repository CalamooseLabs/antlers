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

# Always re-check upstream freshness so a re-run picks up newly-pushed commits
# instead of Nix's cached tarball (tarball-ttl defaults to 1h). This makes the
# version read + disko fetch below resolve the current default-branch HEAD. Cheap:
# it re-validates via ETag and only re-downloads when the content actually changed.
export NIX_CONFIG="tarball-ttl = 0"

# Flake reference used for the version read AND the disko destroy/format/mount.
FLAKE_REF="${INSTALL_FLAKE_REF:-github:CalamooseLabs/cala-m-os}"
# Git clone URL written into /mnt/etc/nixos for the minimal install pass.
CLONE_URL="${INSTALL_CLONE_URL:-https://github.com/calamooselabs/cala-m-os.git}"
# Target config path on the installed system.
TARGET_NIXOS_DIR="${INSTALL_TARGET_DIR:-/etc/nixos}"
# Where the config is mounted during install (under /mnt).
MNT_NIXOS_DIR="${INSTALL_MNT_DIR:-/mnt/etc/nixos}"
# Filesystem root disko mounts the target on (parent of $MNT_NIXOS_DIR). The
# Proton Pass seed lands under here before the first activation (Step Five).
INSTALL_MNT_ROOT="${INSTALL_MNT_ROOT:-/mnt}"
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
# Gate the unattended full wipe behind the host's calamoose.install.wipeAllDisks
# (default false) so dual-boot / partially-owned machines are never auto-wiped.
# Distinguish a genuine `false` from an EVAL ERROR (option absent on the ref, host
# not pushed, network) — otherwise a wipeAllDisks=true host that simply isn't
# reachable would be told "set it to true" when it already is.
if ! WIPE_ALL=$(nix eval --impure "$FLAKE_REF#nixosConfigurations.$HOST_FLAKE.config.calamoose.install.wipeAllDisks" 2>/tmp/wipeAllDisks.err); then
  echo "ERROR: could not evaluate calamoose.install.wipeAllDisks for '$HOST_FLAKE' from '$FLAKE_REF'." >&2
  echo "  Is the option defined and this host committed/pushed at that ref? nix said:" >&2
  sed 's/^/    /' /tmp/wipeAllDisks.err >&2
  exit 1
fi
if [ "$WIPE_ALL" = "true" ]; then
  disko --mode destroy,format,mount --flake "$FLAKE_REF#$HOST_FLAKE" --yes-wipe-all-disks
elif [ "${INSTALL_SKIP_DISKO:-0}" = "1" ]; then
  echo "  [install] calamoose.install.wipeAllDisks=false + INSTALL_SKIP_DISKO=1:"
  echo "  [install] assuming the target is already partitioned and mounted at $INSTALL_MNT_ROOT."
else
  echo "ERROR: calamoose.install.wipeAllDisks=false for '$HOST_FLAKE' (the default)." >&2
  echo "  Refusing to auto-partition — this host may dual-boot or own only some disks." >&2
  echo "    • If NixOS owns every disk here, set calamoose.install.wipeAllDisks = true and re-run." >&2
  echo "    • Otherwise partition/mount the target yourself, then re-run with INSTALL_SKIP_DISKO=1." >&2
  exit 1
fi
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
# Seed a Proton Pass session/PAT onto the target BEFORE the first activation.
# Step Five runs `nixos-enter -- chpasswd`, and nixos-enter runs the target's
# `activate` first. On an online (Proton Pass) host that activation fetches
# secrets fail-closed; with an empty /var/lib/proton-pass-cli it aborts before
# the `users` snippet (which creates the declared accounts) and before the
# /run/current-system symlink — so chpasswd can neither resolve nor find the
# users (the classic exit 127). Seeding here — after the disk is mounted
# (Step One) and before Step Five — lets that activation mint a session from
# the PAT and succeed. Inert unless the installer staged a session/PAT.
# tmpfiles' `d` rule (created at first boot) is non-destructive to this content.
if [ "${INSTALL_PROTON_SEED:-0}" = "1" ]; then
  echo "Seeding Proton Pass session onto the target..."
  _proton_tgt="$INSTALL_MNT_ROOT/var/lib/proton-pass-cli"
  _proton_src="${INSTALL_PROTON_SESSION_DIR:-/var/lib/proton-pass-cli}"
  install -d -m700 "$_proton_tgt"
  if [ -d "$_proton_src" ]; then
    cp -a "$_proton_src/." "$_proton_tgt/" 2>/dev/null || true
  fi
  if [ -n "${INSTALL_PROTON_PAT_FILE:-}" ] && [ -r "$INSTALL_PROTON_PAT_FILE" ]; then
    (umask 077; cp -f "$INSTALL_PROTON_PAT_FILE" "$_proton_tgt/pat")
    chmod 600 "$_proton_tgt/pat"
  fi
  chown -R root:root "$_proton_tgt" 2>/dev/null || true
  echo "Proton Pass session seeded."
  echo
fi
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
