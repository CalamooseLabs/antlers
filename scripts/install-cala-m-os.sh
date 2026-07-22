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

echo "Step Zero: Data Disks (preserve or reformat)"
# Data disks are declared per-host in calamoose.install.dataDisks and are NOT
# part of disko, so a reinstall never wipes them. We handle them HERE, BEFORE the
# main disko wipe in Step One, because disko formats and mounts the OS disk by
# /dev/disk/by-partlabel/disk-main-* — a preserved data drive that still carries
# those same labels (e.g. from a previous NixOS install) would make by-partlabel
# ambiguous across two disks, so disko could format/mount the WRONG disk. Any
# clearing must therefore happen before disko runs. Only an explicit interactive
# "wipe" ever destroys data; a non-interactive run always keeps.
# The list is emitted by nix as TAB-separated "device<TAB>label<TAB>fsType" lines.
if ! DATA_DISKS=$(nix eval --raw --impure \
  --apply 'ds: builtins.concatStringsSep "\n" (map (d: d.device + "\t" + d.label + "\t" + d.fsType) ds)' \
  "$FLAKE_REF#nixosConfigurations.$HOST_FLAKE.config.calamoose.install.dataDisks" \
  2>/tmp/dataDisks.err); then
  echo "  [install] could not read calamoose.install.dataDisks; assuming none. nix said:" >&2
  sed 's/^/    /' /tmp/dataDisks.err >&2
  DATA_DISKS=""
fi
if [ -z "$DATA_DISKS" ]; then
  echo "  [install] No data disks declared for '$HOST_FLAKE'; nothing to do."
else
  # Iterate the disk list on FD 3 so the interactive prompt below still reads
  # from the terminal (FD 0) rather than consuming the disk list.
  while IFS=$'\t' read -r _dev _label _fstype <&3; do
    [ -z "$_dev" ] && continue
    echo
    echo "  Data disk: $_dev"
    echo "    target: label '$_label', filesystem $_fstype"
    if [ ! -e "$_dev" ]; then
      echo "    NOT present on this machine — skipping (nothing wiped)." >&2
      continue
    fi
    _real=$(readlink -f "$_dev")
    _curlabel=$(blkid -s LABEL -o value "$_dev" 2>/dev/null || true)
    _stale=$(lsblk -rno PARTLABEL "$_real" 2>/dev/null | grep -c '^disk-main-' || true)
    if [ "$_curlabel" = "$_label" ]; then
      _default=K
      echo "    Already formatted as '$_label' — its data will be KEPT."
    elif [ "${_stale:-0}" -gt 0 ]; then
      _default=W
      echo "    WARNING: this disk still carries the OS layout's partitions"
      echo "    (disk-main-*). They CLASH with the OS disk and would make /"
      echo "    ambiguous, so it cannot be preserved as-is — it must be"
      echo "    reformatted (recommended: W) before the install can proceed."
    else
      _default=K
      echo "    No '$_label' filesystem found — not yet set up as the data drive."
    fi
    # Only an interactive terminal may trigger a wipe; a non-interactive run
    # always keeps the disk (never destroys data unattended).
    if [ -t 0 ] && [ "${INSTALL_DATA_NONINTERACTIVE:-0}" != "1" ]; then
      read -rp "    [K]eep or [W]ipe & reformat this disk? [default $_default] " _ans || _ans=""
      _ans=${_ans:-$_default}
    else
      _ans=$_default
      [ "$_ans" = W ] && _ans=K
      echo "    Non-interactive — keeping the disk untouched."
    fi
    case "$_ans" in
    [Ww]*)
      echo "    Wiping $_real and creating $_fstype filesystem '$_label'..."
      wipefs -a "$_real" >/dev/null
      sgdisk --zap-all "$_real" >/dev/null 2>&1 || true
      case "$_fstype" in
      ext4) mkfs.ext4 -F -L "$_label" "$_real" ;;
      xfs) mkfs.xfs -f -L "$_label" "$_real" ;;
      *)
        echo "    ERROR: unsupported fsType '$_fstype' (add its mkfs + tool)." >&2
        exit 1
        ;;
      esac
      # Make the fresh filesystem writable by the primary user (uid 1000 = hub).
      # Mount the device we just formatted DIRECTLY (no need to wait on udev's
      # by-label symlink), and never let a transient mount failure abort the
      # install now that the disk is already formatted.
      _tmp=$(mktemp -d)
      if mount "$_real" "$_tmp"; then
        chown 1000:100 "$_tmp"
        umount "$_tmp"
        echo "    Done — '$_label' is ready and owned by uid 1000."
      else
        echo "    WARN: formatted OK but could not mount to set ownership;" >&2
        echo "    run 'sudo chown hub:users /data' after the first boot." >&2
      fi
      rmdir "$_tmp" 2>/dev/null || true
      ;;
    *)
      # KEEP. If the disk still carries clashing disk-main-* partlabels, keeping
      # it would leave / (and resume=) ambiguous across two disks at every boot.
      # Refuse rather than proceed into a corrupt/ambiguous install.
      if [ "${_stale:-0}" -gt 0 ]; then
        echo "    ERROR: refusing to KEEP $_real — it still carries disk-main-*" >&2
        echo "    partlabels that clash with the OS disk and would make / ambiguous." >&2
        echo "    Re-run and choose W to reformat it, or clear the labels yourself" >&2
        echo "    (e.g. 'sgdisk --zap-all $_real') before installing." >&2
        exit 1
      fi
      echo "    Keeping $_real untouched."
      ;;
    esac
  done 3<<EOF
$DATA_DISKS
EOF
fi
echo "Step Zero Completed!"
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

# Verify the generation Step Four just made the boot default is actually
# bootable BEFORE telling the user to reboot. An interrupted bootloader
# install (power blip, OOM kill) can leave a loader entry whose kernel/initrd
# never finished copying to the ESP, or whose toplevel never fully realized —
# the next boot then dies in stage-1 with "no usable init" and a blank screen.
# Catch that here, loudly, while we still have a live installer shell.
echo "Verifying the new boot entry..."
_esp="$INSTALL_MNT_ROOT/boot"
# systemd-boot names entries by CONTENT HASH (nixos-<sha256>.conf), not by
# generation number, so don't glob — read the entry it will actually boot from
# loader.conf ("preferred" wins over "default" when boot counting is on; the
# default may be a nixos-* glob fallback in that mode). The `|| true` keeps a
# missing/unreadable loader.conf on the diagnostic path below instead of dying
# silently under set -e/pipefail.
_default=$(awk '$1 == "preferred" {p = $2} $1 == "default" {d = $2} END {print (p != "" ? p : d)}' "$_esp/loader/loader.conf" 2>/dev/null || true)
_entry=""
case $_default in
"") ;; # no loader.conf / no default recorded — caught below
*\**)
  # Boot-counting glob fallback: any matching entry proves the install landed;
  # pick the newest. (find exits 0 on an existing dir even with zero matches.)
  if [ -d "$_esp/loader/entries" ]; then
    _entry=$(find "$_esp/loader/entries" -maxdepth 1 -name "$_default" -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n1 | cut -d' ' -f2- || true)
  fi
  ;;
*)
  _entry="$_esp/loader/entries/$_default"
  ;;
esac
if [ -z "$_entry" ] || [ ! -s "$_entry" ]; then
  echo "ERROR: systemd-boot has no usable default entry under $_esp (loader.conf default: '${_default:-<none>}')." >&2
  echo "  The bootloader install did not complete — re-run Step Four:" >&2
  echo "    nixos-enter -- nixos-rebuild boot --flake $TARGET_NIXOS_DIR#$HOST_FLAKE --impure" >&2
  exit 1
fi
# Every kernel/initrd path the entry references must exist on the ESP, non-empty.
while read -r _f; do
  if [ ! -s "$_esp$_f" ]; then
    echo "ERROR: boot entry $(basename "$_entry") references $_f, which is missing or empty on the ESP." >&2
    # Remove the bad copy first: the bootloader installer skips ESP files that
    # already exist, so a re-run would otherwise leave the empty file in place.
    rm -f "$_esp$_f"
    echo "  Removed the bad copy; re-run Step Four to re-copy it:" >&2
    echo "    nixos-enter -- nixos-rebuild boot --flake $TARGET_NIXOS_DIR#$HOST_FLAKE --impure" >&2
    exit 1
  fi
done < <(awk '$1 == "linux" || $1 == "initrd" {print $2}' "$_entry")
# The init= the entry hands to stage-1 must exist in the target store.
_init=$(sed -n 's/^options .*init=\([^ ]*\).*/\1/p' "$_entry")
if [ -z "$_init" ] || [ ! -e "$INSTALL_MNT_ROOT$_init" ]; then
  echo "ERROR: boot entry $(basename "$_entry") points at init=${_init:-<none>}, which does not exist under $INSTALL_MNT_ROOT." >&2
  echo "  The system toplevel never fully realized — re-run Step Four:" >&2
  echo "    nixos-enter -- nixos-rebuild boot --flake $TARGET_NIXOS_DIR#$HOST_FLAKE --impure" >&2
  exit 1
fi
sync
echo "Boot entry $(basename "$_entry") verified: kernel, initrd, and init all present."
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
