if [ "$(id -u)" -eq 0 ]; then
  echo "Run gpg-key-import as your user, not root — the key imports into the invoking user's keyring." >&2
  exit 1
fi

ASC="${GPG_KEY_FILE:-/run/agenix/yubigpg.asc}"
KEY_ID="${GPG_KEY_ID:-50D56BF0B93CA212}"

read_asc() {
  if [ -r "$ASC" ]; then cat "$ASC"; else sudo cat "$ASC"; fi
}

if ! { [ -r "$ASC" ] || sudo test -r "$ASC"; }; then
  echo "$ASC not available — is enableSecrets on and the Yubikey present at boot? Skipping." >&2
  exit 0
fi

if gpg --list-keys "$KEY_ID" >/dev/null 2>&1; then
  echo "GPG key $KEY_ID already in your keyring — nothing to do."
  exit 0
fi

echo "Importing Yubikey GPG public key ($KEY_ID) into your keyring…"
read_asc | gpg --import
echo "Done. Verify with: gpg --list-keys $KEY_ID"
