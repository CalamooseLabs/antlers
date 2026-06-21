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
echo ""
echo "Done. $_TARGET is ready to boot ${FLASH_ISO_TITLE:-Cala-M-OS}."
echo ""
