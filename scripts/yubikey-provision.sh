# yubikey-provision — import an existing SSH private key onto a YubiKey (PIV).
#
# This does NOT generate a device-bound key. It takes a private key you already
# have (e.g. ~/.ssh/id_ed25519) and writes it into a PIV slot on the target
# YubiKey so the key becomes hardware-backed. A self-signed certificate is then
# generated for that slot, because the SSH PKCS#11 tooling reads the public key
# from the slot's certificate.
#
# The key is normalised to an unencrypted PKCS#8 PEM in a temp dir (shredded on
# exit): `ykman piv keys import` takes PEM/DER, and `openssl pkey -pubout`
# derives the cert's public key from the same file. Works for ed25519 (needs
# YubiKey firmware >= 5.7), RSA, and ECDSA (P-256/384).
#
# Every host value is an env var with a default; programs.antlers-scripts.
# yubikey-provision bakes per-host defaults via makeWrapper.

SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/id_ed25519}"
PIV_SLOT="${PIV_SLOT:-9a}"
PIV_PIN_POLICY="${PIV_PIN_POLICY:-once}"
PIV_TOUCH_POLICY="${PIV_TOUCH_POLICY:-cached}"
CERT_SUBJECT="${CERT_SUBJECT:-}"
CONFIG_PATH="${CONFIG_PATH:-/etc/nixos}"

usage() {
  cat <<EOF
yubikey-provision — import an existing SSH private key into a YubiKey PIV slot.

Usage: yubikey-provision [options]

  --key FILE            SSH/PEM private key to import (default: \$SSH_KEY_FILE)
  --slot SLOT           PIV slot to write (default: $PIV_SLOT; 9a=Authentication)
  --pin-policy POLICY   default|never|once|always (default: $PIV_PIN_POLICY)
  --touch-policy POLICY default|never|always|cached (default: $PIV_TOUCH_POLICY)
  --subject DN          certificate subject, RFC 4514 (default: from key comment)
  -h, --help            this help

The key is converted to an unencrypted PKCS#8 PEM in a shredded temp dir, written
to the slot, and given a self-signed cert. ed25519 needs YubiKey firmware >= 5.7;
RSA-2048 and ECDSA P-256/384 work on older keys.

Env (defaults shown, all overridable):
  SSH_KEY_FILE=$SSH_KEY_FILE
  PIV_SLOT=$PIV_SLOT
  PIV_PIN_POLICY=$PIV_PIN_POLICY   PIV_TOUCH_POLICY=$PIV_TOUCH_POLICY
  CERT_SUBJECT=${CERT_SUBJECT:-<from key comment>}
  CONFIG_PATH=$CONFIG_PATH
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --key) SSH_KEY_FILE="${2:?--key needs a path}"; shift ;;
    --slot) PIV_SLOT="${2:?--slot needs a value}"; shift ;;
    --pin-policy) PIV_PIN_POLICY="${2:?--pin-policy needs a value}"; shift ;;
    --touch-policy) PIV_TOUCH_POLICY="${2:?--touch-policy needs a value}"; shift ;;
    --subject) CERT_SUBJECT="${2:?--subject needs a value}"; shift ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$(id -u)" -eq 0 ]; then
  echo "Run yubikey-provision as your user, not root — it reads your ~/.ssh key." >&2
  exit 1
fi

# ---- helpers ---------------------------------------------------------------

die() {
  echo "ERROR: $*" >&2
  exit 1
}

note() { echo "  $*"; }

hr() { echo "------------------------------------------------------------------------"; }

have() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  local ans
  read -r -p "$1 [y/N] " ans || return 1
  case "$ans" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# Shred + remove the temp key material. Safe to call before TMPD is set.
cleanup() {
  if [ -n "${TMPD:-}" ] && [ -d "$TMPD" ]; then
    shred -u "$TMPD"/* 2>/dev/null || true
    rm -rf "$TMPD"
  fi
}

# Serials of every connected YubiKey, one per line.
card_serials() { ykman list --serials 2>/dev/null || true; }

# One-line human label for a serial.
card_label() {
  local serial="$1" info type fw
  info="$(ykman --device "$serial" info 2>/dev/null || true)"
  type="$(printf '%s\n' "$info" | sed -n 's/^Device type:[[:space:]]*//p')"
  fw="$(printf '%s\n' "$info" | sed -n 's/^Firmware version:[[:space:]]*//p')"
  echo "${type:-YubiKey} (SN $serial${fw:+, fw $fw})"
}

# Print a numbered menu of serials and read a choice into the named variable.
choose_serial() {
  local prompt="$1" __out="$2"
  shift 2
  local serials=("$@") i choice
  for i in "${!serials[@]}"; do
    printf "  %d) %s\n" "$((i + 1))" "$(card_label "${serials[$i]}")"
  done
  while :; do
    read -r -p "$prompt (1-${#serials[@]}): " choice || die "aborted"
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#serials[@]}" ]; then
      printf -v "$__out" '%s' "${serials[$((choice - 1))]}"
      return 0
    fi
    echo "  Enter a number between 1 and ${#serials[@]}."
  done
}

# ---- preflight -------------------------------------------------------------

for t in ykman ssh-keygen openssl; do
  have "$t" || die "$t not found on PATH."
done

[ -r "$SSH_KEY_FILE" ] || die "SSH private key not readable: $SSH_KEY_FILE (set --key or SSH_KEY_FILE)."

mapfile -t SERIALS < <(card_serials)
[ "${#SERIALS[@]}" -ge 1 ] || die "No YubiKey detected. Insert it (is pcscd running?) and retry."

hr
echo "Connected YubiKeys:"
for s in "${SERIALS[@]}"; do note "$(card_label "$s")"; done
hr

# Pick the target (the key we provision).
TARGET=""
if [ "${#SERIALS[@]}" -eq 1 ]; then
  TARGET="${SERIALS[0]}"
  echo "Using the only connected YubiKey as the TARGET:"
  note "$(card_label "$TARGET")"
else
  choose_serial "Which YubiKey is the TARGET (to write the key onto)?" TARGET "${SERIALS[@]}"
fi
echo "Target: $(card_label "$TARGET")"

echo
echo "Target PIV state:"
ykman --device "$TARGET" piv info 2>/dev/null | sed 's/^/  /' || true

echo
echo "This IMPORTS $SSH_KEY_FILE into PIV slot $PIV_SLOT on the target,"
echo "OVERWRITING any key/certificate already in that slot."
confirm "Continue?" || die "aborted"

# ---- prepare the key material (temp, shredded on exit) ---------------------

TMPD="$(mktemp -d)"
chmod 700 "$TMPD"
trap cleanup EXIT

cp -- "$SSH_KEY_FILE" "$TMPD/key"
chmod 600 "$TMPD/key"

echo
echo "Normalising the key to PKCS#8 PEM (enter its passphrase if prompted)…"
ssh-keygen -p -N "" -m PKCS8 -f "$TMPD/key" >/dev/null \
  || die "could not read/convert the key (wrong passphrase?)."

openssl pkey -in "$TMPD/key" -pubout -out "$TMPD/pub.pem" 2>/dev/null \
  || die "could not derive the public key from $SSH_KEY_FILE."

SSH_PUB="$(ssh-keygen -y -f "$TMPD/key")" || die "could not derive the SSH public key."

# Carry the original key comment onto the printed pubkey and into the cert subject.
comment=""
if [ -r "$SSH_KEY_FILE.pub" ]; then
  read -r _ _ comment <"$SSH_KEY_FILE.pub" || comment=""
fi
[ -n "$comment" ] && SSH_PUB="$SSH_PUB $comment"

if [ -z "$CERT_SUBJECT" ]; then
  cn="${comment:-$(basename -- "$SSH_KEY_FILE")}"
  cn="$(printf '%s' "$cn" | tr -d ',+=<>;"')" # strip RFC 4514 special chars
  [ -n "$cn" ] || cn="yubikey-ssh"
  CERT_SUBJECT="CN=$cn"
fi

# ---- write to the card -----------------------------------------------------

echo
echo "Importing into slot $PIV_SLOT (pin-policy=$PIV_PIN_POLICY touch-policy=$PIV_TOUCH_POLICY)…"
note "you'll be prompted for the card PIN and management key"
ykman --device "$TARGET" piv keys import \
  --pin-policy "$PIV_PIN_POLICY" --touch-policy "$PIV_TOUCH_POLICY" \
  "$PIV_SLOT" "$TMPD/key" \
  || die "ykman piv keys import failed (ed25519 needs firmware >= 5.7; check slot/PIN/management key)."

echo "Generating a self-signed certificate for slot $PIV_SLOT (subject $CERT_SUBJECT)…"
ykman --device "$TARGET" piv certificates generate \
  -s "$CERT_SUBJECT" -d 3650 "$PIV_SLOT" "$TMPD/pub.pem" \
  || die "ykman piv certificates generate failed."

# ---- report ----------------------------------------------------------------

echo
hr
echo "Done — slot $PIV_SLOT on $(card_label "$TARGET") now holds your SSH key."
hr
echo "Slot now reports:"
ykman --device "$TARGET" piv info 2>/dev/null | sed 's/^/  /' || true

echo
echo "SSH public key served from the card:"
note "$SSH_PUB"

echo
echo "Use it for SSH over PKCS#11:"
note "module: libykcs11.so (yubico-piv-tool) or opensc-pkcs11.so (opensc)"
note "list  : ssh-keygen -D <module>            # prints this same public key"
note "config: add to ~/.ssh/config →  PKCS11Provider <module>"
note "agent : ssh-add -s <module>   (remove later with ssh-add -e <module>)"

echo
echo "Register the public key where logins are authorised:"
note "add it to the relevant authorizedKeys / $CONFIG_PATH public_keys, then rebuild."
