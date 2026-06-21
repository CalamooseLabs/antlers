# arr-restore — rebuild a Servarr app's state from its backups on the NAS.
#
# Generic, env-driven unification of the former sonarr-restore / radarr-restore
# / prowlarr-restore commands (was modules/arr-restore/restore.nix + restore.sh).
# The *arr apps run their own scheduled backups (Settings -> General -> Backups)
# straight onto the mounted NAS share, so there is no separate backup step — this
# just pulls the newest backup zip back after a teardown/rebuild, the same way
# plex-restore rebuilds Plex from a mounted backup.
#
# A backup zip contains the app database (<app>.db) plus config.xml (which holds
# the API key); restoring both brings the server back as the same instance with
# the same library/indexers and keeps the Prowlarr <-> *arr <-> download-client
# API keys consistent. The NixOS module still pins port/bind/update via env vars,
# so a restored config.xml cannot drag those back to stale values.
#
# Everything is validated BEFORE the live service is touched: if no valid backup
# is found the script aborts without stopping the service or deleting anything.
#
# Configuration (env vars, with the former sonarr defaults baked in):
#   ARR_APP        short app name, also used in messages   (default: sonarr)
#   ARR_PORT       web/API port for the /ping health check (default: 8989)
#   ARR_DATA_DIR   the app's data dir (services.<app>.dataDir)
#                                  (default: /var/lib/sonarr/.config/NzbDrone)
#   ARR_BACKUP_DIR mounted NAS backup share              (default: /mnt/backups/sonarr)
#   ARR_DB         database filename inside the zip       (default: <ARR_APP>.db)
#   ARR_SERVICE    systemd unit to stop/start             (default: <ARR_APP>.service)
#
# Usage:
#   arr-restore               restore the newest backup zip
#   arr-restore --list        list available backup zips (newest first), exit
#   arr-restore --from <zip>  restore from a specific backup zip
#   arr-restore --help        show this help
#
# Re-execs itself under sudo when not already root.

APP="${ARR_APP:-sonarr}"
PORT="${ARR_PORT:-8989}"
DATADIR="${ARR_DATA_DIR:-/var/lib/sonarr/.config/NzbDrone}"
BACKUP="${ARR_BACKUP_DIR:-/mnt/backups/sonarr}"
DB="${ARR_DB:-${APP}.db}"
SERVICE="${ARR_SERVICE:-${APP}.service}"

usage() {
  cat <<EOF
${APP}-restore — restore ${APP} from its backups on ${BACKUP}

  ${APP}-restore               restore the newest backup zip
  ${APP}-restore --list        list available backup zips (newest first), exit
  ${APP}-restore --from <zip>  restore from a specific backup zip
  ${APP}-restore --help        show this help
EOF
}

# Newest-first list of backup zips on the share (sorted by mtime).
list_backups() {
  [ -d "$BACKUP" ] || return 0
  find "$BACKUP" -type f -name '*_backup_*.zip' -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | cut -d' ' -f2-
}

orig_args=("$@")
from=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list)
      list_backups
      exit 0
      ;;
    --from)
      shift
      from="${1:-}"
      if [ -z "$from" ]; then
        echo "${APP}-restore: --from requires a backup zip path." >&2
        exit 1
      fi
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "${APP}-restore: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -- "$0" "${orig_args[@]}"
fi

if ! mountpoint -q "$BACKUP"; then
  echo "${APP}-restore: backup share $BACKUP is not mounted; aborting." >&2
  exit 1
fi

if [ ! -d "$DATADIR" ]; then
  echo "${APP}-restore: data dir $DATADIR does not exist." >&2
  echo "  Start ${SERVICE} once so it is created, then re-run ${APP}-restore." >&2
  exit 1
fi

# --- Resolve + validate the backup BEFORE touching the live service. ---
if [ -n "$from" ]; then
  zip="$from"
else
  zip="$(list_backups | head -1)"
fi

if [ -z "$zip" ]; then
  echo "${APP}-restore: no backup zip (*_backup_*.zip) found under $BACKUP." >&2
  exit 1
fi
if [ ! -f "$zip" ]; then
  echo "${APP}-restore: backup not found: $zip" >&2
  exit 1
fi
if ! unzip -t -qq "$zip" >/dev/null 2>&1; then
  echo "${APP}-restore: '$zip' failed its zip integrity check; aborting." >&2
  exit 1
fi

# Locate the database + config inside the zip rather than assuming the layout.
db_entry="$(unzip -Z1 "$zip" | grep -E "(^|/)${DB}$" | head -1 || true)"
cfg_entry="$(unzip -Z1 "$zip" | grep -E "(^|/)config\.xml$" | head -1 || true)"

if [ -z "$db_entry" ]; then
  echo "${APP}-restore: '$zip' does not contain ${DB}; aborting." >&2
  echo "  zip contents:" >&2
  unzip -Z1 "$zip" | sed 's/^/    /' >&2
  exit 1
fi

echo "${APP}-restore: restoring from $zip"

# --- Apply. ---
echo "${APP}-restore: stopping ${SERVICE} ..."
systemctl stop "$SERVICE" || true

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unzip -o -q "$zip" -d "$tmp"

cp -f "$tmp/$db_entry" "$DATADIR/$DB"
echo "${APP}-restore: restored database $DB"

if [ -n "$cfg_entry" ] && [ -f "$tmp/$cfg_entry" ]; then
  cp -f "$tmp/$cfg_entry" "$DATADIR/config.xml"
  echo "${APP}-restore: restored config.xml"
else
  echo "${APP}-restore: WARNING no config.xml in backup; the API key may change." >&2
fi

# Drop stale WAL/SHM so the restored database is authoritative.
rm -f "$DATADIR/$DB-wal" "$DATADIR/$DB-shm"

# Match ownership to the data dir. This covers sonarr/radarr (static uids) and
# prowlarr (DynamicUser, whose uid is allocated at runtime) without hard-coding.
chown --reference="$DATADIR" "$DATADIR/$DB"
if [ -f "$DATADIR/config.xml" ]; then
  chown --reference="$DATADIR" "$DATADIR/config.xml"
fi

echo "${APP}-restore: starting ${SERVICE} ..."
systemctl start "$SERVICE"

# --- Best-effort post-start check that the app actually came up. ---
echo "${APP}-restore: waiting for ${APP} to respond on :${PORT} ..."
ok=0
for ((n = 0; n < 30; n++)); do
  if curl -sf "http://127.0.0.1:${PORT}/ping" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

if [ "$ok" -eq 1 ]; then
  echo "${APP}-restore: ${APP} is up on :${PORT}."
else
  echo "${APP}-restore: WARNING ${APP} did not answer /ping on :${PORT} within 30s; check 'systemctl status ${SERVICE}'." >&2
fi

echo "${APP}-restore: done."
