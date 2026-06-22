# yubikey-provision — provision a selected YubiKey with a fresh, ON-CARD SSH key
# (PIV) and an ON-CARD OpenPGP signing key.
#
# Nothing is imported and no secret touches disk: the SSH key is GENERATED inside
# a PIV slot (`ykman piv keys generate`) and the GPG key is GENERATED inside the
# OpenPGP applet (`gpg --card-edit` → generate). Both private keys are therefore
# non-exportable and CANNOT be backed up — if the card is lost the keys are gone,
# by design. Only the PUBLIC halves ever leave the card.
#
# When several YubiKeys are attached you pick the TARGET interactively.
#
# The PIV/SSH half is deterministic (ykman). The OpenPGP half drives gpg's
# card-edit menu over --command-fd while PINs are typed interactively at gpg's
# pinentry; to keep that menu deterministic it first FACTORY-RESETS the OpenPGP
# applet (with confirmation). The exact gpg menu wording is version-sensitive —
# SMOKE-TEST this half on real hardware before relying on it.
#
# Every host value is an env var with a default; programs.antlers-scripts.
# yubikey-provision bakes per-host defaults via makeWrapper.

# --- SSH / PIV ---
PIV_SLOT="${PIV_SLOT:-9a}"                 # 9a = PIV Authentication (the SSH slot)
PIV_PIN_POLICY="${PIV_PIN_POLICY:-once}"   # default|never|once|always
PIV_TOUCH_POLICY="${PIV_TOUCH_POLICY:-cached}" # default|never|always|cached
PIV_ALGO="${PIV_ALGO:-auto}"               # auto -> ED25519 (fw>=5.7) else ECCP256
CERT_SUBJECT="${CERT_SUBJECT:-}"           # RFC 4514 DN; default derived below
CERT_DAYS="${CERT_DAYS:-3650}"

# --- GPG / OpenPGP ---
GPG_NAME="${GPG_NAME:-}"                   # default: git user.name, else prompt
GPG_EMAIL="${GPG_EMAIL:-}"                 # default: git user.email, else prompt
GPG_COMMENT="${GPG_COMMENT:-}"
GPG_EXPIRE="${GPG_EXPIRE:-0}"              # 0 = never; e.g. 2y, 18m
GPG_ALGO="${GPG_ALGO:-auto}"               # auto -> 25519 (fw>=5.2.3) else rsa2048
GPG_TOUCH="${GPG_TOUCH:-cached}"           # off|on|fixed|cached|cached-fixed (sig key)

CONFIG_PATH="${CONFIG_PATH:-/etc/nixos}"

DO_SSH=1
DO_GPG=1

usage() {
  cat <<EOF
yubikey-provision — generate a fresh SSH key (PIV) and OpenPGP signing key on a YubiKey.

Usage: yubikey-provision [options]

  --slot SLOT           PIV slot for the SSH key (default: $PIV_SLOT; 9a=Authentication)
  --pin-policy POLICY   default|never|once|always (default: $PIV_PIN_POLICY)
  --touch-policy POLICY default|never|always|cached (default: $PIV_TOUCH_POLICY)
  --algo ALG            PIV key algorithm or 'auto' (default: $PIV_ALGO)
                        auto = ED25519 on fw>=5.7, else ECCP256; also ECCP384/RSA2048/…
  --subject DN          PIV cert subject, RFC 4514 (default: CN=<gpg email or user@host>)
  --days N              PIV cert validity in days (default: $CERT_DAYS)

  --gpg-name NAME       OpenPGP user-ID name (default: git user.name, else prompt)
  --gpg-email ADDR      OpenPGP user-ID email (default: git user.email, else prompt)
  --gpg-comment TEXT    OpenPGP user-ID comment (default: none)
  --gpg-expire WHEN     OpenPGP expiry, 0=never (default: $GPG_EXPIRE)
  --gpg-algo ALG        25519 or rsaNNNN, or 'auto' (default: $GPG_ALGO)
  --gpg-touch POLICY    signature-key touch: off|on|fixed|cached|cached-fixed (default: $GPG_TOUCH)

  --ssh-only            provision only the PIV/SSH key
  --gpg-only            provision only the OpenPGP signing key
  -h, --help            this help

Both private keys are generated ON the card and can never be exported or backed up.
The OpenPGP half factory-resets the card's OpenPGP applet first (you confirm), so its
default PINs become User 123456 / Admin 12345678 — CHANGE them afterwards. ED25519 in
PIV needs firmware >= 5.7 (use --algo ECCP256/RSA2048 on older keys); OpenPGP 25519
needs fw >= 5.2.3.

Env (defaults shown, all overridable):
  PIV_SLOT=$PIV_SLOT  PIV_PIN_POLICY=$PIV_PIN_POLICY  PIV_TOUCH_POLICY=$PIV_TOUCH_POLICY
  PIV_ALGO=$PIV_ALGO  CERT_DAYS=$CERT_DAYS  CERT_SUBJECT=${CERT_SUBJECT:-<derived>}
  GPG_NAME=${GPG_NAME:-<git/ prompt>}  GPG_EMAIL=${GPG_EMAIL:-<git/ prompt>}
  GPG_EXPIRE=$GPG_EXPIRE  GPG_ALGO=$GPG_ALGO  GPG_TOUCH=$GPG_TOUCH
  CONFIG_PATH=$CONFIG_PATH
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --slot) PIV_SLOT="${2:?--slot needs a value}"; shift ;;
    --pin-policy) PIV_PIN_POLICY="${2:?--pin-policy needs a value}"; shift ;;
    --touch-policy) PIV_TOUCH_POLICY="${2:?--touch-policy needs a value}"; shift ;;
    --algo) PIV_ALGO="${2:?--algo needs a value}"; shift ;;
    --subject) CERT_SUBJECT="${2:?--subject needs a value}"; shift ;;
    --days) CERT_DAYS="${2:?--days needs a value}"; shift ;;
    --gpg-name) GPG_NAME="${2:?--gpg-name needs a value}"; shift ;;
    --gpg-email) GPG_EMAIL="${2:?--gpg-email needs a value}"; shift ;;
    --gpg-comment) GPG_COMMENT="${2:?--gpg-comment needs a value}"; shift ;;
    --gpg-expire) GPG_EXPIRE="${2:?--gpg-expire needs a value}"; shift ;;
    --gpg-algo) GPG_ALGO="${2:?--gpg-algo needs a value}"; shift ;;
    --gpg-touch) GPG_TOUCH="${2:?--gpg-touch needs a value}"; shift ;;
    --ssh-only) DO_GPG=0 ;;
    --gpg-only) DO_SSH=0 ;;
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
  echo "Run yubikey-provision as your user, not root — gpg uses your keyring/agent." >&2
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

# Remove the temp dir (only ever holds the PUBLIC key PEM, but shred anyway).
TMPD=""
cleanup() {
  if [ -n "${TMPD:-}" ] && [ -d "$TMPD" ]; then
    shred -u "$TMPD"/* 2>/dev/null || true
    rm -rf "$TMPD"
  fi
}
trap cleanup EXIT

# True if version $1 >= version $2 (dotted numeric).
ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]; }

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

# Firmware version string of a serial (e.g. 5.7.4), empty if unknown.
card_fw() {
  ykman --device "$1" info 2>/dev/null | sed -n 's/^Firmware version:[[:space:]]*//p'
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

[ "$DO_SSH" -eq 1 ] || [ "$DO_GPG" -eq 1 ] || die "nothing to do (--ssh-only and --gpg-only are mutually exclusive)."

needed=(ykman)
[ "$DO_SSH" -eq 1 ] && needed+=(ssh-keygen)
[ "$DO_GPG" -eq 1 ] && needed+=(gpg)
for t in "${needed[@]}"; do
  have "$t" || die "$t not found on PATH."
done

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
  choose_serial "Which YubiKey is the TARGET (to provision)?" TARGET "${SERIALS[@]}"
fi
echo "Target: $(card_label "$TARGET")"
FW="$(card_fw "$TARGET")"

# Resolve 'auto' algorithms against the target's firmware.
piv_algo="$PIV_ALGO"
if [ "$piv_algo" = "auto" ]; then
  if [ -n "$FW" ] && ver_ge "$FW" "5.7.0"; then piv_algo="ED25519"; else piv_algo="ECCP256"; fi
fi
piv_algo="$(printf '%s' "$piv_algo" | tr '[:lower:]' '[:upper:]')"

gpg_algo="$GPG_ALGO"
if [ "$gpg_algo" = "auto" ]; then
  if [ -n "$FW" ] && ver_ge "$FW" "5.2.3"; then gpg_algo="25519"; else gpg_algo="rsa2048"; fi
fi
gpg_algo="$(printf '%s' "$gpg_algo" | tr '[:upper:]' '[:lower:]')"

# ---- SSH: generate a key in a PIV slot -------------------------------------

if [ "$DO_SSH" -eq 1 ]; then
  echo
  hr
  echo "SSH — PIV slot $PIV_SLOT, algorithm $piv_algo"
  echo "This GENERATES a new key on the card in slot $PIV_SLOT, OVERWRITING any key"
  echo "and certificate already in that slot. pin-policy=$PIV_PIN_POLICY touch-policy=$PIV_TOUCH_POLICY"
  if confirm "Provision the PIV/SSH key now?"; then
    TMPD="$(mktemp -d)"
    chmod 700 "$TMPD"

    # Derive the cert subject if not given (strip RFC 4514 specials).
    if [ -z "$CERT_SUBJECT" ]; then
      cn="${GPG_EMAIL:-$(id -un)@$(uname -n 2>/dev/null || echo yubikey)}"
      cn="$(printf '%s' "$cn" | tr -d ',+=<>;"')"
      [ -n "$cn" ] || cn="yubikey-ssh"
      CERT_SUBJECT="CN=$cn"
    fi

    echo "Generating the key on the card…"
    note "you'll be prompted for the PIV management key (and maybe the PIN)"
    ykman --device "$TARGET" piv keys generate \
      --algorithm "$piv_algo" \
      --pin-policy "$PIV_PIN_POLICY" --touch-policy "$PIV_TOUCH_POLICY" \
      "$PIV_SLOT" "$TMPD/pub.pem" \
      || die "ykman piv keys generate failed (ED25519 in PIV needs fw>=5.7; try --algo ECCP256 or RSA2048)."

    echo "Self-signing a certificate for slot $PIV_SLOT (subject $CERT_SUBJECT)…"
    ykman --device "$TARGET" piv certificates generate \
      -s "$CERT_SUBJECT" -d "$CERT_DAYS" "$PIV_SLOT" "$TMPD/pub.pem" \
      || die "ykman piv certificates generate failed."

    # The public half of the slot, in OpenSSH format (best-effort; ed25519 PEM
    # import needs a recent ssh-keygen — fall back to the PKCS#11 read below).
    SSH_PUB="$(ssh-keygen -i -m PKCS8 -f "$TMPD/pub.pem" 2>/dev/null || true)"
    [ -n "$SSH_PUB" ] && SSH_PUB="$SSH_PUB PIV$PIV_SLOT@$TARGET"
  else
    note "skipped PIV/SSH provisioning."
    DO_SSH=0
  fi
fi

# ---- GPG: generate an OpenPGP signing key on the card ----------------------

if [ "$DO_GPG" -eq 1 ]; then
  echo
  hr
  echo "GPG — OpenPGP applet, algorithm $gpg_algo"

  # Identity for the user ID.
  [ -n "$GPG_NAME" ] || { have git && GPG_NAME="$(git config --get user.name 2>/dev/null || true)"; }
  [ -n "$GPG_EMAIL" ] || { have git && GPG_EMAIL="$(git config --get user.email 2>/dev/null || true)"; }
  [ -n "$GPG_NAME" ] || read -r -p "  OpenPGP real name: " GPG_NAME
  [ -n "$GPG_EMAIL" ] || read -r -p "  OpenPGP email: " GPG_EMAIL
  [ -n "$GPG_NAME" ] && [ -n "$GPG_EMAIL" ] || die "OpenPGP name and email are required (--gpg-name/--gpg-email)."

  echo "This GENERATES an OpenPGP key set (signature + encryption + authentication)"
  echo "directly on the card for: $GPG_NAME <$GPG_EMAIL> (expire: $GPG_EXPIRE)."
  echo "To stay deterministic it first FACTORY-RESETS the card's OpenPGP applet,"
  echo "wiping any OpenPGP keys/PINs already on it (this does NOT touch the PIV slot)."
  if confirm "Reset the OpenPGP applet and generate the signing key now?"; then
    ykman --device "$TARGET" openpgp reset -f \
      || die "ykman openpgp reset failed."
    note "OpenPGP PINs are now factory defaults — User PIN 123456, Admin PIN 12345678."
    note "enter the Admin PIN (12345678) when gpg's pinentry asks during generation."

    # gpg reads its menu answers from fd 0 (the pipe below), so its pinentry must
    # reach the terminal some other way: point GPG_TTY at it. Then force the agent
    # to re-read the just-reset card so card-edit sees the blank applet.
    if [ -t 0 ]; then
      GPG_TTY="$(tty)"
      export GPG_TTY
    fi
    gpg --card-status >/dev/null 2>&1 || true

    # Build the card-edit command stream. PINs are NOT in here — they are typed
    # interactively at gpg's pinentry. We set key-attr for all three slots, then
    # generate with no off-card backup, then the user-ID prompts.
    cmds=(admin key-attr)
    case "$gpg_algo" in
      25519 | ed25519 | cv25519)
        cmds+=(2 1 2 1 2 1) ;; # each slot: (2) ECC, (1) Curve 25519
      rsa2048 | rsa3072 | rsa4096)
        bits="${gpg_algo#rsa}"
        cmds+=(1 "$bits" 1 "$bits" 1 "$bits") ;; # each slot: (1) RSA, keysize
      *) die "unsupported --gpg-algo: $gpg_algo (use 25519 or rsa2048/3072/4096)." ;;
    esac
    cmds+=(generate n "$GPG_EXPIRE" y "$GPG_NAME" "$GPG_EMAIL" "$GPG_COMMENT" O quit)

    echo "Driving gpg --card-edit (answer any PIN prompts interactively)…"
    printf '%s\n' "${cmds[@]}" | gpg --expert --command-fd 0 --card-edit \
      || die "gpg on-card key generation failed (the menu sequence is gpg-version-sensitive; run 'gpg --card-edit' manually to inspect)."

    if [ "$GPG_TOUCH" != "off" ] && [ "$GPG_TOUCH" != "default" ]; then
      echo "Setting signature-key touch policy to '$GPG_TOUCH'…"
      ykman --device "$TARGET" openpgp keys set-touch -f sig "$GPG_TOUCH" \
        || note "could not set touch policy (later: ykman openpgp keys set-touch sig $GPG_TOUCH)"
    fi
  else
    note "skipped OpenPGP provisioning."
    DO_GPG=0
  fi
fi

# ---- report ----------------------------------------------------------------

echo
hr
echo "Done — $(card_label "$TARGET")"
hr

if [ "$DO_SSH" -eq 1 ]; then
  echo
  echo "SSH (PIV slot $PIV_SLOT):"
  if [ -n "${SSH_PUB:-}" ]; then
    note "public key — add to authorized_keys / $CONFIG_PATH public keys:"
    note "$SSH_PUB"
  else
    note "could not auto-convert the slot's public key; read it from the card with:"
    note "  ssh-keygen -D <libykcs11.so>"
  fi
  note "use over PKCS#11: module libykcs11.so (yubico-piv-tool) or opensc-pkcs11.so (opensc)"
  note "  ~/.ssh/config →  PKCS11Provider <module>     (or: ssh-add -s <module>)"
  note "  list/print key:  ssh-keygen -D <module>"
fi

if [ "$DO_GPG" -eq 1 ]; then
  echo
  echo "GPG (OpenPGP applet):"
  gpg --card-status 2>/dev/null | sed 's/^/  /' || true
  note "export the public key:  gpg --armor --export $GPG_EMAIL"
  note "find the key id:        gpg --list-secret-keys --keyid-format=long $GPG_EMAIL"
  note "use it to sign git:     git config --global gpg.format openpgp"
  note "                        git config --global user.signingkey <KEYID>  (then commit -S)"
  note "CHANGE the default OpenPGP PINs now: ykman openpgp access change-pin   and   change-admin-pin"
fi

if [ "$DO_SSH" -eq 1 ]; then
  echo
  note "After registering the SSH key, add it where logins are authorised in $CONFIG_PATH and rebuild."
fi
