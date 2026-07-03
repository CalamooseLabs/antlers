# Optional: --with-pat / --pat-file FILE bakes a Proton Pass PAT onto a small
# CALAPAT-labeled FAT partition carved into the free space AFTER the dd'd ISO.
# cala-installer auto-detects that partition and provisions online hosts without a
# prompt. The reproducible ISO / nix store never see the PAT. No flag = unchanged.
WITH_PAT=0
PAT_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --with-pat)
      WITH_PAT=1
      shift
      ;;
    --pat-file)
      WITH_PAT=1
      PAT_FILE="${2:-}"
      shift 2
      ;;
    --pat-file=*)
      WITH_PAT=1
      PAT_FILE="${1#*=}"
      shift
      ;;
    -h | --help)
      echo "usage: flash-iso [--with-pat] [--pat-file FILE]"
      echo "  --with-pat        after flashing, add a CALAPAT partition holding a Proton PAT (prompted)"
      echo "  --pat-file FILE   read the PAT from FILE instead of prompting (implies --with-pat)"
      exit 0
      ;;
    *)
      echo "flash-iso: unknown argument '$1' (try --help)" >&2
      exit 64
      ;;
  esac
done

# Add a CALAPAT-labeled FAT partition (holding the PAT) in the free space after the
# dd'd ISO. Store-tool paths are resolved via `command -v` so they work under sudo
# (which resets PATH). The ISO's own boot partitions are untouched — we only extend
# the GPT backup header to the true end of the device and carve one new partition.
_target_parts() {
  # Sorted list of the target's partition kernel names (e.g. "sdb1").
  lsblk -rno TYPE,NAME "$1" 2>/dev/null | grep '^part ' | cut -d' ' -f2 | sort || true
}

add_pat_partition() {
  local target="$1" pat="$2"
  local sfdisk mkfsvfat sgdisk partprobe pttype
  sfdisk=$(command -v sfdisk) || {
    echo "flash-iso: sfdisk not found" >&2
    return 1
  }
  mkfsvfat=$(command -v mkfs.vfat) || {
    echo "flash-iso: mkfs.vfat not found" >&2
    return 1
  }
  sgdisk=$(command -v sgdisk || true)
  partprobe=$(command -v partprobe || true)

  echo ""
  echo "Baking the Proton PAT onto a CALAPAT partition on $target..."

  # A desktop may auto-mount the freshly-flashed ISO; unmount everything on the
  # target so the kernel can re-read the partition table after we edit it.
  local _p
  while IFS= read -r _p; do
    if [ -n "$_p" ]; then sudo umount "$_p" 2>/dev/null || true; fi
  done < <(lsblk -rno PATH,TYPE "$target" 2>/dev/null | grep ' part$' | cut -d' ' -f1)
  sleep 1

  # Remember the existing partitions so we can identify the one we add.
  local before after newpart
  before=$(_target_parts "$target")

  # NixOS ISOs are isohybrid MBR ("dos"), not GPT — append an MBR FAT primary in
  # the free space after the image (sfdisk keeps the existing entries + boot code).
  # sgdisk is GPT-only and errors "Invalid partition data!" on these, so branch.
  pttype=$(lsblk -dno PTTYPE "$target" 2>/dev/null | head -1 || true)
  case "$pttype" in
    gpt)
      if [ -z "$sgdisk" ]; then
        echo "flash-iso: sgdisk needed for a GPT device but not found" >&2
        return 1
      fi
      if ! sudo "$sgdisk" --move-second-header "$target" >/dev/null ||
        ! sudo "$sgdisk" -n 0:0:+64M -t 0:0700 -c 0:CALAPAT "$target" >/dev/null; then
        echo "flash-iso: sgdisk failed on $target" >&2
        return 1
      fi
      ;;
    dos | "")
      if ! printf ',64M,c\n' | sudo "$sfdisk" --append "$target" >/dev/null; then
        echo "flash-iso: sfdisk --append failed on $target" >&2
        return 1
      fi
      ;;
    *)
      echo "flash-iso: unsupported partition table '$pttype' on $target" >&2
      return 1
      ;;
  esac

  if [ -n "$partprobe" ]; then sudo "$partprobe" "$target" >/dev/null 2>&1 || true; fi
  # partprobe is asynchronous; settle udev so the new partition node + its label
  # are present before the before/after diff below picks it out.
  command -v udevadm >/dev/null 2>&1 && sudo udevadm settle 2>/dev/null || true
  sleep 2

  after=$(_target_parts "$target")
  newpart=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -1)
  if [ -z "$newpart" ]; then
    echo "flash-iso: could not locate the new partition; PAT not written." >&2
    return 1
  fi
  local part="/dev/$newpart"

  if ! sudo "$mkfsvfat" -n CALAPAT "$part" >/dev/null; then
    echo "flash-iso: mkfs.vfat failed on $part" >&2
    return 1
  fi
  local mp=""
  mp=$(mktemp -d)
  if ! sudo mount "$part" "$mp"; then
    echo "flash-iso: could not mount $part" >&2
    rmdir "$mp" 2>/dev/null || true
    return 1
  fi
  printf '%s' "$pat" | sudo tee "$mp/pat" >/dev/null
  sync
  # Read it straight back so "written" is not a lie: a full stick, a flaky
  # controller, or a bad mkfs would otherwise report success with nothing usable
  # on the partition — the exact silent failure cala-installer then can't explain.
  local readback=""
  readback=$(sudo cat "$mp/pat" 2>/dev/null || true)
  sudo umount "$mp"
  rmdir "$mp" 2>/dev/null || true
  if [ "$readback" != "$pat" ]; then
    echo "flash-iso: PAT readback from $part did not match what was written; the stick may be bad." >&2
    return 1
  fi
  echo "PAT written and verified on CALAPAT ($part) — cala-installer on this stick will detect it automatically."
}

FLASH_ISO_ATTR="${FLASH_ISO_ATTR:-nixosConfigurations.iso.config.system.build.isoImage}"

FLAKE="${FLASH_ISO_FLAKE:-$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || echo "$PWD")}"

echo ""
echo "=== ${FLASH_ISO_TITLE:-Cala-M-OS ISO Flash Tool} ==="
echo ""

# Detect connected USB block devices
mapfile -t _DRIVES < <(
  lsblk -d -J -o NAME,SIZE,MODEL,TRAN,VENDOR 2>/dev/null \
    | jq -r '
        .blockdevices[]
        | select(.tran == "usb")
        | [.name, .size, (.model // .vendor // "USB Drive")]
        | @tsv'
)

if [ "${#_DRIVES[@]}" -eq 0 ]; then
  echo "No USB drives detected. Insert a flash drive and try again."
  exit 1
fi

echo "Available flash drives:"
echo ""
for i in "${!_DRIVES[@]}"; do
  IFS=$'\t' read -r _NAME _SIZE _DESC <<< "${_DRIVES[$i]}"
  printf "  [%d]  /dev/%-8s  %8s  %s\n" "$((i+1))" "$_NAME" "$_SIZE" "$_DESC"
done
echo ""

# Prompt for selection
while true; do
  read -rp "Select drive [1-${#_DRIVES[@]}] or q to quit: " _SEL
  [[ "$_SEL" == "q" || "$_SEL" == "Q" ]] && { echo "Aborted."; exit 0; }
  if [[ "$_SEL" =~ ^[0-9]+$ ]] && (( _SEL >= 1 && _SEL <= ${#_DRIVES[@]} )); then
    break
  fi
  echo "  Invalid selection, try again."
done

IFS=$'\t' read -r _TNAME _TSIZE _TDESC <<< "${_DRIVES[$(( _SEL - 1 ))]}"
_TARGET="/dev/$_TNAME"

echo ""
printf "  Target : %s  (%s — %s)\n" "$_TARGET" "$_TSIZE" "$_TDESC"
echo ""
echo "  WARNING: ALL DATA ON $_TARGET WILL BE PERMANENTLY DESTROYED."
echo ""
read -rp "  Type YES to confirm and start the build: " _CONFIRM
[[ "$_CONFIRM" != "YES" ]] && { echo "Aborted."; exit 0; }

# Build the ISO
echo ""
echo "Building ISO..."
echo ""
nix build "$FLAKE#$FLASH_ISO_ATTR" \
  --out-link "$FLAKE/result" \
  --print-build-logs

_ISO=$(find "$FLAKE/result/iso/" -maxdepth 1 -name "*.iso" 2>/dev/null | head -1)
[ -n "$_ISO" ] || { echo "Error: ISO not found after build."; exit 1; }

echo ""
echo "ISO: $_ISO"
echo ""

# Unmount any mounted partitions on the target before writing
while IFS= read -r _PART; do
  [[ "$_PART" == "$_TARGET" ]] && continue
  if findmnt -n "$_PART" &>/dev/null; then
    echo "Unmounting $_PART..."
    sudo umount "$_PART" 2>/dev/null || true
  fi
done < <(lsblk -ln -o PATH "$_TARGET" | tail -n +2)

# Flash with dd — shows live progress
echo "Writing to $_TARGET (do not remove the drive)..."
sudo dd if="$_ISO" of="$_TARGET" bs=4M status=progress oflag=sync

# Optionally bake a Proton PAT onto a CALAPAT partition after the image.
if [ "$WITH_PAT" -eq 1 ]; then
  _PAT=""
  if [ -n "$PAT_FILE" ]; then
    [ -r "$PAT_FILE" ] || {
      echo "flash-iso: cannot read PAT file '$PAT_FILE'" >&2
      exit 1
    }
    _PAT=$(cat "$PAT_FILE")
  else
    read -rsp "Paste the Proton Pass PAT (pst_...::key) to bake onto the USB: " _PAT
    echo ""
  fi
  if [ -n "$_PAT" ]; then
    add_pat_partition "$_TARGET" "$_PAT" ||
      echo "flash-iso: PAT step failed; the USB still boots — add the PAT manually." >&2
    unset _PAT
  else
    echo "flash-iso: empty PAT; skipping the CALAPAT partition." >&2
  fi
fi

echo ""
echo "Done. $_TARGET is ready to boot ${FLASH_ISO_TITLE:-Cala-M-OS}."
echo ""
