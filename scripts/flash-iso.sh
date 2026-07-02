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
add_pat_partition() {
  local target="$1" pat="$2"
  local sgdisk mkfsvfat partprobe
  sgdisk=$(command -v sgdisk) || {
    echo "flash-iso: sgdisk not found" >&2
    return 1
  }
  mkfsvfat=$(command -v mkfs.vfat) || {
    echo "flash-iso: mkfs.vfat not found" >&2
    return 1
  }
  partprobe=$(command -v partprobe || true)

  echo ""
  echo "Baking the Proton PAT onto a CALAPAT partition on $target..."
  sleep 1
  sudo "$sgdisk" --move-second-header "$target" >/dev/null
  sudo "$sgdisk" -n 0:0:+32M -t 0:0700 -c 0:CALAPAT "$target" >/dev/null
  if [ -n "$partprobe" ]; then sudo "$partprobe" "$target" >/dev/null 2>&1 || true; fi
  sleep 2

  local part=""
  part=$(lsblk -rno PATH,PARTLABEL "$target" 2>/dev/null | grep -E ' CALAPAT$' | head -1 | cut -d' ' -f1 || true)
  if [ -z "$part" ]; then
    echo "flash-iso: could not locate the new CALAPAT partition; PAT not written." >&2
    return 1
  fi

  sudo "$mkfsvfat" -n CALAPAT "$part" >/dev/null
  local mp=""
  mp=$(mktemp -d)
  sudo mount "$part" "$mp"
  printf '%s' "$pat" | sudo tee "$mp/pat" >/dev/null
  sudo umount "$mp"
  rmdir "$mp" 2>/dev/null || true
  echo "PAT written to CALAPAT — cala-installer on this stick will detect it automatically."
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
