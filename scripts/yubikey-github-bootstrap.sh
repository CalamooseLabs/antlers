# yubikey-github-bootstrap — provision a YubiKey from scratch with an ON-CARD
# OpenPGP identity for a GitHub account, tuned for HEADLESS "present-but-no-touch"
# use (the `ai` host), then print exactly what to save in Proton Pass, how to
# reference it in the NixOS config, and what to upload to GitHub.
#
# Model: the SIGN + ENCRYPT + AUTHENTICATE keys are GENERATED inside the OpenPGP
# applet (`gpg --card-edit` → generate), so the private key material is
# non-exportable and CANNOT be backed up — if the card is lost the keys are gone,
# by design. Only the PUBLIC halves ever leave the card. Back up by provisioning a
# SECOND YubiKey (its own distinct keys) and enrolling both on the GitHub account.
#
# SSH auth is handled by the OpenPGP [A] (authentication) subkey served over the
# gpg-agent SSH socket (the `gpg` module sets enableSSHSupport = true) — GitHub
# sees an ordinary ed25519 key and accepts it, and the no-touch behaviour is set
# locally on the card. This is why we do NOT use a FIDO2/sk key here: GitHub
# rejects no-touch sk keys for authentication.
#
# TOUCH POLICY is forced to `off` on the sig/aut/enc slots: the card must be
# PRESENT for anything to work, but no tap is required — the property a headless
# box needs (there is no operator to touch it).
#
# The OpenPGP half drives gpg's card-edit menu over --command-fd while PINs are
# typed interactively at gpg's pinentry; to keep that menu deterministic it first
# FACTORY-RESETS the OpenPGP applet (with confirmation). The exact gpg menu
# wording is version-sensitive — SMOKE-TEST this on real hardware.
#
# Every value is an env var with a default; programs.antlers-scripts.
# yubikey-github-bootstrap bakes per-host defaults via makeWrapper.

GPG_NAME="${GPG_NAME:-}"                   # OpenPGP user-ID name (default: git user.name, else prompt)
GPG_EMAIL="${GPG_EMAIL:-}"                 # OpenPGP user-ID email — must be a VERIFIED email on the bot GitHub account
GPG_COMMENT="${GPG_COMMENT:-}"             # optional user-ID comment
GPG_EXPIRE="${GPG_EXPIRE:-0}"              # 0 = never; e.g. 2y, 18m
GPG_ALGO="${GPG_ALGO:-auto}"              # auto -> 25519 (fw>=5.2.3) else rsa2048

PROTON_VAULT="${PROTON_VAULT:-Cala-M-OS}"  # Proton Pass vault holding the public key
PROTON_ITEM="${PROTON_ITEM:-ai-github-gpg.asc}" # Proton Pass item title; field is always "secret"
PROTON_FIELD="${PROTON_FIELD:-secret}"     # custom field the online backend reads

CONFIG_PATH="${CONFIG_PATH:-/etc/nixos}"

usage() {
  cat <<EOF
yubikey-github-bootstrap — provision a YubiKey with an on-card OpenPGP identity
for a GitHub account (present-but-no-touch), and print the Proton Pass / NixOS /
GitHub follow-ups.

Usage: yubikey-github-bootstrap [options]

  --gpg-name NAME       OpenPGP user-ID name (default: git user.name, else prompt)
  --gpg-email ADDR      OpenPGP user-ID email; must be VERIFIED on the bot GitHub account
                        (default: git user.email, else prompt)
  --gpg-comment TEXT    OpenPGP user-ID comment (default: none)
  --gpg-expire WHEN     OpenPGP expiry, 0=never (default: $GPG_EXPIRE)
  --gpg-algo ALG        25519 or rsaNNNN, or 'auto' (default: $GPG_ALGO)
  --proton-vault NAME   Proton Pass vault for the public key (default: $PROTON_VAULT)
  --proton-item TITLE   Proton Pass item title (default: $PROTON_ITEM)
  -h, --help            this help

The keys are generated ON the card and can never be exported or backed up. The
applet is factory-reset first (you confirm), so its PINs become User 123456 /
Admin 12345678 — CHANGE them afterwards. OpenPGP 25519 needs firmware >= 5.2.3
(use --gpg-algo rsa2048 on older keys).

Env (defaults shown, all overridable):
  GPG_NAME=${GPG_NAME:-<git/ prompt>}  GPG_EMAIL=${GPG_EMAIL:-<git/ prompt>}
  GPG_EXPIRE=$GPG_EXPIRE  GPG_ALGO=$GPG_ALGO
  PROTON_VAULT=$PROTON_VAULT  PROTON_ITEM=$PROTON_ITEM  PROTON_FIELD=$PROTON_FIELD
  CONFIG_PATH=$CONFIG_PATH
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --gpg-name) GPG_NAME="${2:?--gpg-name needs a value}"; shift ;;
    --gpg-email) GPG_EMAIL="${2:?--gpg-email needs a value}"; shift ;;
    --gpg-comment) GPG_COMMENT="${2:?--gpg-comment needs a value}"; shift ;;
    --gpg-expire) GPG_EXPIRE="${2:?--gpg-expire needs a value}"; shift ;;
    --gpg-algo) GPG_ALGO="${2:?--gpg-algo needs a value}"; shift ;;
    --proton-vault) PROTON_VAULT="${2:?--proton-vault needs a value}"; shift ;;
    --proton-item) PROTON_ITEM="${2:?--proton-item needs a value}"; shift ;;
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
  echo "Run yubikey-github-bootstrap as your user, not root — gpg uses your keyring/agent." >&2
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

for t in ykman gpg; do
  have "$t" || die "$t not found on PATH."
done

mapfile -t SERIALS < <(card_serials)
[ "${#SERIALS[@]}" -ge 1 ] || die "No YubiKey detected. Insert it (is pcscd running?) and retry."

hr
echo "Connected YubiKeys:"
for s in "${SERIALS[@]}"; do note "$(card_label "$s")"; done
hr

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

# Resolve 'auto' algorithm against the target's firmware.
gpg_algo="$GPG_ALGO"
if [ "$gpg_algo" = "auto" ]; then
  if [ -n "$FW" ] && ver_ge "$FW" "5.2.3"; then gpg_algo="25519"; else gpg_algo="rsa2048"; fi
fi
gpg_algo="$(printf '%s' "$gpg_algo" | tr '[:upper:]' '[:lower:]')"

# ---- identity --------------------------------------------------------------

[ -n "$GPG_NAME" ] || { have git && GPG_NAME="$(git config --get user.name 2>/dev/null || true)"; }
[ -n "$GPG_EMAIL" ] || { have git && GPG_EMAIL="$(git config --get user.email 2>/dev/null || true)"; }
[ -n "$GPG_NAME" ] || read -r -p "  OpenPGP real name: " GPG_NAME
[ -n "$GPG_EMAIL" ] || read -r -p "  OpenPGP email (verified on the bot GitHub account): " GPG_EMAIL
[ -n "$GPG_NAME" ] && [ -n "$GPG_EMAIL" ] || die "OpenPGP name and email are required (--gpg-name/--gpg-email)."

# ---- generate the on-card OpenPGP key --------------------------------------

echo
hr
echo "GPG — OpenPGP applet, algorithm $gpg_algo"
echo "This GENERATES an OpenPGP key set (signature + encryption + authentication)"
echo "directly on the card for: $GPG_NAME <$GPG_EMAIL> (expire: $GPG_EXPIRE)."
echo "To stay deterministic it first FACTORY-RESETS the card's OpenPGP applet,"
echo "wiping any OpenPGP keys/PINs already on it."
confirm "Reset the OpenPGP applet and generate the key set now?" || die "aborted before any change was made."

ykman --device "$TARGET" openpgp reset -f || die "ykman openpgp reset failed."
note "OpenPGP PINs are now factory defaults — User PIN 123456, Admin PIN 12345678."
note "enter the Admin PIN (12345678) when gpg's pinentry asks during generation."

# gpg reads its menu answers from fd 0 (the pipe below), so its pinentry must
# reach the terminal some other way: point GPG_TTY at it. Then force the agent to
# re-read the just-reset card so card-edit sees the blank applet.
if [ -t 0 ]; then
  GPG_TTY="$(tty)"
  export GPG_TTY
fi
gpg --card-status >/dev/null 2>&1 || true

# Build the card-edit command stream. PINs are NOT in here — they are typed
# interactively at gpg's pinentry. Set key-attr for all three slots, then
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

# ---- touch policy: OFF (present-but-no-touch) ------------------------------

echo
echo "Setting touch policy to 'off' on sig/aut/enc (present-but-no-touch)…"
for slot in sig aut enc; do
  ykman --device "$TARGET" openpgp keys set-touch -f "$slot" off \
    || note "could not set touch policy for $slot (later: ykman openpgp keys set-touch $slot off)"
done

# ---- capture the key id + public material ----------------------------------

gpg --card-status >/dev/null 2>&1 || true
KEYID="$(gpg --list-keys --keyid-format=long --with-colons "$GPG_EMAIL" 2>/dev/null | awk -F: '/^pub:/ {print $5; exit}')"
[ -n "$KEYID" ] || die "could not determine the new key id for <$GPG_EMAIL> (check 'gpg --list-keys')."

PUBKEY="$(gpg --armor --export "$KEYID" 2>/dev/null || true)"
[ -n "$PUBKEY" ] || die "could not export the public key for $KEYID."
SSHKEY="$(gpg --export-ssh-key "$KEYID" 2>/dev/null || true)"

# ---- report ----------------------------------------------------------------

echo
hr
echo "Done — $(card_label "$TARGET")"
echo "OpenPGP key: $GPG_NAME <$GPG_EMAIL>   key id: $KEYID"
hr

echo
echo "### 1. SAVE TO PROTON PASS ###############################################"
note "Vault : $PROTON_VAULT"
note "Item  : $PROTON_ITEM   (create it if absent)"
note "Field : add a custom field named '$PROTON_FIELD' and paste the PUBLIC key below."
note "        (This is the PUBLIC key only — the private key is non-extractable.)"
echo
echo "$PUBKEY"

echo
echo "### 2. REFERENCE IN THE NIXOS CONFIG #####################################"
note "In $CONFIG_PATH/modules/ai-github/configuration.nix:"
note "    calamoose.secrets.\"$PROTON_ITEM\" = {"
note "      vaultName = \"$PROTON_VAULT\";"
note "      itemTitle = \"$PROTON_ITEM\";"
note "      field     = \"$PROTON_FIELD\";"
note "    };"
note "    programs.gpg-key-import.secretName = \"$PROTON_ITEM\";"
note "    programs.gpg-key-import.keyId      = \"$KEYID\";"
note "In $CONFIG_PATH/modules/ai-github/home.nix:"
note "    programs.git.settings.user.email  = lib.mkForce \"$GPG_EMAIL\";"
note "    programs.git.settings.signing.key = lib.mkForce \"$KEYID\";"
note "Then: sudo nixos-rebuild switch --flake $CONFIG_PATH#ai"

echo
echo "### 3. UPLOAD TO THE BOT GITHUB ACCOUNT ##################################"
note "GPG key  — Settings → SSH and GPG keys → New GPG key → paste the PUBLIC key above."
note "Auth key — Settings → SSH and GPG keys → New SSH key → Key type 'Authentication':"
if [ -n "$SSHKEY" ]; then
  echo
  echo "$SSHKEY"
else
  note "  (run 'gpg --export-ssh-key $KEYID' to print the SSH auth key)"
fi
note "Verify the email <$GPG_EMAIL> on the account so signed commits show 'Verified'."

echo
echo "### 4. FINISH UP #########################################################"
note "CHANGE the default OpenPGP PINs now:"
note "    ykman --device $TARGET openpgp access change-pin"
note "    ykman --device $TARGET openpgp access change-admin-pin"
note "On-card keys are NON-EXTRACTABLE — there is no backup. For redundancy,"
note "re-run this on a SECOND YubiKey and enroll BOTH keys on the GitHub account."
note "Repos the ai box pushes to must use an SSH remote (git@github.com:…)."
