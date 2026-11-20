# proton-secrets-fetch — the one engine behind services.proton-secrets.
# (writeShellApplication supplies the shebang, `set -euo pipefail` and shellcheck.)
#
# Every path that touches pass-cli goes through here: the activation snippets, the
# proton-secrets-fetch / proton-secrets-restore units and the `proton-secrets` CLI.
# What to fetch and where to put it comes from a JSON manifest the module writes,
# so the same script runs outside NixOS (the flake check drives it with a stub
# pass-cli against temp directories).
#
#   proton-secrets-fetch [--manifest FILE] <command> [args]
#     activate   fetch during NixOS activation; `failClosed` decides what a failure does
#     unit       fetch from proton-secrets-fetch.service; always installs what it has
#     restore    link the sealed last-known-good cache as the first generation (no network)
#     mount      mount the ramfs that holds the generations
#     chown      re-apply owner/group to the linked secrets (after users/groups exist)
#     probe      print the session's state:
#                ok | no-session | store-corrupt | session-rejected | network | unknown
#     login      log in from the PAT when there is no usable session
#     repair     `pass-cli logout --force`, then log in again from the PAT
#     doctor     print a diagnosis (never a secret value, never the PAT)
#     refresh    restart the fetch unit, wait for it and print how it went
#     exec ARGS  run `pass-cli ARGS` under the shared lock
#
# --manifest is authoritative. Without it the manifest is $PROTON_SECRETS_MANIFEST,
# else the baked default path if it exists, and the session commands also honour
# PROTON_PASS_SESSION_DIR / PROTON_PASS_KEY_PROVIDER / PROTON_PASS_PAT_FILE /
# PROTON_PASS_PERSONAL_ACCESS_TOKEN — so the CLI works on a box without the module
# (the installer image).
#
# Exit codes of `activate` and `unit` (systemd tells "try again" from "a human must
# act" by them; `activate` with failClosed=false warns and exits 0 instead):
#    0  every non-optional secret was read from Proton in this run
#   75  temporary — Proton unreachable, 5xx/429, lock busy, an error not recognised.
#       Nothing was destroyed; run again later.
#   78  permanent until someone acts — the PAT was rejected, there is no session and
#       no PAT, or a required field is missing or blank.
# `login` adds 3: no PAT is available, so only an interactive login can help.
#
# pass-cli exits 1 for every failure, so the cause is read from its stderr. The
# signatures below are the ones pass-cli 2.1.3 and 2.4.1 print. Anything not
# recognised is "unknown" and is retried later without touching the session:
# `logout --force` also wipes a healthy session, so it is only ever run when a PAT
# is there to log in again, and at most once per run. What each class leads to:
#   network           wait a little in this run, then exit 75; never log in or out
#   no-session        log in from the PAT (through the environment, not argv)
#   store-corrupt     \ only a reset gets out of these: `logout --force`, then
#   session-rejected  / log in from the PAT. Without a PAT: exit 78, nothing removed
#   pat-key           a read fails because pass-cli's stored PAT key is gone (a
#                     power cut right after a login): same reset, then read again
#   pat-invalid       exit 78; that PAT is not presented again until its file
#                     changes, `patRetryAfter` passes or `repair` is run
#   vault / missing / blank   that one secret is reported; the others are installed
#
# Test seams (a "seams" object in the manifest; the module never writes one):
#   root          prefix for every runtime path in the manifest, like DESTDIR
#   unprivileged  true: generations are plain directories (no ramfs mount) and
#                 nothing is chowned
#   systemctl     command run instead of systemctl
#   systemdCreds  command run instead of systemd-creds

EX_USAGE=64
EX_NO_PAT=3
EX_TEMPORARY=75
EX_PERMANENT=78

log() { printf '[proton-secrets] %s\n' "$*" >&2; }
warn() { printf '[proton-secrets] WARNING: %s\n' "$*" >&2; }
err() { printf '[proton-secrets] ERROR: %s\n' "$*" >&2; }

usage() {
  cat >&2 <<'EOF'
usage: proton-secrets-fetch [--manifest FILE] <command> [args]
  activate | unit | restore | mount | chown | refresh     (need a manifest)
  probe | login | repair [--force] | doctor | exec <pass-cli args>
EOF
}

# ---- configuration -----------------------------------------------------------

MANIFEST=""
MANIFEST_EXPLICIT=0
if [ "${1:-}" = --manifest ]; then
  if [ "$#" -lt 2 ]; then
    usage
    exit "$EX_USAGE"
  fi
  MANIFEST=$2
  MANIFEST_EXPLICIT=1
  shift 2
elif [ -n "${PROTON_SECRETS_MANIFEST:-}" ]; then
  MANIFEST=$PROTON_SECRETS_MANIFEST
elif [ -r '__DEFAULT_MANIFEST__' ]; then
  MANIFEST='__DEFAULT_MANIFEST__'
fi
CMD=${1:-help}
shift || true

# Defaults for a box without the module; a manifest replaces all of them.
ROOT=""
UNPRIVILEGED=0
SYSTEMCTL=systemctl
CREDS=systemd-creds
SESSION_DIR='__DEFAULT_SESSION_DIR__'
KEY_PROVIDER='__DEFAULT_KEY_PROVIDER__'
PAT_FILE=""
SECRETS_DIR=""
MOUNT_POINT=""
STATUS_FILE=""
LOCK_FILE=/run/lock/proton-pass-cli.lock
FAIL_CLOSED=1
PROBE_ATTEMPTS=3
PROBE_DELAY=5
FETCH_RETRIES=2
FETCH_RETRY_DELAY=3
T_PROBE=45
T_LOGIN=45
T_ITEM=120
T_LOCK=120
RUN_BUDGET=270
PAT_RETRY_AFTER=900
UNIT_NAME=""
CACHE_ENABLE=0
CACHE_DIR=""
CACHE_KEY=host
GLOBAL_UNITS=""
S_NAME=()
S_PATH=()
S_MODE=()
S_OWNER=()
S_GROUP=()
S_SYMLINK=()
S_OPTIONAL=()
S_ARGS=()
S_UNITS=()

load_manifest() {
  local vars
  if [ ! -r "$MANIFEST" ]; then
    err "manifest $MANIFEST is not readable"
    exit "$EX_USAGE"
  fi
  # jq's @sh quotes every value, so the eval only ever sees literals.
  if ! vars=$(jq -r '
    @sh "M_VERSION=\(.version // 0)",
    @sh "ROOT=\(.seams.root // "")",
    @sh "UNPRIVILEGED=\(if .seams.unprivileged then 1 else 0 end)",
    @sh "SYSTEMCTL=\(.seams.systemctl // "systemctl")",
    @sh "CREDS=\(.seams.systemdCreds // "systemd-creds")",
    @sh "SESSION_DIR=\(.sessionDir)",
    @sh "KEY_PROVIDER=\(.keyProvider)",
    @sh "PAT_FILE=\(.patFile // "")",
    @sh "SECRETS_DIR=\(.secretsDir)",
    @sh "MOUNT_POINT=\(.secretsMountPoint)",
    @sh "STATUS_FILE=\(.statusFile)",
    @sh "LOCK_FILE=\(.lockFile)",
    @sh "FAIL_CLOSED=\(if .failClosed then 1 else 0 end)",
    @sh "PROBE_ATTEMPTS=\(.probeAttempts)",
    @sh "PROBE_DELAY=\(.probeDelay)",
    @sh "FETCH_RETRIES=\(.fetchRetries)",
    @sh "FETCH_RETRY_DELAY=\(.fetchRetryDelay)",
    @sh "T_PROBE=\(.timeouts.probe)",
    @sh "T_LOGIN=\(.timeouts.login)",
    @sh "T_ITEM=\(.timeouts.item)",
    @sh "T_LOCK=\(.timeouts.lock)",
    @sh "RUN_BUDGET=\(.runBudget)",
    @sh "PAT_RETRY_AFTER=\(.patRetryAfter // 900)",
    @sh "UNIT_NAME=\(.unitName // "")",
    @sh "CACHE_ENABLE=\(if .cache.enable then 1 else 0 end)",
    @sh "CACHE_DIR=\(.cache.directory)",
    @sh "CACHE_KEY=\(.cache.withKey)",
    "GLOBAL_UNITS=" + ((.restartUnits // []) | @sh | @sh),
    (.secrets | to_entries[] | .key as $i | .value |
      @sh "S_NAME[\($i)]=\(.name)",
      @sh "S_PATH[\($i)]=\(.path)",
      @sh "S_MODE[\($i)]=\(.mode)",
      @sh "S_OWNER[\($i)]=\(.owner)",
      @sh "S_GROUP[\($i)]=\(.group)",
      @sh "S_SYMLINK[\($i)]=\(if .symlink then 1 else 0 end)",
      @sh "S_OPTIONAL[\($i)]=\(if .optional then 1 else 0 end)",
      "S_ARGS[\($i)]=" + ((
          [.reference // empty]
          + (if .vaultName != null then ["--vault-name", .vaultName] else [] end)
          + (if .itemTitle != null then ["--item-title", .itemTitle] else [] end)
          + (if .field != null then ["--field", .field] else [] end)
        ) | @sh | @sh),
      "S_UNITS[\($i)]=" + ((.restartUnits // []) | @sh | @sh))
  ' "$MANIFEST"); then
    err "manifest $MANIFEST could not be parsed"
    exit "$EX_USAGE"
  fi
  local M_VERSION=0
  eval "$vars"
  if [ "$M_VERSION" != 1 ]; then
    err "manifest $MANIFEST has version '$M_VERSION'; this proton-secrets-fetch reads version 1"
    exit "$EX_USAGE"
  fi
  SESSION_DIR="$ROOT$SESSION_DIR"
  SECRETS_DIR="$ROOT$SECRETS_DIR"
  MOUNT_POINT="$ROOT$MOUNT_POINT"
  STATUS_FILE="$ROOT$STATUS_FILE"
  LOCK_FILE="$ROOT$LOCK_FILE"
  CACHE_DIR="$ROOT$CACHE_DIR"
  if [ -n "$PAT_FILE" ]; then PAT_FILE="$ROOT$PAT_FILE"; fi
  local i
  for i in "${!S_PATH[@]}"; do S_PATH[i]="$ROOT${S_PATH[i]}"; done
}

if [ -n "$MANIFEST" ]; then load_manifest; fi

# The CLI on a box without the module (or pointed elsewhere on purpose) follows the
# environment; activation and the units pass --manifest and never do.
PAT=""
if [ "$MANIFEST_EXPLICIT" -eq 0 ]; then
  SESSION_DIR=${PROTON_PASS_SESSION_DIR:-$SESSION_DIR}
  KEY_PROVIDER=${PROTON_PASS_KEY_PROVIDER:-$KEY_PROVIDER}
  PAT_FILE=${PROTON_PASS_PAT_FILE:-$PAT_FILE}
  PAT=${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}
fi
# pass-cli only reads the PAT on `login`; it is handed to that one call and kept
# out of every other child's environment.
unset PROTON_PASS_PERSONAL_ACCESS_TOKEN
export PROTON_PASS_SESSION_DIR="$SESSION_DIR"
export PROTON_PASS_KEY_PROVIDER="$KEY_PROVIDER"
export PROTON_PASS_NO_UPDATE_CHECK=1

need_manifest() {
  if [ -z "$MANIFEST" ]; then
    err "'$CMD' needs a manifest (--manifest FILE); none was given and __DEFAULT_MANIFEST__ does not exist"
    exit "$EX_USAGE"
  fi
}

# On a real host the module's tmpfiles rule owns this directory; the first
# activation of a fresh install and the installer image get here before it.
ensure_session_dir() {
  if [ ! -d "$SESSION_DIR" ]; then (umask 077 && mkdir -p "$SESSION_DIR") 2>/dev/null || true; fi
}

# ---- lock --------------------------------------------------------------------

# One flock for every pass-cli call on this box. pass-cli has no locking of its
# own, and two processes started together on an empty session directory each
# write their own local.key: the store is then unreadable until `logout --force`.
# The fetch holds it for its whole run, which also keeps two runs from building
# the same generation.
LOCKED=0
acquire_lock() { # <seconds to wait>
  local wait=$1
  if [ "$LOCKED" -eq 1 ]; then return 0; fi
  mkdir -p "$(dirname "$LOCK_FILE")" 2>/dev/null || true
  if ! { exec 9>>"$LOCK_FILE"; } 2>/dev/null; then
    # Not root (or /run/lock is not there to write to): whoever can use the
    # session directory can lock inside it.
    ensure_session_dir
    LOCK_FILE="$SESSION_DIR/.proton-secrets.lock"
    if ! { exec 9>>"$LOCK_FILE"; } 2>/dev/null; then
      err "cannot open a lock file ($LOCK_FILE)"
      return 1
    fi
  fi
  if ! flock -n 9; then
    log "another proton-secrets run holds $LOCK_FILE; waiting up to ${wait}s..."
    if ! flock -w "$wait" 9; then
      err "still locked after ${wait}s"
      return 1
    fi
  fi
  LOCKED=1
}

# ---- pass-cli ----------------------------------------------------------------

# Seconds this run may still use. The unit's TimeoutStartSec is larger, so the
# engine gives up by itself rather than be killed in the middle of a pass-cli
# write to the session store.
remaining() { echo $((RUN_BUDGET - SECONDS)); }

# pass-cli's own words without colour codes, blank lines or the Rust backtrace,
# and with anything shaped like a PAT blanked.
detail() {
  printf '%s\n' "$1" |
    sed -E -e 's/\x1b\[[0-9;]*m//g' -e '/^Stack backtrace:/,$d' -e '/^[[:space:]]*$/d' \
      -e "s/pst_[^[:space:]']{8,}/pst_<redacted>/g" |
    tail -n 8 | cut -c1-400
}

classify() { # <exit code> <stderr>
  local rc=$1 text=$2
  if [ "$rc" -eq 0 ]; then
    echo ok
    return
  fi
  # timeout(1): 124 = timed out, 137 = had to be killed.
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo network
    return
  fi
  case "$text" in
    *"invalid, expired or has been deleted"* | *"Failed to parse personal access token"* | *"Failed to decode personal access token"*)
      echo pat-invalid
      ;;
    *"Error creating client features"* | *"Error decrypting local session"* | *"Failed to open encrypted database"* | *"hmac check failed"*)
      echo store-corrupt
      ;;
    # The server no longer knows the session. pass-cli 2.1.3 drops most of
    # .session by itself (and prints the "invalidated" text below); 2.4.1 keeps
    # the files, fails like this on every command and refuses to log in over them.
    *"non-existent session"* | *"non-existent auth session"*)
      echo session-rejected
      ;;
    *"lready authenticated"*)
      echo already
      ;;
    *"requires an authenticated client"* | *"invalidated by the server"* | *"have been logged out"* | *"is not logged in"*)
      echo no-session
      ;;
    *"no servers available"* | *"failed to connect to host"* | *"error during transmission"* | *"timed out"* | *"Invalid status code: 5"* | *"Invalid status code: 429"* | *"Reason: Banned"* | *"error resolving"* | *"Error listing vaults"*)
      echo network
      ;;
    # A session whose pat_key never reached the disk (power cut shortly after a
    # login) passes `info` and fails every read with this ERROR line.
    *"personal access token key"*)
      echo pat-key
      ;;
    # Without that line: the vault is not shared with this login, or misnamed.
    *"Could not find vault"*)
      echo vault
      ;;
    *"Field does not exist"* | *"Item not found"* | *"Could not find item"* | *"not found in item"* | *"not found in share"*)
      echo missing
      ;;
    *)
      echo unknown
      ;;
  esac
}

PC_RC=0
PC_ERR=""
PC_CLASS=""

# pcli <timeout> <stdout file> <pass-cli args>: one bounded, non-interactive call.
pcli() {
  local t=$1 out=$2 left
  shift 2
  PC_RC=0
  left=$(remaining)
  if [ "$left" -lt "$t" ]; then t=$left; fi
  if [ "$t" -lt 1 ]; then
    PC_RC=124
    PC_ERR="not run: this run's time budget (${RUN_BUDGET}s) is used up"
    PC_CLASS=network
    return 0
  fi
  PC_ERR=$(timeout --kill-after=10 "$t" pass-cli "$@" 2>&1 >"$out" </dev/null) || PC_RC=$?
  if [ "$PC_RC" -eq 124 ] || [ "$PC_RC" -eq 137 ]; then
    PC_ERR="pass-cli $1 did not finish within ${t}s"
  fi
  PC_CLASS=$(classify "$PC_RC" "$PC_ERR")
}

# `info` is the one cheap command that asks the server about the session.
# (`test` only pings an unauthenticated endpoint, and is gone from pass-cli 2.2.4+.)
probe() { pcli "$T_PROBE" /dev/null info; }

have_pat() {
  if [ -n "$PAT" ]; then return 0; fi
  if [ -n "$PAT_FILE" ] && [ -r "$PAT_FILE" ]; then
    # No whitespace belongs in a PAT; a stray CR or newline would fail the login.
    PAT=$(tr -d '[:space:]' <"$PAT_FILE") || PAT=""
  fi
  [ -n "$PAT" ]
}

pat_source() {
  if [ -n "$PAT_FILE" ]; then
    echo "$PAT_FILE"
  else
    echo "PROTON_PASS_PERSONAL_ACCESS_TOKEN"
  fi
}

# pass-cli writes local.key, pat_key and session.json without fsync. A power cut
# in the following half minute leaves pat_key empty next to an intact
# session.json: a session that looks fine and cannot read a single vault.
sync_session() {
  local d="$SESSION_DIR/.session" f
  local -a files=()
  if [ ! -d "$d" ]; then return 0; fi
  for f in "$d"/*; do
    if [ -f "$f" ]; then files+=("$f"); fi
  done
  sync "${files[@]}" "$d" 2>/dev/null || true
}

# A PAT Proton rejected is not presented again for a while unless its file
# changed. The unit itself does not retry that failure, but anything else that
# starts it (a restart-looping consumer with Wants= on it, a timer, a script)
# would otherwise mean a login with a dead token every few seconds.
IGNORE_PAT_COOLDOWN=0
pat_on_cooldown() {
  local marker="$STATUS_FILE.pat-rejected" age
  if [ "$IGNORE_PAT_COOLDOWN" -eq 1 ] || [ -z "$STATUS_FILE" ] || [ -z "$PAT_FILE" ]; then return 1; fi
  if [ ! -e "$marker" ] || [ "$PAT_FILE" -nt "$marker" ]; then return 1; fi
  age=$(($(date +%s) - $(stat -c %Y "$marker")))
  [ "$age" -lt "$PAT_RETRY_AFTER" ]
}

LOGGED_IN=0
login() {
  local t=$T_LOGIN left
  PC_RC=0
  left=$(remaining)
  if [ "$left" -lt "$t" ]; then t=$left; fi
  if [ "$t" -lt 1 ]; then
    PC_RC=124
    PC_ERR="not run: this run's time budget (${RUN_BUDGET}s) is used up"
    PC_CLASS=network
    return 0
  fi
  # The environment, not --pat: argv is world-readable in /proc for as long as
  # the login runs.
  PC_ERR=$(PROTON_PASS_PERSONAL_ACCESS_TOKEN="$PAT" timeout --kill-after=10 "$t" pass-cli login 2>&1 >/dev/null </dev/null) || PC_RC=$?
  if [ "$PC_RC" -eq 124 ] || [ "$PC_RC" -eq 137 ]; then
    PC_ERR="pass-cli login did not finish within ${t}s"
  fi
  PC_CLASS=$(classify "$PC_RC" "$PC_ERR")
  if [ "$PC_CLASS" = ok ]; then
    LOGGED_IN=1
    sync_session
    if [ -n "$STATUS_FILE" ]; then rm -f "$STATUS_FILE.pat-rejected"; fi
  elif [ "$PC_CLASS" = pat-invalid ] && [ -n "$STATUS_FILE" ]; then
    mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null || true
    touch "$STATUS_FILE.pat-rejected" 2>/dev/null || true
  fi
}

# `logout --force` makes no request and only removes .session (the PAT file next
# to it stays). It is the one reset that works on a torn store, where plain
# `logout` fails like every other command.
RESET_DONE=0
reset_session() {
  local out rc=0
  RESET_DONE=1
  log "resetting the local Proton Pass session (pass-cli logout --force)"
  out=$(timeout --kill-after=10 "$T_PROBE" pass-cli logout --force 2>&1 </dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then
    err "pass-cli logout --force failed (exit $rc):"
    detail "$out" >&2
    return 1
  fi
}

# ---- run result --------------------------------------------------------------

SESSION_STATE=not-probed
RUN_ERR_CLASS=""
RUN_ERR_MSG=""
RUN_ERR_DETAIL=""
RUN_ERR_PERMANENT=0

# Record why the run cannot verify the secrets. The first cause is the one kept.
run_fail() { # temporary|permanent <class> <message> [pass-cli stderr]
  err "$3"
  if [ -n "${4:-}" ]; then detail "$4" >&2; fi
  if [ -n "$RUN_ERR_CLASS" ]; then return 0; fi
  RUN_ERR_CLASS=$2
  RUN_ERR_MSG=$3
  RUN_ERR_DETAIL=$(detail "${4:-}")
  if [ "$1" = permanent ]; then RUN_ERR_PERMANENT=1; fi
}

pat_invalid_help() {
  err "Proton rejected the personal access token in $(pat_source)."
  err "  A PAT always expires (1 year at most) and can be deleted from the account."
  err "  From a machine logged in to the ACCOUNT (not with a PAT):"
  err "    pass-cli personal-access-token renew --expiration 1y    (or create a new one)"
  err "  put the token into the PAT file (mode 0600, one line), then run: proton-secrets repair"
  err "  (until that file changes, the fetch does not present this PAT again for $((PAT_RETRY_AFTER / 60)) minutes)"
}

no_pat_help() { # <what is wrong>
  err "$1, and no PAT is configured to log in again."
  err "  This is an interactive session; nothing was removed. As root on this box:"
  err "    proton-secrets repair --force    (drops the local session)"
  err "    proton-secrets login             (then log in again)"
}

explain() { # <class>
  case "$1" in
    ok) echo "the session is valid" ;;
    no-session) echo "there is no session" ;;
    store-corrupt) echo "the local session store is unreadable" ;;
    session-rejected) echo "Proton no longer accepts the stored session" ;;
    network) echo "Proton Pass cannot be reached (network, or Proton is down)" ;;
    *) echo "pass-cli failed in a way this script does not recognise" ;;
  esac
}

# Bring the session to "ok", or record why not and return 1. Never logs out of a
# session it cannot replace.
ensure_session() {
  local class tries=0 steps=0 last=probe
  probe
  class=$PC_CLASS
  while :; do
    steps=$((steps + 1))
    if [ "$steps" -gt 12 ]; then
      SESSION_STATE=unknown
      run_fail temporary unknown "the Proton Pass session keeps changing state; giving up for this run" "$PC_ERR"
      return 1
    fi
    case "$class" in
      ok)
        SESSION_STATE=ok
        return 0
        ;;
      network)
        # network-online.target does not mean the internet is reachable (on a
        # NetworkManager host it is reached with no route at all), so wait a
        # little here; the unit's back-off covers the long outages.
        tries=$((tries + 1))
        if [ "$tries" -ge "$PROBE_ATTEMPTS" ]; then
          SESSION_STATE=network
          run_fail temporary network "cannot reach Proton Pass ($tries attempts)" "$PC_ERR"
          return 1
        fi
        log "cannot reach Proton Pass (attempt $tries of $PROBE_ATTEMPTS); trying again in ${PROBE_DELAY}s"
        sleep "$PROBE_DELAY"
        if [ "$last" = login ]; then login; else probe; fi
        class=$PC_CLASS
        ;;
      no-session)
        if ! have_pat; then
          SESSION_STATE=no-session
          if [ -n "$PAT_FILE" ]; then
            run_fail permanent no-session "no Proton Pass session, and the PAT file $PAT_FILE is missing or empty — put a PAT there, or run: proton-secrets login" "$PC_ERR"
          else
            run_fail permanent no-session "no Proton Pass session and no PAT to log in with — run: proton-secrets login" "$PC_ERR"
          fi
          return 1
        fi
        if pat_on_cooldown; then
          PC_ERR="not asked again: Proton rejected this PAT less than $((PAT_RETRY_AFTER / 60)) minutes ago and $PAT_FILE has not changed since (proton-secrets repair tries it now)"
          class=pat-invalid
          continue
        fi
        log "no usable session; logging in from the PAT"
        last=login
        login
        class=$PC_CLASS
        ;;
      store-corrupt | session-rejected | already)
        # Three states only a reset gets out of: the store cannot be opened; the
        # server rejects the session but its files are still there; `login`
        # refuses ("already authenticated") over a session `info` cannot use.
        if [ "$class" = already ]; then class=store-corrupt; fi
        if ! have_pat; then
          SESSION_STATE=$class
          no_pat_help "$(explain "$class")"
          run_fail permanent "$class" "$(explain "$class") and there is no PAT" "$PC_ERR"
          return 1
        fi
        if [ "$RESET_DONE" -eq 1 ]; then
          SESSION_STATE=$class
          run_fail temporary "$class" "$(explain "$class"), even after one reset in this run" "$PC_ERR"
          return 1
        fi
        if pat_on_cooldown; then
          # The PAT is known not to work: this session could not be replaced.
          PC_ERR="$(explain "$class"), and Proton rejected the PAT in $PAT_FILE a moment ago"
          class=pat-invalid
          continue
        fi
        warn "$(explain "$class"):"
        detail "$PC_ERR" >&2
        if ! reset_session; then
          SESSION_STATE=$class
          run_fail temporary "$class" "could not reset the local session"
          return 1
        fi
        class=no-session
        ;;
      pat-invalid)
        SESSION_STATE=pat-invalid
        pat_invalid_help
        run_fail permanent pat-invalid "the personal access token in $(pat_source) is invalid, expired or deleted" "$PC_ERR"
        return 1
        ;;
      *)
        SESSION_STATE=unknown
        run_fail temporary unknown "pass-cli failed in a way this script does not recognise; nothing was changed" "$PC_ERR"
        return 1
        ;;
    esac
  done
}

# ---- generations -------------------------------------------------------------

WORK=""
cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

ensure_mount() {
  mkdir -p "$MOUNT_POINT" || return 1
  chmod 0751 "$MOUNT_POINT" || return 1
  if [ "$UNPRIVILEGED" -eq 1 ]; then return 0; fi
  # ramfs, not tmpfs: it is never written to swap.
  if ! mountpoint -q "$MOUNT_POINT"; then
    mount -t ramfs none "$MOUNT_POINT" -o nodev,nosuid,mode=0751 || return 1
  fi
}

# Plaintext only ever exists on the ramfs: values are fetched into a private
# directory there and moved into the new generation.
make_work() {
  # Under the lock, so any other .work.* is a leftover of a killed run.
  rm -rf "$MOUNT_POINT"/.work.* || return 1
  WORK=$(mktemp -d "$MOUNT_POINT/.work.XXXXXX") || return 1
  mkdir "$WORK/new" || return 1
}

# Number of the linked generation; 0 when nothing (usable) is linked.
linked_generation() {
  local target
  if [ -L "$SECRETS_DIR" ] && [ -d "$SECRETS_DIR" ]; then
    target=$(basename "$(readlink "$SECRETS_DIR")")
    case "$target" in
      "" | *[!0-9]*) echo 0 ;;
      *) echo "$target" ;;
    esac
  else
    echo 0
  fi
}

# Where a secret's current value lives.
current_file() { # <index>
  if [ "${S_SYMLINK[$1]}" -eq 1 ]; then
    echo "$SECRETS_DIR/${S_NAME[$1]}"
  else
    echo "${S_PATH[$1]}"
  fi
}

have_current() { # <index>
  local f
  f=$(current_file "$1")
  [ -f "$f" ] && [ -s "$f" ]
}

apply_owner() { # <index> <file> <quiet: 0|1>
  if [ "$UNPRIVILEGED" -eq 1 ]; then return 0; fi
  if chown "${S_OWNER[$1]}:${S_GROUP[$1]}" "$2" 2>/dev/null; then return 0; fi
  if [ "$3" -eq 0 ]; then
    warn "could not chown '${S_NAME[$1]}' to ${S_OWNER[$1]}:${S_GROUP[$1]} (does that user/group exist?); it stays root-only"
    PROBLEMS+=("chown ${S_NAME[$1]}")
  fi
  return 0
}

# Per-secret results, by index.
R_SOURCE=()  # fetched | unchanged | carried | cache | missing
R_CHANGED=() # 1 when the linked content differs from before this run
F_CLASS=()   # why the fetch failed ("" when it did not)
F_ERR=()     # pass-cli's words for that
F_PERM=()    # 1 when retrying cannot fix it
PROBLEMS=()
RESTARTED=()
RESTART_SKIPPED=()
CACHE_WRITTEN=()
CACHE_PRUNED=()
QUIET_CHOWN=0

init_results() {
  local i
  for i in "${!S_NAME[@]}"; do
    R_SOURCE[i]=missing
    R_CHANGED[i]=0
    F_CLASS[i]=""
    F_ERR[i]=""
    F_PERM[i]=0
  done
}

# Build generation N+1 completely, flip the symlink, then drop the old ones. A
# failure before the flip leaves what was linked untouched.
install_generation() {
  local cur new gen d
  cur=$(linked_generation)
  new=$((cur + 1))
  gen="$MOUNT_POINT/$new"
  log "creating generation $new in $MOUNT_POINT"
  if ! build_generation "$gen" || ! link_generation "$gen"; then
    rm -f "$SECRETS_DIR.new"
    rm -rf "$gen"
    return 1
  fi
  # Only now, with the link on the new generation, may the old ones go.
  for d in "$MOUNT_POINT"/*; do
    case "$(basename "$d")" in
      "$new" | *[!0-9]*) ;;
      *) rm -rf "$d" || warn "could not remove the old generation $d" ;;
    esac
  done
}

build_generation() { # <directory>
  local gen=$1 i name src
  # A directory of that number can only be the rest of a run that died here.
  rm -rf "$gen" || return 1
  mkdir "$gen" || return 1
  chmod 0751 "$gen" || return 1
  for i in "${!S_NAME[@]}"; do
    name=${S_NAME[$i]}
    src="$WORK/new/$name"
    if [ "${S_SYMLINK[$i]}" -ne 1 ] || [ ! -f "$src" ]; then continue; fi
    mv -f "$src" "$gen/$name" || return 1
    chmod "${S_MODE[$i]}" "$gen/$name" || return 1
    # Owned before it is linked; ensure_links_and_modes is the one that reports.
    apply_owner "$i" "$gen/$name" 1
  done
}

link_generation() { # <directory>
  if [ -e "$SECRETS_DIR" ] && [ ! -L "$SECRETS_DIR" ]; then
    # Something made a real directory where the link belongs; only an empty one
    # may be replaced.
    if ! rmdir "$SECRETS_DIR" 2>/dev/null; then
      err "$SECRETS_DIR exists and is not the generation symlink; remove it"
      return 1
    fi
  fi
  mkdir -p "$(dirname "$SECRETS_DIR")" || return 1
  # rename(2), so there is no moment without a link.
  rm -f "$SECRETS_DIR.new" || return 1
  ln -s "$1" "$SECRETS_DIR.new" || return 1
  mv -fT "$SECRETS_DIR.new" "$SECRETS_DIR" || return 1
}

# Secrets that are not symlinked into the generation are files at their own path.
install_plain() { # <index>
  local i=$1 src dst
  src="$WORK/new/${S_NAME[$i]}"
  dst=${S_PATH[$i]}
  if [ ! -f "$src" ]; then return 0; fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    chmod "${S_MODE[$i]}" "$dst" || return 1
    apply_owner "$i" "$dst" "$QUIET_CHOWN"
    return 0
  fi
  mkdir -p "$(dirname "$dst")" || return 1
  (umask 077 && cp -f "$src" "$dst.tmp") || return 1
  chmod "${S_MODE[$i]}" "$dst.tmp" || return 1
  apply_owner "$i" "$dst.tmp" "$QUIET_CHOWN"
  mv -f "$dst.tmp" "$dst" || return 1
}

# Mode, owner and the per-secret convenience links are re-applied on every run,
# so a changed `mode`/`owner`/`path` takes effect without a new generation.
ensure_links_and_modes() {
  local i name f
  for i in "${!S_NAME[@]}"; do
    name=${S_NAME[$i]}
    if [ "${S_SYMLINK[$i]}" -ne 1 ]; then continue; fi
    f="$SECRETS_DIR/$name"
    if [ -f "$f" ]; then
      chmod "${S_MODE[$i]}" "$f" || warn "could not chmod $f"
      apply_owner "$i" "$f" "$QUIET_CHOWN"
    fi
    if [ "${S_PATH[$i]}" != "$f" ]; then
      if [ "$(readlink "${S_PATH[$i]}" 2>/dev/null || true)" != "$f" ]; then
        if ! mkdir -p "$(dirname "${S_PATH[$i]}")" || ! ln -sfT "$f" "${S_PATH[$i]}"; then
          warn "could not link ${S_PATH[$i]} -> $f"
          PROBLEMS+=("link $name")
        fi
      fi
    fi
  done
}

# 0 when what is linked is exactly the declared set with the resolved content.
generation_matches() {
  local i name n=0 f
  if [ "$(linked_generation)" -eq 0 ]; then return 1; fi
  for i in "${!S_NAME[@]}"; do
    name=${S_NAME[$i]}
    if [ "${S_SYMLINK[$i]}" -ne 1 ] || [ ! -f "$WORK/new/$name" ]; then continue; fi
    n=$((n + 1))
    if [ ! -f "$SECRETS_DIR/$name" ] || ! cmp -s "$WORK/new/$name" "$SECRETS_DIR/$name"; then return 1; fi
  done
  # A secret dropped from the configuration must leave the ramfs too.
  for f in "$SECRETS_DIR"/* "$SECRETS_DIR"/.[!.]*; do
    if [ -e "$f" ]; then n=$((n - 1)); fi
  done
  [ "$n" -eq 0 ]
}

# ---- sealed cache ------------------------------------------------------------

cache_file() { printf '%s/%s.cred' "$CACHE_DIR" "$1"; }

# The name is sealed into the credential, so an entry copied over another one
# does not decrypt as it.
cache_decrypt() { # <name> <output file>
  local f out
  f=$(cache_file "$1")
  if [ ! -f "$f" ]; then return 1; fi
  if ! out=$( (umask 077 && "$CREDS" decrypt --name="proton-secrets.$1" "$f" - >"$2") 2>&1); then
    rm -f "$2"
    CACHE_ERR=$(printf '%s' "$out" | tail -n 2 | tr '\n' ' ')
    return 2
  fi
  [ -s "$2" ]
}
CACHE_ERR=""

cache_write() { # <name> <plaintext file>
  local f out
  f=$(cache_file "$1")
  rm -f "$f.tmp" || return 1
  if ! out=$( (umask 077 && "$CREDS" encrypt --with-key="$CACHE_KEY" --name="proton-secrets.$1" "$2" "$f.tmp") 2>&1); then
    rm -f "$f.tmp"
    CACHE_ERR=$(printf '%s' "$out" | tail -n 2 | tr '\n' ' ')
    return 1
  fi
  chmod 0600 "$f.tmp" || return 1
  mv -f "$f.tmp" "$f" || return 1
  sync "$f" "$CACHE_DIR" 2>/dev/null || true
}

# Seal what this run read from Proton; never what was merely carried along.
cache_update() {
  local i name cur f known
  if [ "$CACHE_ENABLE" -ne 1 ]; then return 0; fi
  if ! mkdir -p "$CACHE_DIR" || ! chmod 0700 "$CACHE_DIR"; then
    warn "cannot prepare the cache directory $CACHE_DIR; the sealed cache was not updated"
    PROBLEMS+=("cache directory")
    return 0
  fi
  rm -f "$CACHE_DIR"/*.tmp
  for i in "${!S_NAME[@]}"; do
    name=${S_NAME[$i]}
    case "${R_SOURCE[$i]}" in fetched | unchanged) ;; *) continue ;; esac
    cur=$(current_file "$i")
    if [ ! -f "$cur" ]; then continue; fi
    # Decrypting the entry is the only honest way to know it still holds this
    # value (a digest next to it would describe the plaintext on disk).
    if cache_decrypt "$name" "$WORK/cache-check" && cmp -s "$WORK/cache-check" "$cur"; then
      rm -f "$WORK/cache-check"
      continue
    fi
    rm -f "$WORK/cache-check"
    if cache_write "$name" "$cur"; then
      CACHE_WRITTEN+=("$name")
    else
      warn "could not seal '$name' into the cache: $CACHE_ERR"
      PROBLEMS+=("cache write $name")
    fi
  done
  for f in "$CACHE_DIR"/*.cred; do
    if [ ! -e "$f" ]; then continue; fi
    name=$(basename "$f" .cred)
    known=0
    for i in "${!S_NAME[@]}"; do
      if [ "${S_NAME[$i]}" = "$name" ]; then known=1; fi
    done
    if [ "$known" -eq 0 ]; then
      rm -f "$f"
      CACHE_PRUNED+=("$name")
    fi
  done
  if [ "${#CACHE_WRITTEN[@]}" -gt 0 ]; then log "sealed cache updated: ${CACHE_WRITTEN[*]}"; fi
  if [ "${#CACHE_PRUNED[@]}" -gt 0 ]; then log "sealed cache: removed entries no longer declared: ${CACHE_PRUNED[*]}"; fi
}

# ---- fetch -------------------------------------------------------------------

FETCH_ABORT=0
REAUTH_DONE=0
NO_PAT_HELP_SHOWN=0

# Read one secret into $WORK/new/<name>. On failure the class, pass-cli's words
# and whether a retry can help are recorded for the status file.
fetch_secret() { # <index>
  local i=$1 name=${S_NAME[$1]} out class tries=0
  local -a args
  eval "args=(${S_ARGS[$i]})"
  out="$WORK/new/$name"
  while :; do
    tries=$((tries + 1))
    pcli "$T_ITEM" "$out" item view "${args[@]}" --output human
    class=$PC_CLASS
    if [ "$class" = ok ]; then
      # A cleared field prints nothing but a newline; installing that as the
      # secret would only move the failure into the consumer.
      if LC_ALL=C grep -q '[^[:space:]]' "$out"; then return 0; fi
      class=blank
      PC_ERR="the field exists but is empty"
    fi
    rm -f "$out"
    case "$class" in
      pat-key | store-corrupt | session-rejected)
        # The one automatic way out of a session that cannot open its vaults
        # (or that Proton dropped while its files stayed): reset it and log in
        # again from the PAT, once.
        if [ "$RESET_DONE" -eq 0 ] && have_pat && ! pat_on_cooldown; then
          warn "'$name': the session cannot be used to read; resetting it and logging in again"
          detail "$PC_ERR" >&2
          if reset_session && ensure_session; then continue; fi
          F_CLASS[i]=${RUN_ERR_CLASS:-$class}
          F_ERR[i]=${RUN_ERR_DETAIL:-$(detail "$PC_ERR")}
          F_PERM[i]=$RUN_ERR_PERMANENT
          FETCH_ABORT=1
          return 1
        fi
        if ! have_pat; then
          # An interactive session is not ours to throw away.
          F_PERM[i]=1
          if [ "$NO_PAT_HELP_SHOWN" -eq 0 ]; then
            NO_PAT_HELP_SHOWN=1
            no_pat_help "the session cannot be used to read (pass-cli's stored PAT key is missing, the store is damaged, or Proton dropped the session)"
          fi
        elif [ "$class" = pat-key ]; then
          # A brand-new session cannot open them either; retrying will not help.
          F_PERM[i]=1
        else
          FETCH_ABORT=1
        fi
        ;;
      no-session)
        # pass-cli drops the local session itself when the server rejects it.
        if [ "$REAUTH_DONE" -eq 0 ]; then
          REAUTH_DONE=1
          if ensure_session; then continue; fi
        fi
        F_CLASS[i]=${RUN_ERR_CLASS:-$class}
        F_ERR[i]=${RUN_ERR_DETAIL:-$(detail "$PC_ERR")}
        F_PERM[i]=$RUN_ERR_PERMANENT
        FETCH_ABORT=1
        return 1
        ;;
      network)
        # Not worth a second try per secret: the unit comes back with back-off.
        FETCH_ABORT=1
        ;;
      vault | blank | missing | pat-invalid)
        F_PERM[i]=1
        ;;
      *)
        if [ "$tries" -le "$FETCH_RETRIES" ]; then
          log "'$name': pass-cli failed (attempt $tries); trying again in ${FETCH_RETRY_DELAY}s"
          sleep "$FETCH_RETRY_DELAY"
          continue
        fi
        ;;
    esac
    F_CLASS[i]=$class
    F_ERR[i]=$(detail "$PC_ERR")
    return 1
  done
}

fetch_pass() {
  local i name
  for i in "${!S_NAME[@]}"; do
    name=${S_NAME[$i]}
    if [ "$FETCH_ABORT" -eq 1 ]; then
      # Whatever stopped the fetch (network gone, the session lost for good)
      # holds for the rest of the list.
      F_CLASS[i]=${RUN_ERR_CLASS:-network}
      F_ERR[i]="not attempted"
      F_PERM[i]=$RUN_ERR_PERMANENT
      continue
    fi
    if fetch_secret "$i"; then
      R_SOURCE[i]=fetched
      FETCHED=$((FETCHED + 1))
    else
      err "could not fetch '$name' (${F_CLASS[$i]}):"
      printf '%s\n' "${F_ERR[$i]}" >&2
    fi
  done
}

FETCHED=0
fetch_all() {
  local i vault=0
  log "fetching ${#S_NAME[@]} secret(s) from Proton Pass..."
  fetch_pass
  for i in "${!S_NAME[@]}"; do
    if [ "${F_CLASS[$i]}" = vault ]; then vault=1; fi
  done
  # "Could not find vault" for one secret among good ones is a wrong name or a
  # vault the PAT was not granted, and no reason to touch the session. When not
  # a single secret could be read it may just as well be the session (a pass-cli
  # that words the missing PAT key differently), so that gets the one reset too.
  if [ "$vault" -eq 1 ] && [ "$FETCHED" -eq 0 ] && [ "$FETCH_ABORT" -eq 0 ] && [ "$RESET_DONE" -eq 0 ] && have_pat && ! pat_on_cooldown; then
    warn "no vault is readable with this session; resetting it and logging in again"
    if reset_session && ensure_session; then
      init_results
      fetch_pass
    else
      for i in "${!S_NAME[@]}"; do
        F_CLASS[i]=${RUN_ERR_CLASS:-vault}
        F_PERM[i]=$RUN_ERR_PERMANENT
      done
    fi
  fi
}

# Give every secret that was not fetched the best value still around: what is
# linked now, else (with the cache on) the sealed copy.
resolve_all() {
  local i name
  for i in "${!S_NAME[@]}"; do
    name=${S_NAME[$i]}
    if [ "${R_SOURCE[$i]}" = fetched ]; then
      if have_current "$i" && cmp -s "$WORK/new/$name" "$(current_file "$i")"; then
        R_SOURCE[i]=unchanged
      else
        R_CHANGED[i]=1
      fi
      continue
    fi
    if have_current "$i"; then
      if ! (umask 077 && cp -f "$(current_file "$i")" "$WORK/new/$name"); then
        warn "could not carry '$name' forward"
        rm -f "$WORK/new/$name"
        continue
      fi
      R_SOURCE[i]=carried
    elif [ "$CACHE_ENABLE" -eq 1 ] && cache_decrypt "$name" "$WORK/new/$name"; then
      R_SOURCE[i]=cache
      R_CHANGED[i]=1
    else
      rm -f "$WORK/new/$name"
      R_SOURCE[i]=missing
    fi
  done
}

# ---- consumers ---------------------------------------------------------------

# Units to restart: the global list when anything changed, plus the lists of the
# secrets that changed. One per line, no duplicates.
units_to_restart() {
  local i any=0
  local -a units=() list=()
  for i in "${!S_NAME[@]}"; do
    if [ "${R_CHANGED[$i]}" -ne 1 ]; then continue; fi
    any=1
    eval "list=(${S_UNITS[$i]})"
    units+=("${list[@]}")
  done
  if [ "$any" -eq 1 ]; then
    eval "list=($GLOBAL_UNITS)"
    units+=("${list[@]}")
  fi
  if [ "${#units[@]}" -gt 0 ]; then printf '%s\n' "${units[@]}" | awk '!seen[$0]++'; fi
}

# A consumer that reads its secret at start (LoadCredential=) must be restarted
# to see a new value. Only units that are up, starting or failed are touched: a
# unit somebody stopped stays stopped, and one whose start job is still queued
# behind this unit starts by itself and finds the secrets. --no-block is not
# optional: a consumer ordered After= the fetch unit would otherwise wait on the
# very job that is waiting on it.
# The activation path restarts the same way instead of writing
# /run/nixos/activation-restart-list: switch-to-configuration already warns that
# the list is deprecated and to be removed in NixOS 26.11, and it STARTS listed
# units that were not running. A unit the switch itself is about to restart is
# then restarted twice, which is harmless.
restart_consumers() {
  local u state
  local -a units=()
  mapfile -t units < <(units_to_restart)
  if [ "${#units[@]}" -eq 0 ]; then return 0; fi
  if [ ! -d "$ROOT/run/systemd/system" ]; then
    # nixos-install's chroot, or an activation before systemd is up.
    log "systemd is not running here; not restarting: ${units[*]}"
    return 0
  fi
  for u in "${units[@]}"; do
    if [ "$u" = "$UNIT_NAME" ]; then continue; fi
    state=$("$SYSTEMCTL" show -P ActiveState -- "$u" 2>/dev/null) || state=unknown
    case "$state" in
      active | reloading | activating | failed)
        # A unit that looped on a missing credential has used up its start
        # limit; without the reset the restart is refused.
        "$SYSTEMCTL" reset-failed -- "$u" 2>/dev/null || true
        if "$SYSTEMCTL" --no-block restart -- "$u"; then
          RESTARTED+=("$u")
        else
          warn "could not restart $u"
          PROBLEMS+=("restart $u")
        fi
        ;;
      *)
        RESTART_SKIPPED+=("$u")
        ;;
    esac
  done
  if [ "${#RESTARTED[@]}" -gt 0 ]; then log "restarted (changed secrets): ${RESTARTED[*]}"; fi
  if [ "${#RESTART_SKIPPED[@]}" -gt 0 ]; then log "not running, left alone: ${RESTART_SKIPPED[*]}"; fi
}

# ---- status ------------------------------------------------------------------

json_list() { # <items...> -> JSON array
  if [ "$#" -eq 0 ]; then
    echo '[]'
  else
    printf '%s\n' "$@" | jq -R . | jq -cs .
  fi
}

ATTEMPT=1
read_attempt() {
  local prev
  # Counts the runs since the last one that verified everything.
  prev=$(jq -r 'if .state == "ok" or .mode == "restore" then 0 else (.attempt // 0) end' "$STATUS_FILE" 2>/dev/null) || prev=0
  case "$prev" in "" | *[!0-9]*) prev=0 ;; esac
  ATTEMPT=$((prev + 1))
}

# JSON for humans, `proton-secrets doctor` and monitoring. No secret material:
# names, where each value came from and pass-cli's error text only.
write_status() { # <mode> <state> <exit code>
  local secrets i tmp="$STATUS_FILE.tmp"
  secrets=$(
    for i in "${!S_NAME[@]}"; do
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${S_NAME[$i]}" "${R_SOURCE[$i]}" "${R_CHANGED[$i]}" \
        "${S_OPTIONAL[$i]}" "${F_CLASS[$i]}" "$(printf '%s' "${F_ERR[$i]}" | tr '\t\n' '  ')" "${S_PATH[$i]}"
    done | jq -Rn '
      [inputs | split("\t") | {
        key: .[0],
        value: {
          source: .[1],
          changed: (.[2] == "1"),
          stale: (.[1] == "carried" or .[1] == "cache"),
          optional: (.[3] == "1"),
          error: (if .[4] == "" then null else {class: .[4], detail: .[5]} end),
          path: .[6]
        }
      }] | from_entries'
  ) || secrets='{}'
  mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null || true
  if jq -n \
    --arg mode "$1" --arg state "$2" --argjson exitCode "$3" \
    --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson attempt "$ATTEMPT" \
    --arg session "$SESSION_STATE" --argjson loggedIn "$LOGGED_IN" --argjson reset "$RESET_DONE" \
    --arg errClass "$RUN_ERR_CLASS" --arg errMsg "$RUN_ERR_MSG" --arg errDetail "$RUN_ERR_DETAIL" \
    --argjson errPermanent "$RUN_ERR_PERMANENT" --argjson generation "$(linked_generation)" \
    --argjson secrets "$secrets" \
    --argjson restarted "$(json_list "${RESTARTED[@]}")" \
    --argjson restartSkipped "$(json_list "${RESTART_SKIPPED[@]}")" \
    --argjson problems "$(json_list "${PROBLEMS[@]}")" \
    --argjson cacheEnabled "$CACHE_ENABLE" \
    --argjson cacheWritten "$(json_list "${CACHE_WRITTEN[@]}")" \
    --argjson cachePruned "$(json_list "${CACHE_PRUNED[@]}")" \
    '{
      version: 1,
      state: $state,
      mode: $mode,
      time: $time,
      attempt: $attempt,
      exitCode: $exitCode,
      retry: ($exitCode == 75),
      session: {state: $session, loggedIn: ($loggedIn == 1), reset: ($reset == 1)},
      error: (if $errClass == "" then null else
        {class: $errClass, permanent: ($errPermanent == 1), message: $errMsg, detail: $errDetail} end),
      generation: $generation,
      secrets: $secrets,
      changed: [$secrets | to_entries[] | select(.value.changed) | .key],
      restarted: $restarted,
      restartSkipped: $restartSkipped,
      problems: $problems,
      cache: {enabled: ($cacheEnabled == 1), written: $cacheWritten, pruned: $cachePruned}
    }' >"$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$STATUS_FILE"; then
    return 0
  fi
  rm -f "$tmp"
  warn "could not write the status file $STATUS_FILE"
}

# Without a fetch, the only thing known about a secret is whether a value is linked.
mark_current() {
  local i
  for i in "${!S_NAME[@]}"; do
    R_CHANGED[i]=0
    if have_current "$i"; then R_SOURCE[i]=carried; else R_SOURCE[i]=missing; fi
  done
}

# ok: all verified. degraded: not verified, but every required secret still has a
# (stale) value. failed: a required secret has no value at all.
state_for() { # <exit code>
  local i
  if [ "$1" -eq 0 ]; then
    echo ok
    return
  fi
  for i in "${!S_NAME[@]}"; do
    if [ "${S_OPTIONAL[$i]}" -ne 1 ] && ! have_current "$i"; then
      echo failed
      return
    fi
  done
  echo degraded
}

print_status() {
  if [ -z "$STATUS_FILE" ]; then return 0; fi
  if [ ! -r "$STATUS_FILE" ]; then
    echo "  last run:      no status file yet ($STATUS_FILE)"
    return 0
  fi
  echo "  last run:      $STATUS_FILE"
  jq -r '
    "    state: \(.state)   mode: \(.mode)   at: \(.time)   attempt: \(.attempt)   exit: \(.exitCode)",
    "    session: \(.session.state)"
      + (if .session.loggedIn then " (logged in from the PAT)" else "" end)
      + (if .session.reset then " (the local session was reset)" else "" end),
    (if .error then
      "    error: \(.error.class) (\(if .error.permanent then "needs a human" else "will be retried" end)): \(.error.message)"
     else empty end),
    (.secrets | to_entries[] | "    \(.key): \(.value.source)"
      + (if .value.changed then " (changed)" else "" end)
      + (if .value.optional then " (optional)" else "" end)
      + (if .value.error then "  <-- \(.value.error.class)"
          + (if .value.error.detail != "" then ": \(.value.error.detail)" else "" end) else "" end)),
    (if (.restarted | length) > 0 then "    restarted: \(.restarted | join(" "))" else empty end),
    (if (.problems | length) > 0 then "    problems: \(.problems | join("; "))" else empty end)
  ' "$STATUS_FILE" 2>/dev/null || echo "    (not readable as JSON)"
}

# ---- commands ----------------------------------------------------------------

run_fetch() { # activate | unit
  local mode=$1 i code=0 need=0 temporary=0 permanent=0 names=""
  if [ "$mode" = activate ]; then
    # Before users and groups exist (a first install) the chown cannot work
    # yet; the `chown` step after them is the one that reports.
    QUIET_CHOWN=1
  fi
  init_results
  read_attempt
  if ! acquire_lock "$T_LOCK"; then
    run_fail temporary lock "another run still holds the lock; nothing was fetched"
    mark_current
    write_status "$mode" "$(state_for "$EX_TEMPORARY")" "$EX_TEMPORARY"
    return "$EX_TEMPORARY"
  fi
  if ! ensure_mount || ! make_work; then
    run_fail temporary mount "cannot prepare the ramfs at $MOUNT_POINT"
    mark_current
    write_status "$mode" "$(state_for "$EX_TEMPORARY")" "$EX_TEMPORARY"
    return "$EX_TEMPORARY"
  fi
  ensure_session_dir
  if ensure_session; then
    fetch_all
  else
    for i in "${!S_NAME[@]}"; do
      F_CLASS[i]=$RUN_ERR_CLASS
      F_PERM[i]=$RUN_ERR_PERMANENT
    done
  fi
  resolve_all

  for i in "${!S_NAME[@]}"; do
    case "${R_SOURCE[$i]}" in fetched | unchanged) continue ;; esac
    if [ "${S_OPTIONAL[$i]}" -eq 1 ]; then
      warn "optional secret '${S_NAME[$i]}' was not fetched (${F_CLASS[$i]:-unknown}); it is now: ${R_SOURCE[$i]}"
      continue
    fi
    names="$names ${S_NAME[$i]}"
    if [ "${F_PERM[$i]}" -eq 1 ]; then permanent=1; else temporary=1; fi
  done
  # One secret that may come back on its own is reason enough to try again.
  if [ "$temporary" -eq 1 ]; then
    code=$EX_TEMPORARY
  elif [ "$permanent" -eq 1 ]; then
    code=$EX_PERMANENT
  fi
  if [ "$code" -ne 0 ] && [ -z "$RUN_ERR_CLASS" ]; then
    RUN_ERR_CLASS=secrets
    RUN_ERR_MSG="not fetched:$names"
    RUN_ERR_PERMANENT=$((1 - temporary))
  fi

  if [ "$code" -ne 0 ] && [ "$mode" = activate ] && [ "$FAIL_CLOSED" -eq 1 ]; then
    # failClosed: all or nothing. What is linked stays exactly as it was.
    mark_current
    err "not every secret could be read from Proton Pass:$names"
    err "  failClosed is set, so nothing was changed and this activation fails."
    write_status "$mode" "$(state_for "$code")" "$code"
    return "$code"
  fi

  if ! generation_matches; then
    for i in "${!S_NAME[@]}"; do
      if [ "${S_SYMLINK[$i]}" -eq 1 ] && [ -f "$WORK/new/${S_NAME[$i]}" ]; then need=1; fi
    done
    # Also with nothing to link, when what is linked is no longer declared.
    if [ "$need" -eq 1 ] || [ "$(linked_generation)" -ne 0 ]; then
      if ! install_generation; then
        run_fail temporary install "could not install the new generation; what was linked before still is"
        mark_current
        write_status "$mode" "$(state_for "$EX_TEMPORARY")" "$EX_TEMPORARY"
        return "$EX_TEMPORARY"
      fi
    fi
  fi
  for i in "${!S_NAME[@]}"; do
    if [ "${S_SYMLINK[$i]}" -ne 1 ] && ! install_plain "$i"; then
      warn "could not install '${S_NAME[$i]}' at ${S_PATH[$i]}"
      PROBLEMS+=("install ${S_NAME[$i]}")
      R_CHANGED[i]=0
    fi
  done
  ensure_links_and_modes
  cache_update
  restart_consumers
  # Reading may have refreshed the tokens in session.json (same unsynced write).
  sync_session

  if [ "$code" -eq 0 ]; then
    log "every required secret verified against Proton Pass (generation $(linked_generation))"
  elif [ "$temporary" -eq 1 ]; then
    err "not fetched:$names — temporary; run again later (the fetch unit does)"
  else
    err "not fetched:$names — this will not fix itself; see above, then run: proton-secrets refresh"
  fi
  write_status "$mode" "$(state_for "$code")" "$code"
  if [ "$code" -ne 0 ] && [ "$mode" = activate ]; then
    warn "refresh failed (failClosed=false); keeping previous secrets where there are any."
    return 0
  fi
  return "$code"
}

# Before any consumer starts and with no network: put the sealed copies in place
# so LoadCredential= finds its files on the first start. Never fatal.
run_restore() {
  local i name restored=0
  init_results
  if [ "$CACHE_ENABLE" -ne 1 ]; then
    log "the sealed cache is off; nothing to restore"
    return 0
  fi
  if ! acquire_lock 30; then
    warn "restore skipped: the lock is busy"
    return 0
  fi
  if [ "$(linked_generation)" -ne 0 ]; then
    log "$SECRETS_DIR is already linked; not restoring over it"
    return 0
  fi
  if ! ensure_mount || ! make_work; then
    warn "restore skipped: cannot prepare the ramfs at $MOUNT_POINT"
    return 0
  fi
  for i in "${!S_NAME[@]}"; do
    name=${S_NAME[$i]}
    CACHE_ERR=""
    if cache_decrypt "$name" "$WORK/new/$name"; then
      R_SOURCE[i]=cache
      R_CHANGED[i]=1
      restored=$((restored + 1))
    else
      rm -f "$WORK/new/$name"
      if [ ! -f "$(cache_file "$name")" ]; then
        log "restore: no cache entry for '$name'"
      else
        warn "restore: the cache entry for '$name' did not decrypt, skipped: $CACHE_ERR"
      fi
    fi
  done
  if [ "$restored" -gt 0 ] && ! install_generation; then
    warn "restore: could not install the generation"
    restored=0
  fi
  if [ "$restored" -eq 0 ]; then
    log "restore: nothing restored from the sealed cache"
    mark_current
    write_status restore "$(state_for 1)" 0
    return 0
  fi
  for i in "${!S_NAME[@]}"; do
    if [ "${S_SYMLINK[$i]}" -ne 1 ] && ! install_plain "$i"; then
      warn "restore: could not install '${S_NAME[$i]}' at ${S_PATH[$i]}"
    fi
  done
  ensure_links_and_modes
  log "restored $restored of ${#S_NAME[@]} secret(s) from the sealed cache; they are verified once Proton is reachable"
  write_status restore restored 0
}

run_chown() {
  local i f
  for i in "${!S_NAME[@]}"; do
    f=$(current_file "$i")
    if [ -f "$f" ]; then apply_owner "$i" "$f" 0; fi
  done
}

cmd_probe() {
  acquire_lock "$T_LOCK" || exit "$EX_TEMPORARY"
  ensure_session_dir
  probe
  case "$PC_CLASS" in
    ok | no-session | store-corrupt | session-rejected | network) echo "$PC_CLASS" ;;
    *) echo unknown ;;
  esac
  if [ "$PC_CLASS" = ok ]; then exit 0; fi
  if [ "$PC_CLASS" != no-session ]; then detail "$PC_ERR" >&2; fi
  exit 1
}

cmd_login() {
  IGNORE_PAT_COOLDOWN=1
  acquire_lock "$T_LOCK" || exit "$EX_TEMPORARY"
  ensure_session_dir
  if ! have_pat; then
    probe
    if [ "$PC_CLASS" = ok ]; then
      log "already logged in (session in $SESSION_DIR)"
      exit 0
    fi
    exit "$EX_NO_PAT"
  fi
  if ensure_session; then
    if [ "$LOGGED_IN" -eq 1 ]; then
      log "logged in from the PAT (session in $SESSION_DIR)"
    else
      log "already logged in (session in $SESSION_DIR)"
    fi
    exit 0
  fi
  if [ "$RUN_ERR_PERMANENT" -eq 1 ]; then exit "$EX_PERMANENT"; fi
  exit "$EX_TEMPORARY"
}

cmd_repair() {
  local force=0
  if [ "${1:-}" = --force ]; then force=1; fi
  IGNORE_PAT_COOLDOWN=1
  acquire_lock "$T_LOCK" || exit "$EX_TEMPORARY"
  ensure_session_dir
  if ! have_pat && [ "$force" -eq 0 ]; then
    err "no PAT is available, so the session could not be re-created afterwards."
    err "  To drop an interactive session anyway:  proton-secrets repair --force"
    err "  and then log in again:                  proton-secrets login"
    exit "$EX_NO_PAT"
  fi
  reset_session || exit "$EX_TEMPORARY"
  if ! have_pat; then
    log "local session removed. Log in again with: proton-secrets login"
    exit 0
  fi
  if ensure_session; then
    log "session re-created from the PAT"
    exit 0
  fi
  if [ "$RUN_ERR_PERMANENT" -eq 1 ]; then exit "$EX_PERMANENT"; fi
  exit "$EX_TEMPORARY"
}

next_step() { # <class>
  case "$1" in
    no-session) echo "; run: proton-secrets login" ;;
    store-corrupt | session-rejected)
      if have_pat; then
        echo "; run: proton-secrets repair"
      else
        echo "; run: proton-secrets repair --force, then: proton-secrets login"
      fi
      ;;
    network) echo "; the fetch unit keeps retrying" ;;
  esac
}

cmd_doctor() {
  local f size class n=0
  echo "proton-secrets doctor"
  echo "  pass-cli:      $(command -v pass-cli || echo 'not on PATH')"
  echo "  manifest:      ${MANIFEST:-none (services.proton-secrets is not set up on this box)}"
  echo "  session dir:   $SESSION_DIR (key provider: $KEY_PROVIDER)"
  for f in local.key pass-cli.db session.json pat_key; do
    if [ -e "$SESSION_DIR/.session/$f" ]; then
      size=$(stat -c %s "$SESSION_DIR/.session/$f" 2>/dev/null || echo '?')
      case "$f:$size" in
        pat_key:0 | local.key:0 | session.json:0)
          echo "    $f: 0 bytes   <-- EMPTY (a write cut short); run: proton-secrets repair"
          ;;
        *) echo "    $f: $size bytes" ;;
      esac
    else
      echo "    $f: absent"
    fi
  done
  if [ -n "$PAT_FILE" ]; then
    if [ -r "$PAT_FILE" ] && [ -s "$PAT_FILE" ]; then
      echo "  PAT file:      $PAT_FILE (readable)"
    elif [ -e "$PAT_FILE" ]; then
      echo "  PAT file:      $PAT_FILE (EMPTY or not readable)"
    else
      echo "  PAT file:      $PAT_FILE (MISSING)"
    fi
  elif [ -n "$PAT" ]; then
    echo "  PAT:           from the environment"
  else
    echo "  PAT file:      not configured (interactive session)"
  fi
  if acquire_lock 20; then
    echo "  version:       $(timeout 10 pass-cli --version 2>/dev/null | head -n 1 || true)"
    probe
    class=$PC_CLASS
    echo "  session probe: $class — $(explain "$class")$(next_step "$class")"
    if [ "$class" != ok ] && [ "$class" != no-session ]; then detail "$PC_ERR" | sed 's/^/      /'; fi
  else
    echo "  session probe: skipped, another run holds the lock"
  fi
  print_status
  if [ -n "$MANIFEST" ]; then
    if [ "$CACHE_ENABLE" -eq 1 ]; then
      echo "  sealed cache:  $CACHE_DIR (key: $CACHE_KEY)"
      for f in "$CACHE_DIR"/*.cred; do
        if [ -e "$f" ]; then
          n=$((n + 1))
          echo "    $(basename "$f" .cred)"
        fi
      done
      if [ "$n" -eq 0 ]; then echo "    (no entries, or not readable as this user)"; fi
    else
      echo "  sealed cache:  off"
    fi
    if [ -n "$UNIT_NAME" ]; then
      echo "  fetch unit:    $UNIT_NAME: $("$SYSTEMCTL" is-active "$UNIT_NAME" 2>/dev/null || true)"
    fi
  fi
  echo "Next: 'proton-secrets refresh' fetches now; 'proton-secrets repair' re-creates the session from the PAT."
}

# Run the fetch unit now and say how it went. The unit does the work (not this
# process) so its result, back-off and consumer restarts are the same as at boot.
cmd_refresh() {
  local rc=0
  need_manifest
  if [ -z "$UNIT_NAME" ]; then
    err "this host has no fetch unit (services.proton-secrets.fetchService.enable is off)"
    exit "$EX_USAGE"
  fi
  "$SYSTEMCTL" reset-failed -- "$UNIT_NAME" 2>/dev/null || true
  "$SYSTEMCTL" restart -- "$UNIT_NAME" || rc=$?
  print_status
  if [ "$rc" -ne 0 ]; then
    err "$UNIT_NAME did not succeed; details: journalctl -u $UNIT_NAME -b   and: proton-secrets doctor"
  fi
  exit "$rc"
}

cmd_exec() {
  acquire_lock "$T_LOCK" || exit "$EX_TEMPORARY"
  ensure_session_dir
  # fd 9 stays open in pass-cli, so the lock is held until it exits.
  exec pass-cli "$@"
}

case "$CMD" in
  activate)
    need_manifest
    # systemd stage-1 runs `activate` inside the initrd, which has no network.
    if [ "${IN_NIXOS_SYSTEMD_STAGE1:-}" = true ]; then
      log "initrd activation has no network — skipping (the fetch runs after switch-root)"
      exit 0
    fi
    rc=0
    run_fetch activate || rc=$?
    exit "$rc"
    ;;
  unit)
    need_manifest
    rc=0
    run_fetch unit || rc=$?
    exit "$rc"
    ;;
  restore)
    need_manifest
    run_restore || true
    exit 0
    ;;
  mount)
    need_manifest
    ensure_mount
    ;;
  chown)
    need_manifest
    run_chown
    ;;
  probe) cmd_probe ;;
  login) cmd_login ;;
  repair) cmd_repair "$@" ;;
  doctor) cmd_doctor ;;
  refresh) cmd_refresh ;;
  exec) cmd_exec "$@" ;;
  help | --help | -h)
    usage
    ;;
  *)
    err "unknown command '$CMD'"
    usage
    exit "$EX_USAGE"
    ;;
esac
