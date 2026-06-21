if [ "$(id -u)" -eq 0 ]; then
  echo "Run ssh-key-import as your user, not root — the keys go in your ~/.ssh." >&2
  exit 1
fi

SSH_DIR="$HOME/.ssh"
KEY_NAME="${SSH_KEY_NAME:-id_ed25519_sk}"

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
cd "$SSH_DIR" || exit 1

if [ -f "$SSH_DIR/$KEY_NAME" ] && [ "${1:-}" != "--force" ]; then
  echo "$SSH_DIR/$KEY_NAME already exists — pass --force to re-extract."
else
  echo "Touch your Yubikey and enter its PIN to download the resident SSH keys…"
  # Writes id_ed25519_sk_rk[_<application>] (+ .pub) into the current dir.
  ssh-keygen -K

  # Collect the freshly downloaded private resident keys (glob, not ls|grep).
  keys=()
  for f in id_ed25519_sk_rk*; do
    [ -e "$f" ] || continue
    case "$f" in
      *.pub) ;;
      *) keys+=("$f") ;;
    esac
  done

  if [ "${#keys[@]}" -eq 0 ]; then
    echo "No id_ed25519_sk_rk* key was downloaded — is the right Yubikey present? Aborting." >&2
    exit 1
  fi
  if [ "${#keys[@]}" -gt 1 ]; then
    echo "Multiple resident keys downloaded: ${keys[*]}" >&2
    echo "Rename the one you want to $KEY_NAME (+ .pub) yourself, then ssh-add it. Aborting." >&2
    exit 1
  fi
  rk="${keys[0]}"

  mv -f "$rk" "$KEY_NAME"
  chmod 600 "$KEY_NAME"
  if [ -f "$rk.pub" ]; then
    mv -f "$rk.pub" "$KEY_NAME.pub"
    chmod 644 "$KEY_NAME.pub"
  fi
  echo "Installed $SSH_DIR/$KEY_NAME (+ .pub)."
fi

# Add to the running agent (gpg-agent provides the SSH socket on this host).
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  ssh-add "$SSH_DIR/$KEY_NAME" \
    || echo "ssh-add failed — make sure the Yubikey is present, then: ssh-add $SSH_DIR/$KEY_NAME"
else
  echo "No SSH agent in this shell. Start one and add the key:"
  echo "  eval \"\$(ssh-agent -s)\" && ssh-add $SSH_DIR/$KEY_NAME"
fi
