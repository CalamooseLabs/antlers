# A stand-in for Proton Pass `pass-cli`, for the proton-secrets flake check.
# (writeShellApplication supplies the shebang and `set -euo pipefail`.)
#
# It keeps the same files as the real one under $PROTON_PASS_SESSION_DIR/.session
# (local.key, pass-cli.db, session.json, pat_key), fails with the stderr text and
# exit code pass-cli 2.1.3 / 2.4.1 print in each state, and records every call.
# Two texts were never seen from a real vault and are taken from the binaries'
# strings: a field that does not exist, and what an empty field prints.
# Behaviour is driven by files in $STUB_CTL:
#   net-down            the API is unreachable
#   net-down-calls      a number: that many more API calls fail as unreachable
#   net-up-calls        a number: that many more API calls get through, then none
#   pat-invalid         Proton rejects the PAT
#   session-rejected    the server no longer knows the session, pass-cli 2.1.3
#                       style: the next authenticated command drops .session,
#                       except for a session.json nothing can decrypt. `info`
#                       says why; `item view` only says "Error listing vaults"
#   session-rejected-keep  the same, pass-cli 2.4.1 style: every authenticated
#                       command fails, the files stay and `login` refuses
#   reject-after        a number: the session is rejected (2.4.1 style) from that
#                       many authenticated commands on
#   vault-hidden        lines of keys whose vault is not visible to the login
#                       (an empty file: no vault at all)
#   pat-key-broken      no login can open the vault keys (the ERROR line of an
#                       empty pat_key, whatever is in the file)
#   share-refused       the share's keys cannot be fetched (HTTP 403): the last
#                       line is the one of a vault that is not there
#   missing             lines of keys whose field does not exist
#   blank               lines of keys whose field is empty
#   odd-errors          a number: that many `item view` calls fail with an
#                       error no classifier knows (it quotes the seeded PAT, which
#                       nothing may repeat)
#   odd-info            a number: that many `info` calls fail with an error no
#                       classifier knows (HTTP 403)
#   values/<key>        the value of a key (default: VALUE[<key>]); '/' -> '_'
#   slow                seconds every `item view` takes
#   slow-login          seconds every `login` takes
#   expected-pat        the PAT the test seeded (to tell "in the env" from "not")
# and it writes there:
#   calls.log           one line per call: the argv, then " => " and the outcome
#   overlap             appended to when two calls ran at the same time
#   out-modes           the mode of the file each fetched value was written to
#   pat-leak            appended to when a command other than `login` was handed
#                       the PAT in its environment
# A key is VAULT/ITEM/FIELD, or the pass:// reference (plus /FIELD).

CTL=${STUB_CTL:?STUB_CTL is not set}
SESS="${PROTON_PASS_SESSION_DIR:?PROTON_PASS_SESSION_DIR is not set}/.session"
ARGV="$*"

# Only `login` reads the PAT; no other command should ever be given it.
if [ -n "${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}" ] && [ "${1:-}" != login ]; then echo "$ARGV" >>"$CTL/pat-leak"; fi

# pass-cli has no lock of its own; the fetch engine must never run two at once.
if ! mkdir "$CTL/busy" 2>/dev/null; then echo "overlap: $ARGV" >>"$CTL/overlap"; fi
trap 'rmdir "$CTL/busy" 2>/dev/null || true' EXIT

done_() { # <exit code> <outcome>
  printf '%s => %s\n' "$ARGV" "$2" >>"$CTL/calls.log"
  exit "$1"
}

net_ok() {
  local n
  if [ -e "$CTL/net-down" ]; then return 1; fi
  if [ -e "$CTL/net-down-calls" ]; then
    n=$(cat "$CTL/net-down-calls")
    if [ "$n" -gt 0 ]; then
      echo $((n - 1)) >"$CTL/net-down-calls"
      return 1
    fi
  fi
  if [ -e "$CTL/net-up-calls" ]; then
    n=$(cat "$CTL/net-up-calls")
    if [ "$n" -le 0 ]; then return 1; fi
    echo $((n - 1)) >"$CTL/net-up-calls"
  fi
  return 0
}

backtrace() {
  printf '\nStack backtrace:\n   0: pass_cli::main\n   1: main\n   2: _start\n' >&2
}

net_error() { # <first line>
  printf 'Error: %s\n\nCaused by:\n    0: Error sending request\n    1: failed to send request: no servers available\n    2: no servers available\n' "$1" >&2
  backtrace
}

session_kind() {
  if [ -e "$SESS/local.key" ] && [ ! -s "$SESS/local.key" ]; then
    echo corrupt-key
  elif [ ! -e "$SESS/session.json" ]; then
    echo none
  elif [ "$(cat "$SESS/session.json")" = logged-in ]; then
    echo logged-in
  elif [ "$(cat "$SESS/session.json")" = anonymous ]; then
    echo anonymous
  else
    echo corrupt-session
  fi
}

# What every command does first: open the local store.
open_store() {
  case "$(session_kind)" in
    corrupt-key)
      printf 'ERROR CORE sqlcipher_page_cipher: hmac check failed for pgno=1\nError: Error creating client features\n' >&2
      backtrace
      done_ 1 "store corrupt (local.key)"
      ;;
    corrupt-session)
      printf 'Error: Error getting client\n\nCaused by:\n    0: Error decrypting local session(Error decrypting session: aead::Error)\n' >&2
      backtrace
      done_ 1 "store corrupt (session.json)"
      ;;
  esac
}

# An authenticated command: needs a logged-in session.
need_session() {
  case "$(session_kind)" in
    none)
      echo 'Error: This operation requires an authenticated client' >&2
      backtrace
      done_ 1 "no session"
      ;;
    anonymous)
      rm -rf "$SESS"
      printf 'ERROR pass/src/client.rs: Session is some but is not logged in\nError: This operation requires an authenticated client\n' >&2
      done_ 1 "anonymous session wiped"
      ;;
  esac
}

# ...that the server still accepts (called once the network is known to be up).
# `info` reports the rejection; a read only gets as far as "Error listing vaults".
server_accepts() { # [<vault name>, for a read]
  local n
  if [ -e "$CTL/reject-after" ]; then
    n=$(cat "$CTL/reject-after")
    if [ "$n" -le 0 ]; then touch "$CTL/session-rejected-keep"; fi
    echo $((n - 1)) >"$CTL/reject-after"
  fi
  if [ -e "$CTL/session-rejected" ]; then
    rm -rf "$SESS"
    mkdir -p "$SESS"
    echo left-behind >"$SESS/session.json"
    if [ "$#" -gt 0 ]; then
      printf 'Error: Error finding vault [%s]: Error listing vaults\n' "$1" >&2
      backtrace
    else
      printf 'Your session has been invalidated and you have been logged out automatically.\nPlease log in again with: pass login\n' >&2
    fi
    done_ 1 "session invalidated, mostly wiped"
  fi
  if [ -e "$CTL/session-rejected-keep" ]; then
    if [ "$#" -gt 0 ]; then
      printf 'Error: Error finding vault [%s]: Error listing vaults\n' "$1" >&2
    else
      printf 'Error: Error getting personal access token name\n\nCaused by:\n    0: Error sending request\n    1: failed to authenticate: non-existent session\n    2: non-existent session\n' >&2
    fi
    backtrace
    done_ 1 "session rejected, files kept"
  fi
}

case "${1:-}" in
  --version)
    echo "pass-cli 0.0.0-stub"
    done_ 0 ok
    ;;
  test)
    # Gone from pass-cli 2.2.4+; nothing may depend on it.
    echo "error: unrecognized subcommand 'test'" >&2
    done_ 2 "unrecognized subcommand"
    ;;
  info)
    open_store
    need_session
    if ! net_ok; then
      net_error "Error getting user info"
      done_ 1 "network"
    fi
    server_accepts
    if [ -e "$CTL/odd-info" ] && [ "$(cat "$CTL/odd-info")" -gt 0 ]; then
      echo $(($(cat "$CTL/odd-info") - 1)) >"$CTL/odd-info"
      printf 'Error: Error getting personal access token name\n\nCaused by:\n    Invalid status code: 403 Forbidden\n' >&2
      backtrace
      done_ 1 "odd error"
    fi
    echo '{"name":"stub"}'
    done_ 0 ok
    ;;
  login)
    open_store
    if [ "$(session_kind)" = logged-in ]; then
      printf 'Client is already authenticated. Log out if you want to log in again\nError: Already authenticated\n' >&2
      backtrace
      done_ 1 "already authenticated"
    fi
    pat=${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}
    how="env"
    if [ "${2:-}" = --pat ]; then
      pat=${3:-}
      how="argv"
    fi
    if [ -z "$pat" ]; then
      printf 'Error: Error in web login flow\n' >&2
      done_ 1 "web login (no PAT given)"
    fi
    if [ -e "$CTL/slow-login" ]; then sleep "$(cat "$CTL/slow-login")"; fi
    case "$pat" in
      pst_*::*) ;;
      *)
        # Refused before anything is sent.
        printf 'Error: Error in personal access token login flow\n\nCaused by:\n    0: Failed to parse personal access token token\n    1: Personal access token token must have exactly 64 characters after '"'pst_'"' prefix\n' >&2
        backtrace
        done_ 1 "PAT malformed (PAT via $how)"
        ;;
    esac
    mkdir -p "$SESS"
    chmod 0700 "$SESS"
    if [ ! -e "$SESS/local.key" ]; then head -c 32 /dev/zero | tr '\0' k >"$SESS/local.key"; fi
    : >"$SESS/pass-cli.db"
    if ! net_ok; then
      printf 'Error: Error in personal access token login flow\n\nCaused by:\n    0: Error creating personal access token session\n    1: Error requesting personal access token session\n    2: failed to send request: no servers available\n    3: no servers available\n' >&2
      backtrace
      done_ 1 "network (PAT via $how)"
    fi
    if [ -e "$CTL/pat-invalid" ] || { [ -e "$CTL/expected-pat" ] && [ "$pat" != "$(cat "$CTL/expected-pat")" ]; }; then
      # A rejected PAT leaves the anonymous session of the first login step.
      echo anonymous >"$SESS/session.json"
      printf 'Error: Error in personal access token login flow\n\nCaused by:\n    0: Error creating personal access token session\n    1: This personal access token is invalid, expired or has been deleted.\n' >&2
      backtrace
      done_ 1 "PAT rejected (PAT via $how)"
    fi
    echo logged-in >"$SESS/session.json"
    head -c 60 /dev/zero | tr '\0' p >"$SESS/pat_key"
    rm -f "$CTL/session-rejected" "$CTL/session-rejected-keep" "$CTL/reject-after"
    echo 'Successfully logged in as personal access token: stub'
    done_ 0 "logged in (PAT via $how)"
    ;;
  logout)
    if [ "${2:-}" = --force ]; then
      rm -rf "$SESS"
      printf 'Executing force logout\nSuccessfully performed force logout\n'
      done_ 0 "session removed"
    fi
    open_store
    need_session
    rm -rf "$SESS"
    done_ 0 "logged out"
    ;;
  item)
    ref=""
    vault=""
    title=""
    field=""
    shift
    if [ "${1:-}" != view ]; then done_ 64 "unsupported item command"; fi
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --vault-name)
          vault=$2
          shift
          ;;
        --item-title)
          title=$2
          shift
          ;;
        --field)
          field=$2
          shift
          ;;
        --output) shift ;;
        *) ref=$1 ;;
      esac
      shift
    done
    if [ -n "$ref" ]; then
      key=$ref${field:+/$field}
    else
      key="$vault/$title/$field"
    fi
    open_store
    need_session
    if [ -e "$CTL/slow" ]; then sleep "$(cat "$CTL/slow")"; fi
    if ! net_ok; then
      printf 'Error: Error finding vault [%s]: Error listing vaults\n' "$vault" >&2
      backtrace
      done_ 1 "network"
    fi
    server_accepts "$vault"
    if [ -e "$CTL/vault-hidden" ] && { [ ! -s "$CTL/vault-hidden" ] || grep -qxF "$key" "$CTL/vault-hidden"; }; then
      printf 'Error: Error finding vault [%s]: Could not find vault %s\n' "$vault" "$vault" >&2
      backtrace
      done_ 1 "vault not visible"
    fi
    if [ ! -s "$SESS/pat_key" ] || [ -e "$CTL/pat-key-broken" ]; then
      # A login cut short by a power loss: session.json is there, pat_key is not.
      printf 'ERROR pass/src/vault/list.rs:76: Error opening share share0001: Error getting opened share key: Error opening share key: Error opening ShareKey for Share: Error getting local personal access token key: Error decrypting personal access token key with local key: Error\nError: Error finding vault [%s]: Could not find vault %s\n' "$vault" "$vault" >&2
      backtrace
      done_ 1 "vault not readable (pat_key)"
    fi
    if [ -e "$CTL/share-refused" ]; then
      printf 'ERROR pass/src/vault/list.rs:76: Error opening share share0001: Error getting opened share key: Error requesting share keys: Invalid status code: 403 Forbidden\nError: Error finding vault [%s]: Could not find vault %s\n' "$vault" "$vault" >&2
      backtrace
      done_ 1 "share keys refused"
    fi
    if [ -e "$CTL/odd-errors" ] && [ "$(cat "$CTL/odd-errors")" -gt 0 ]; then
      echo $(($(cat "$CTL/odd-errors") - 1)) >"$CTL/odd-errors"
      printf 'Error: the stub does something no classifier knows (%s)\n' "$(cat "$CTL/expected-pat" 2>/dev/null || true)" >&2
      done_ 1 "odd error"
    fi
    if grep -qxF "$key" "$CTL/missing" 2>/dev/null; then
      printf 'Error: Error getting field\n\nCaused by:\n    0: Field does not exist: %s\n' "$field" >&2
      backtrace
      done_ 1 "field missing"
    fi
    if grep -qxF "$key" "$CTL/blank" 2>/dev/null; then
      echo
      done_ 0 "blank"
    fi
    stat -L -c %a "/proc/$$/fd/1" >>"$CTL/out-modes"
    if [ -e "$CTL/values/${key//\//_}" ]; then
      cat "$CTL/values/${key//\//_}"
    else
      printf 'VALUE[%s]\n' "$key"
    fi
    done_ 0 "ok"
    ;;
  *)
    done_ 64 "unsupported"
    ;;
esac
