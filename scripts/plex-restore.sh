## plex-restore — restore Plex state from the NAS backup share.
## Host-specific values are overridable via env vars (DEFAULT == current value).
## NOTE: writeShellApplication injects shebang + "set -euo pipefail"; do not add them.

PLEX_DATA_DIR="${PLEX_DATA_DIR:-/var/lib/plex}"
PMS="$PLEX_DATA_DIR/Plex Media Server"
DB_DIR="$PMS/Plug-in Support/Databases"
BACKUP="${BACKUP_DIR:-/mnt/backup}"
AUTO_DIR="$BACKUP/automated"
PLEX_USER="${PLEX_USER:-plex}"
PLEX_GROUP="${PLEX_GROUP:-plex}"
PLEX_SERVICE="${PLEX_SERVICE:-plex.service}"
PLEX_PORT="${PLEX_PORT:-32400}"
PRIMARY_DB="${PLEX_PRIMARY_DB:-com.plexapp.plugins.library.db}"
PLEX_BLOBS_DB="${PLEX_BLOBS_DB:-com.plexapp.plugins.library.blobs.db}"

DATABASES=(
  "$PRIMARY_DB"
  "$PLEX_BLOBS_DB"
)

usage() {
  cat <<EOF
plex-restore — restore Plex state from $BACKUP

  plex-restore                restore Preferences.xml + the newest DB snapshot
  plex-restore --list         list available DB snapshots, then exit
  plex-restore --from <dir>   restore databases from a specific snapshot dir
  plex-restore --prefs-only   restore Preferences.xml only (skip databases)
  plex-restore --help         show this help
EOF
}

orig_args=("$@")
from=""
prefs_only=0

while [ $# -gt 0 ]; do
  case "$1" in
    --list)
      if [ -d "$AUTO_DIR" ]; then
        find "$AUTO_DIR" -mindepth 1 -maxdepth 1 -type d -name 'nixos-plex-*' ! -name '*.partial' | sort
      fi
      exit 0
      ;;
    --from)
      shift
      from="${1:-}"
      if [ -z "$from" ]; then
        echo "plex-restore: --from requires a snapshot directory." >&2
        exit 1
      fi
      shift
      ;;
    --prefs-only)
      prefs_only=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "plex-restore: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -- "$0" "${orig_args[@]}"
fi

if ! mountpoint -q "$BACKUP"; then
  echo "plex-restore: backup share $BACKUP is not mounted; aborting." >&2
  exit 1
fi

# --- Resolve sources and validate BEFORE touching the live server. ---
snapshot=""
if [ "$prefs_only" -eq 0 ]; then
  if [ -n "$from" ]; then
    snapshot="$from"
  else
    snapshot="$(find "$AUTO_DIR" -mindepth 1 -maxdepth 1 -type d -name 'nixos-plex-*' ! -name '*.partial' 2>/dev/null | sort | tail -1 || true)"
  fi

  if [ -n "$snapshot" ]; then
    if [ ! -d "$snapshot" ]; then
      echo "plex-restore: snapshot directory not found: $snapshot" >&2
      exit 1
    fi
    if [ ! -f "$snapshot/$PRIMARY_DB" ]; then
      echo "plex-restore: '$snapshot' is not a valid snapshot (missing $PRIMARY_DB); aborting." >&2
      exit 1
    fi
  fi
fi

# Prefer the chosen snapshot's own Preferences.xml so identity + databases come
# from a single backup run; fall back to the share-root copy otherwise.
prefs_src=""
if [ -n "$snapshot" ] && [ -f "$snapshot/Preferences.xml" ]; then
  prefs_src="$snapshot/Preferences.xml"
elif [ -f "$BACKUP/Preferences.xml" ]; then
  prefs_src="$BACKUP/Preferences.xml"
fi

if [ -z "$prefs_src" ] && [ -z "$snapshot" ]; then
  echo "plex-restore: nothing to restore under $BACKUP (no Preferences.xml, no snapshot)." >&2
  exit 1
fi

# --- Apply. ---
echo "plex-restore: stopping $PLEX_SERVICE ..."
systemctl stop "$PLEX_SERVICE" || true

install -d -o "$PLEX_USER" -g "$PLEX_GROUP" "$PMS"

if [ -n "$prefs_src" ]; then
  cp -f "$prefs_src" "$PMS/Preferences.xml"
  echo "plex-restore: restored Preferences.xml from $prefs_src"
fi

restored=0
if [ -n "$snapshot" ]; then
  install -d -o "$PLEX_USER" -g "$PLEX_GROUP" "$DB_DIR"
  for db in "${DATABASES[@]}"; do
    if [ -f "$snapshot/$db" ]; then
      cp -f "$snapshot/$db" "$DB_DIR/$db"
      restored=$((restored + 1))
    fi
  done
  if [ "$restored" -gt 0 ]; then
    # Drop stale WAL/SHM so the restored databases are authoritative.
    rm -f "$DB_DIR/"*.db-wal "$DB_DIR/"*.db-shm
  fi
  echo "plex-restore: restored $restored database(s) from $snapshot"
fi

chown -R "$PLEX_USER":"$PLEX_GROUP" "$PLEX_DATA_DIR"
echo "plex-restore: starting $PLEX_SERVICE ..."
systemctl start "$PLEX_SERVICE"

# --- Best-effort post-start check that the server actually came up. ---
echo "plex-restore: waiting for Plex to respond ..."
ident=""
for ((n = 0; n < 30; n++)); do
  if ident="$(curl -sf "http://127.0.0.1:$PLEX_PORT/identity" 2>/dev/null)"; then
    break
  fi
  sleep 1
done

if [ -n "$ident" ]; then
  mid="$(printf '%s' "$ident" | grep -o 'machineIdentifier="[^"]*"' | head -1 || true)"
  echo "plex-restore: Plex is up (${mid:-identity returned})."
  echo "plex-restore: NOTE confirm the server shows as claimed/online at https://app.plex.tv;"
  echo "              if it is not, sign in / re-claim it once to relink the account."
else
  echo "plex-restore: WARNING Plex did not answer on :$PLEX_PORT within 30s; check 'systemctl status plex'." >&2
fi

echo "plex-restore: done."
