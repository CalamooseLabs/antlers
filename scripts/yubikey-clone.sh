# yubikey-clone — provision a spare Yubikey to back up another.
#
# Private keys never leave a Yubikey, so this is NOT a byte copy off the source
# card. It works the way the hardware allows:
#
#   * GPG (git signing + gpg-agent SSH): the OpenPGP Sign/Encrypt/Auth subkeys
#     are generated off-card, so a spare can carry the SAME fingerprints — IFF you
#     still have the secret-key backup. The script DIAGNOSES whether that material
#     is available, then guides `keytocard` onto the target. An exact clone.
#   * FIDO2 resident SSH (installer login) and the age-plugin-yubikey identity
#     (agenix decryption) are device-bound and unique per key. The script GENERATES
#     fresh ones on the target and prints the public key / recipient to register.
#
# Every host-specific value is an env var with the cala-m-os default baked in;
# programs.antlers-scripts.yubikey-clone bakes per-host defaults via makeWrapper.

GPG_KEY_ID="${GPG_KEY_ID:-50D56BF0B93CA212}"
GPG_PUBLIC_KEY_FILE="${GPG_PUBLIC_KEY_FILE:-/run/agenix/yubigpg.asc}"
GPG_SECRET_BACKUP="${GPG_SECRET_BACKUP:-}"
SSH_KEY_NAME="${SSH_KEY_NAME:-id_ed25519_sk}"
SSH_BACKUP_KEY_NAME="${SSH_BACKUP_KEY_NAME:-backup_${SSH_KEY_NAME}}"
SSH_FIDO2_APPLICATION="${SSH_FIDO2_APPLICATION:-ssh:}"
CONFIG_PATH="${CONFIG_PATH:-/etc/nixos}"
AGE_SLOT="${AGE_SLOT:-}"
AGE_PIN_POLICY="${AGE_PIN_POLICY:-never}"
AGE_TOUCH_POLICY="${AGE_TOUCH_POLICY:-never}"

do_gpg=1
do_fido2=1
do_age=1

usage() {
  cat <<EOF
yubikey-clone — back up a Yubikey's git-signing/SSH credentials onto a spare.

Usage: yubikey-clone [options]

  --skip-gpg      do not clone the OpenPGP (git signing + SSH) keys
  --skip-fido2    do not generate a FIDO2 resident SSH key on the spare
  --skip-age      do not generate an age-plugin-yubikey identity on the spare
  -h, --help      this help

Diagnostic-first: for GPG it checks whether your secret-key material is
extractable before it touches a card, and tells you if a true clone is possible.

Env (defaults shown, all overridable):
  GPG_KEY_ID=$GPG_KEY_ID
  GPG_PUBLIC_KEY_FILE=$GPG_PUBLIC_KEY_FILE
  GPG_SECRET_BACKUP=${GPG_SECRET_BACKUP:-<prompted>}   # .asc/.gpg export or a GnuPG home dir
  SSH_BACKUP_KEY_NAME=$SSH_BACKUP_KEY_NAME
  SSH_FIDO2_APPLICATION=$SSH_FIDO2_APPLICATION
  CONFIG_PATH=$CONFIG_PATH
  AGE_SLOT=${AGE_SLOT:-<plugin default>}  AGE_PIN_POLICY=$AGE_PIN_POLICY  AGE_TOUCH_POLICY=$AGE_TOUCH_POLICY
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-gpg) do_gpg=0 ;;
    --skip-fido2) do_fido2=0 ;;
    --skip-age) do_age=0 ;;
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
  echo "Run yubikey-clone as your user, not root — the keys land in your keyring/~/.ssh." >&2
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
  # confirm "question" -> 0 if yes
  local ans
  read -r -p "$1 [y/N] " ans || return 1
  case "$ans" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# Serials of every connected Yubikey, one per line.
card_serials() { ykman list --serials 2>/dev/null || true; }

# One-line human label for a serial.
card_label() {
  local serial="$1" type fw
  type="$(ykman --device "$serial" info 2>/dev/null | sed -n 's/^Device type:[[:space:]]*//p')"
  fw="$(ykman --device "$serial" info 2>/dev/null | sed -n 's/^Firmware version:[[:space:]]*//p')"
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

# Block until exactly the given serial (and no other Yubikey) is connected.
isolate_target() {
  local want="$1" present
  while :; do
    mapfile -t present < <(card_serials)
    if [ "${#present[@]}" -eq 1 ] && [ "${present[0]}" = "$want" ]; then
      return 0
    fi
    echo
    echo "Insert ONLY the target Yubikey (SN $want) and remove all others." >&2
    if [ "${#present[@]}" -eq 0 ]; then
      note "(none detected right now)"
    else
      note "currently connected: ${present[*]}"
    fi
    read -r -p "Press Enter when ready (Ctrl-C to abort)… " _ || die "aborted"
  done
}

# Map an OpenPGP capability field (any combination of s/e/a) to ONE card slot +
# label with a fixed precedence (Signature=1, Encryption=2, Authentication=3),
# and flag whether the subkey carries more than one capability (gpg then offers
# several slots and the single number would be wrong). Echoes "slot:label:amb".
# Both the diagnosis label and the keytocard hint derive from this, so they can
# never disagree.
cap_slot_label() {
  local cap="$1" slot label n=0
  case "$cap" in
    *s*) slot=1 label="Signature" ;;
    *e*) slot=2 label="Encryption" ;;
    *a*) slot=3 label="Authentication" ;;
    *) slot=0 label="other" ;;
  esac
  case "$cap" in *s*) n=$((n + 1)) ;; esac
  case "$cap" in *e*) n=$((n + 1)) ;; esac
  case "$cap" in *a*) n=$((n + 1)) ;; esac
  if [ "$n" -gt 1 ]; then echo "$slot:$label:yes"; else echo "$slot:$label:no"; fi
}

# Fail closed unless EXACTLY the target Yubikey (nothing else) is connected,
# re-checked immediately before each write: isolate_target's snapshot can go
# stale if the source is re-inserted during a touch/PIN wait.
assert_target_alone() {
  local present
  mapfile -t present < <(card_serials)
  if [ "${#present[@]}" -ne 1 ] || [ "${present[0]:-}" != "$TARGET" ]; then
    die "Card set changed (expected only target SN $TARGET, saw: ${present[*]:-none}). Aborting before the write."
  fi
}

for t in ykman gpg; do
  have "$t" || die "$t not found on PATH."
done

mapfile -t SERIALS < <(card_serials)
[ "${#SERIALS[@]}" -ge 1 ] || die "No Yubikey detected. Insert your keys (is pcscd running?) and retry."

hr
echo "Connected Yubikeys:"
for s in "${SERIALS[@]}"; do note "$(card_label "$s")"; done
hr

# Pick the target (the spare we provision).
TARGET=""
if [ "${#SERIALS[@]}" -eq 1 ]; then
  TARGET="${SERIALS[0]}"
  echo "Only one Yubikey present — using it as the TARGET (the spare to provision):"
  note "$(card_label "$TARGET")"
  confirm "Provision this key?" || die "aborted"
else
  choose_serial "Which Yubikey is the TARGET (the spare to write to)?" TARGET "${SERIALS[@]}"
fi
echo "Target: $(card_label "$TARGET")"

# ---- GPG (git signing + gpg-agent SSH) -------------------------------------

gpg_step() {
  echo
  hr
  echo "GPG — git signing + gpg-agent SSH (OpenPGP Sign/Encrypt/Auth)"
  hr

  # Identify the source identity to mirror (optional but recommended).
  local SOURCE="" src_candidates=()
  for s in "${SERIALS[@]}"; do [ "$s" = "$TARGET" ] || src_candidates+=("$s"); done
  if [ "${#src_candidates[@]}" -ge 1 ]; then
    if [ "${#src_candidates[@]}" -eq 1 ]; then
      SOURCE="${src_candidates[0]}"
    else
      choose_serial "Which Yubikey is the SOURCE (identity to mirror)?" SOURCE "${src_candidates[@]}"
    fi
    echo "Source: $(card_label "$SOURCE")"
  else
    echo "No second key present to read the source identity from — relying on the backup's own identity."
  fi

  # Read the source card's OpenPGP fingerprints (for the match check below).
  local src_info="" src_fprs=()
  if [ -n "$SOURCE" ]; then
    src_info="$(ykman --device "$SOURCE" openpgp info 2>/dev/null || true)"
    mapfile -t src_fprs < <(printf '%s\n' "$src_info" | grep -oiE '[0-9A-F]{40}' | tr 'a-f' 'A-F' || true)
    if [ "${#src_fprs[@]}" -gt 0 ]; then
      echo "Source OpenPGP key fingerprints:"
      printf '  %s\n' "${src_fprs[@]}"
    fi
  fi

  # --- Diagnose clone viability in a throwaway keyring (touches nothing real) ---
  local GNUPGHOME
  GNUPGHOME="$(mktemp -d)"
  export GNUPGHOME
  chmod 700 "$GNUPGHOME"
  # shellcheck disable=SC2064
  trap "rm -rf '$GNUPGHOME'; unset GNUPGHOME" RETURN
  echo
  echo "Diagnosing whether a true clone is possible (in a throwaway keyring at $GNUPGHOME)…"

  # Seed the public key so we know the subkey layout even from a thin backup.
  if [ -r "$GPG_PUBLIC_KEY_FILE" ]; then
    gpg --batch --import "$GPG_PUBLIC_KEY_FILE" >/dev/null 2>&1 || true
  fi

  # Locate secret-key material.
  local backup="$GPG_SECRET_BACKUP"
  if [ -z "$backup" ]; then
    echo
    echo "Where is your GPG SECRET-key backup?"
    note "a file: a 'gpg --export-secret-keys' .asc/.gpg, or a paperkey-restored file"
    note "a dir : a GnuPG home (with private-keys-v1.d/)"
    note "blank : check your CURRENT keyring (~/.gnupg) for extractable material"
    read -r -p "Path (blank = current keyring): " backup || true
  fi

  if [ -z "$backup" ]; then
    echo "Exporting from your current keyring (you may be prompted for the passphrase)…"
    gpg --homedir "$HOME/.gnupg" --export-secret-keys "$GPG_KEY_ID" 2>/dev/null |
      gpg --batch --import >/dev/null 2>&1 || true
  elif [ -d "$backup" ]; then
    gpg --homedir "$backup" --export-secret-keys "$GPG_KEY_ID" 2>/dev/null |
      gpg --batch --import >/dev/null 2>&1 || true
  elif [ -r "$backup" ]; then
    gpg --batch --import "$backup" >/dev/null 2>&1 || true
  else
    echo "Cannot read '$backup'." >&2
  fi

  # Classify each subkey: real secret vs card-stub vs missing.
  local plan=() keyidx=0
  local cap grip
  # Walk the public subkeys in --edit-key order to build the keytocard plan.
  while IFS=: read -r rec _ _ _ kid _ _ _ _ _ _ capfield _; do
    case "$rec" in
      pub) keyidx=0 ;;
      sub)
        keyidx=$((keyidx + 1))
        cap="$capfield"
        # keygrip is on the following grp: line
        grip="$(gpg --with-colons --with-keygrip --list-keys "$GPG_KEY_ID" 2>/dev/null |
          awk -F: -v want="$kid" '
            $1=="sub" && $5==want {f=1; next}
            f && $1=="grp" {print $10; exit}' || true)"
        local kind="missing"
        if [ -n "$grip" ] && [ -f "$GNUPGHOME/private-keys-v1.d/$grip.key" ]; then
          if grep -q "shadowed-private-key" "$GNUPGHOME/private-keys-v1.d/$grip.key" 2>/dev/null; then
            kind="card-stub"
          else
            kind="real"
          fi
        fi
        # Label via the shared helper so it always agrees with the keytocard hint.
        local label
        label="$(cap_slot_label "$cap" | cut -d: -f2)"
        echo "  subkey key $keyidx  [$label]  $kid  ->  $kind"
        if [ "$kind" = "real" ]; then
          plan+=("$keyidx:$cap")
        fi
        ;;
    esac
  done < <(gpg --with-colons --list-keys "$GPG_KEY_ID" 2>/dev/null || true)

  if [ "${#plan[@]}" -eq 0 ]; then
    echo
    echo "VERDICT: a true GPG clone is NOT possible from what's available."
    note "No extractable secret subkey material was found (only card stubs or nothing)."
    note "If your keys were generated on-card, the private material was never exportable."
    note "Options:"
    note "  • locate your secret-key backup and re-run with GPG_SECRET_BACKUP=/path"
    note "  • --skip-gpg and just provision FIDO2 + age on the spare"
    note "  • generate a fresh GPG key (the air-gapped ceremony — not done by this tool)"
    if ! confirm "Continue with the remaining (FIDO2/age) steps?"; then die "stopped"; fi
    return 0
  fi

  echo
  echo "VERDICT: clone IS possible — found real material for ${#plan[@]} subkey(s)."

  # Fingerprint match check against the source card, if we read one.
  if [ "${#src_fprs[@]}" -gt 0 ]; then
    local bk_fprs=()
    mapfile -t bk_fprs < <(gpg --with-colons --fingerprint --fingerprint "$GPG_KEY_ID" 2>/dev/null |
      awk -F: '$1=="fpr"{print $10}' || true)
    local matched=0 a b
    for a in "${src_fprs[@]}"; do
      for b in "${bk_fprs[@]}"; do
        if [ "$a" = "$b" ]; then matched=1; fi
      done
    done
    if [ "$matched" -eq 1 ]; then
      note "Backup matches the source card's fingerprints. ✓"
    else
      echo "WARNING: the backup's fingerprints do NOT match the source card." >&2
      note "The spare would carry a DIFFERENT identity than your source key."
      confirm "Proceed anyway?" || die "stopped"
    fi
  fi

  echo
  echo "The next step OVERWRITES the OpenPGP keys on the target ($TARGET)."
  confirm "Write these subkeys to the target now?" || {
    echo "Skipping the GPG write."
    return 0
  }

  isolate_target "$TARGET"
  echo
  echo "Target's current OpenPGP state:"
  ykman --device "$TARGET" openpgp info 2>/dev/null | sed 's/^/  /' || true

  # Print the exact, computed keytocard sequence and run the editor interactively.
  # (Interactive, not blind-scripted: gpg only prompts for a destination slot when
  # the subkey's capability is ambiguous, and a stray fed line would desync.)
  echo
  echo "In the gpg editor that opens, type EXACTLY these lines (admin PIN = card admin PIN):"
  hr
  local p idx capf csl slot clab amb
  for p in "${plan[@]}"; do
    idx="${p%%:*}"
    capf="${p#*:}"
    csl="$(cap_slot_label "$capf")"
    slot="$(echo "$csl" | cut -d: -f1)"
    clab="$(echo "$csl" | cut -d: -f2)"
    amb="$(echo "$csl" | cut -d: -f3)"
    echo "  key $idx"
    if [ "$amb" = "yes" ]; then
      echo "  keytocard      # AMBIGUOUS subkey (caps=$capf): gpg lists several slots —"
      echo "                 # pick the one matching its role (Signature=1 / Encryption=2 / Authentication=3)"
    else
      echo "  keytocard      # then choose ($slot) $clab key, if asked"
    fi
    echo "  key $idx       # deselect before the next one"
  done
  echo "  save"
  hr
  confirm "Open the gpg editor now?" || {
    echo "Skipping the GPG write. Re-run when ready."
    return 0
  }
  assert_target_alone
  gpg --expert --edit-key "$GPG_KEY_ID" || echo "gpg --edit-key exited non-zero." >&2

  # Touch policy is not auto-copied (parsing it is brittle and setting the wrong
  # one is worse than a reminder). Show the source's policy so you can match it.
  if [ -n "$src_info" ]; then
    echo
    echo "Source card OpenPGP touch policy (match it on the target if you want parity):"
    printf '%s\n' "$src_info" | grep -iE 'touch' | sed 's/^/  /' || true
    note "set with: ykman --device $TARGET openpgp keys set-touch <sig|enc|aut> <off|on|fixed|cached>"
  fi

  echo
  echo "GPG write done. Before trusting the spare:"
  note "change its PINs:  ykman --device $TARGET openpgp access change-pin"
  note "                  ykman --device $TARGET openpgp access change-admin-pin"
  note "set cardholder:   gpg --card-edit  → admin → name"
  note "verify:           ykman --device $TARGET openpgp info"
}

# ---- FIDO2 resident SSH (installer login) ----------------------------------

fido2_step() {
  echo
  hr
  echo "FIDO2 resident SSH — installer-ISO login (device-bound; fresh key)"
  hr
  have ssh-keygen || {
    echo "ssh-keygen not found — skipping FIDO2." >&2
    return 0
  }

  local outdir
  outdir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$outdir'" RETURN

  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"

  isolate_target "$TARGET"
  assert_target_alone
  echo "Generating a NEW resident key on the target (touch + PIN when prompted)…"
  if ssh-keygen -t ed25519-sk -O resident -O application="$SSH_FIDO2_APPLICATION" \
    -C "yubikey-clone backup SN$TARGET" -N "" -f "$outdir/$SSH_BACKUP_KEY_NAME"; then
    local pub="$outdir/$SSH_BACKUP_KEY_NAME.pub"
    echo
    echo "New FIDO2 SSH public key:"
    sed 's/^/  /' "$pub"
    # Persist to ~/.ssh and only claim success if the writes actually landed.
    if install -m 600 "$outdir/$SSH_BACKUP_KEY_NAME" "$HOME/.ssh/$SSH_BACKUP_KEY_NAME" &&
      install -m 644 "$pub" "$HOME/.ssh/$SSH_BACKUP_KEY_NAME.pub"; then
      echo "Saved to ~/.ssh/$SSH_BACKUP_KEY_NAME (+ .pub)."
    else
      echo "WARNING: could not write to ~/.ssh — the on-disk handle was NOT saved." >&2
      note "the resident key still lives ON the Yubikey; re-extract later with: (cd ~/.ssh && ssh-keygen -K)"
    fi
    echo
    echo "Register it so the spare can log into the installer + this user:"
    note "add as            $CONFIG_PATH/iso/public_keys/$SSH_BACKUP_KEY_NAME.pub"
    note "and to the user's public_keys/ dir (openssh.authorizedKeys.keyFiles)"
    note "then: git add the files and rebuild."
  else
    echo "ssh-keygen failed — is the target present and its FIDO2 PIN set?" >&2
  fi
}

# ---- age-plugin-yubikey identity (agenix decryption) -----------------------

age_step() {
  echo
  hr
  echo "age identity — agenix decryption (device-bound PIV; fresh key)"
  hr
  have age-plugin-yubikey || {
    echo "age-plugin-yubikey not found — skipping age." >&2
    return 0
  }

  echo "NOTE: cala-m-os already reserves a dedicated 'backup' age recipient"
  note "($CONFIG_PATH/modules/agenix/identities/backup.key, in every secret)."
  note "Only generate here if this spare is a NEW recipient or you are replacing that one."
  echo "This OVERWRITES the chosen PIV slot on the target."
  confirm "Generate a new age identity on the target?" || {
    echo "Skipping age."
    return 0
  }

  isolate_target "$TARGET"
  assert_target_alone
  local args=(--generate --serial "$TARGET" --pin-policy "$AGE_PIN_POLICY" --touch-policy "$AGE_TOUCH_POLICY")
  if [ -n "$AGE_SLOT" ]; then args+=(--slot "$AGE_SLOT"); fi
  echo "Generating (pin-policy=$AGE_PIN_POLICY touch-policy=$AGE_TOUCH_POLICY)…"
  local out
  if out="$(age-plugin-yubikey "${args[@]}" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^/  /'
    local recipient
    recipient="$(printf '%s\n' "$out" | grep -oE 'age1yubikey[0-9a-z]+' | head -n1 || true)"
    echo
    echo "Register this spare as an agenix recipient:"
    if [ -n "$recipient" ]; then note "recipient:  $recipient"; fi
    note "1) save the AGE-PLUGIN-YUBIKEY-… stub as $CONFIG_PATH/modules/agenix/identities/<name>.key"
    note "   and add it to age.identityPaths in modules/agenix/configuration.nix"
    note "2) add the age1yubikey… line to the relevant secrets.nix recipient lists"
    note "3) re-key every affected secret:  agenix -r   (run per bundle dir)"
    note "4) git add the new files, then rebuild."
  else
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    echo "age-plugin-yubikey failed (slot in use? PIN/PUK locked?)." >&2
  fi
}

# ---- run -------------------------------------------------------------------

if [ "$do_gpg" -eq 1 ]; then gpg_step; fi
if [ "$do_fido2" -eq 1 ]; then fido2_step; fi
if [ "$do_age" -eq 1 ]; then age_step; fi

echo
hr
echo "Done. The spare carries only what each step reported above."
note "GPG (if cloned) gives identical git signing + SSH — no repo change needed."
note "FIDO2 + age are fresh identities — register their public keys as printed."
hr
