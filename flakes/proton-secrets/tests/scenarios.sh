# Scenarios for proton-secrets-fetch, run by the `proton-secrets-fetch` flake check.
#
# The BUILT script (services.proton-secrets.fetchPackage of a small NixOS
# configuration whose cliPackage is ./pass-cli-stub.sh) is run unprivileged against
# a temp directory through the manifest's test seams, and judged by what it leaves
# behind: the generation directories, the status JSON, its exit code, and the
# stub's call log. Needs in the environment:
#   FETCH           .../bin/proton-secrets-fetch
#   WRAPPER         .../bin/proton-secrets
#   MANIFEST        the manifest the module generated
#   SYSTEMCTL_STUB  CREDS_STUB   the stand-ins for systemctl / systemd-creds
#
# The declared secrets (see the check in flake.nix), and the stub's key for each:
#   alpha   Vault/alpha/secret                    restartUnits alpha-consumer
#   beta    Vault/Stream Keys/YouTube Vertical    restartUnits beta-consumer, shared   mode 0440
#   gamma   pass://SHARE/ITEM/password            restartUnits shared
#   delta   Vault/delta/secret                    optional
#   linked  Vault/linked/secret                   path /etc/app/linked-secret (a link)
#   plain   Vault/plain/secret                    symlink = false, path /var/lib/app/plain-secret
# plus the global restartUnits any-change.service.
set -u

T=$(mktemp -d)
PAT='pst_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef::S3cretPatKeyHalf_-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'
ALL_OUT="$T/all-output.log"
: >"$ALL_OUT"
CHECKS=0
FAILED=0
NAME=""
R=""
M=""
RC=0
OUT=""

# ---- helpers -----------------------------------------------------------------

scenario() { # <name>: a fresh root, stub state and manifest
  NAME=$1
  echo "== $NAME"
  R="$T/$NAME/root"
  export STUB_CTL="$T/$NAME/ctl"
  M="$T/$NAME/manifest.json"
  OUT="$T/$NAME/out"
  mkdir -p "$R/var/lib/proton-pass-cli" "$R/run/systemd/system" "$STUB_CTL/unit-state" "$STUB_CTL/values"
  : >"$STUB_CTL/calls.log"
  : >"$STUB_CTL/systemctl.log"
  printf '%s\n' "$PAT" >"$R/var/lib/proton-pass-cli/pat"
  printf '%s' "$PAT" >"$STUB_CTL/expected-pat"
  manifest .
}

# (Re)write this scenario's manifest: the module's, relocated under $R, with the
# waits taken out and the cache off unless a scenario turns it on.
manifest() { # <jq filter>
  jq --arg root "$R" --arg systemctl "$SYSTEMCTL_STUB" --arg creds "$CREDS_STUB" "
    .seams = {root: \$root, unprivileged: true, systemctl: \$systemctl, systemdCreds: \$creds}
    | .probeDelay = 0 | .fetchRetryDelay = 0 | .cache.enable = false
    | $1" "$MANIFEST" >"$M"
}

session() { # valid | none | empty-pat-key | corrupt-key | corrupt-session
  local s="$R/var/lib/proton-pass-cli/.session"
  rm -rf "$s"
  if [ "$1" = none ]; then return 0; fi
  mkdir -p "$s"
  head -c 32 /dev/zero | tr '\0' k >"$s/local.key"
  : >"$s/pass-cli.db"
  echo logged-in >"$s/session.json"
  head -c 60 /dev/zero | tr '\0' p >"$s/pat_key"
  case "$1" in
    empty-pat-key) : >"$s/pat_key" ;;
    corrupt-key) : >"$s/local.key" ;;
    corrupt-session) echo garbage >"$s/session.json" ;;
  esac
}

run() { # <proton-secrets-fetch args>
  RC=0
  "$FETCH" --manifest "$M" "$@" >"$OUT" 2>&1 || RC=$?
  cat "$OUT" >>"$ALL_OUT"
}

wrapper() { # <proton-secrets args>; the CLI finds the manifest through the environment
  RC=0
  PROTON_SECRETS_MANIFEST="$M" "$WRAPPER" "$@" >"$OUT" 2>&1 || RC=$?
}

check() { # <what> <command...>
  CHECKS=$((CHECKS + 1))
  local what=$1
  shift
  if "$@"; then return 0; fi
  FAILED=$((FAILED + 1))
  echo "FAIL [$NAME] $what"
  echo "     ($*)"
  if [ -n "$OUT" ] && [ -f "$OUT" ]; then sed 's/^/     | /' "$OUT" | tail -n 25; fi
}

eq() { [ "$1" = "$2" ] || {
  echo "     got: '$1'  want: '$2'"
  return 1
}; }
st() { jq -r "$1" "$R/run/proton-secrets.status" 2>/dev/null; }
value() { cat "$R/run/proton-secrets/$1" 2>/dev/null; }
linked() { readlink "$R/run/proton-secrets" 2>/dev/null; }
generations() { find "$R/run/proton-secrets.d" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' 2>/dev/null | sort | tr '\n' ' '; }
calls() { grep -c -- "$1" "$STUB_CTL/calls.log" || true; }
restarts() { sed -n 's/^--no-block restart -- //p' "$STUB_CTL/systemctl.log" | sort | tr '\n' ' '; }
not_dangling() { [ ! -L "$R/run/proton-secrets" ] || [ -d "$R/run/proton-secrets" ]; }
no() { ! "$@"; }
out_has() { grep -qF -- "$1" "$OUT"; }

# ---- 1. cold boot, everything fine ---------------------------------------------

scenario cold-boot
session valid
echo activating >"$STUB_CTL/unit-state/alpha-consumer.service"
echo failed >"$STUB_CTL/unit-state/beta-consumer.service"
echo inactive >"$STUB_CTL/unit-state/shared.service"
run unit
check "exit 0" eq "$RC" 0
check "generation 1 is linked" eq "$(linked)" "$R/run/proton-secrets.d/1"
check "alpha value" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"
check "beta value (item title and field with spaces)" eq "$(value beta)" "VALUE[Vault/Stream Keys/YouTube Vertical]"
check "gamma value (pass:// reference)" eq "$(value gamma)" "VALUE[pass://SHARE/ITEM/password]"
check "mode 0400 by default" eq "$(stat -c %a "$R/run/proton-secrets/alpha")" 400
check "declared mode 0440" eq "$(stat -c %a "$R/run/proton-secrets/beta")" 440
check "generation dir is 0751" eq "$(stat -c %a "$R/run/proton-secrets.d/1")" 751
check "custom path is a link into secretsDir" eq "$(readlink "$R/etc/app/linked-secret")" "$R/run/proton-secrets/linked"
check "symlink=false secret is a real file at its path" eq "$(cat "$R/var/lib/app/plain-secret")" "VALUE[Vault/plain/secret]"
check "symlink=false secret is not in the generation" no test -e "$R/run/proton-secrets/plain"
check "no work directory left behind" eq "$(find "$R/run/proton-secrets.d" -name '.work.*' | wc -l)" 0
check "status: ok" eq "$(st .state)" ok
check "status: mode" eq "$(st .mode)" unit
check "status: attempt 1" eq "$(st .attempt)" 1
check "status: session ok" eq "$(st .session.state)" ok
check "status: every secret fetched" eq "$(st '[.secrets[].source] | unique | join(",")')" fetched
check "status: all six changed" eq "$(st '.changed | length')" 6
check "status file holds no secret value" no grep -q 'VALUE\[' "$R/run/proton-secrets.status"
check "status file is world-readable" eq "$(stat -c %a "$R/run/proton-secrets.status")" 644
check "probed with info, once" eq "$(calls '^info =>')" 1
check "never calls pass-cli test" eq "$(calls '^test')" 0
check "no login, no logout" eq "$(calls '^log')" 0
check "one item view per secret" eq "$(calls '^item view')" 6
check "starting and failed consumers restarted, the stopped one left alone" \
  eq "$(restarts)" "alpha-consumer.service any-change.service beta-consumer.service "
check "status: restarted" eq "$(st '.restarted | sort | join(" ")')" "alpha-consumer.service any-change.service beta-consumer.service"
check "status: restartSkipped" eq "$(st '.restartSkipped | join(" ")')" "shared.service"
check "reset-failed before the restart" grep -qx -- 'reset-failed -- beta-consumer.service' "$STUB_CTL/systemctl.log"

# ---- 2. unchanged content: nothing moves -----------------------------------------

: >"$STUB_CTL/systemctl.log"
ino=$(stat -c %i "$R/run/proton-secrets.d/1/alpha")
run unit
check "exit 0" eq "$RC" 0
check "still generation 1" eq "$(linked)" "$R/run/proton-secrets.d/1"
check "the file was not rewritten" eq "$(stat -c %i "$R/run/proton-secrets.d/1/alpha")" "$ino"
check "only generation 1 exists" eq "$(generations)" "1 "
check "status: every secret unchanged" eq "$(st '[.secrets[].source] | unique | join(",")')" unchanged
check "status: nothing changed" eq "$(st '.changed | length')" 0
check "no systemctl call at all" eq "$(wc -l <"$STUB_CTL/systemctl.log")" 0

# ---- 3. one value rotated: its consumers only -----------------------------------

echo "rotated-alpha" >"$STUB_CTL/values/Vault_alpha_secret"
run unit
check "exit 0" eq "$RC" 0
check "generation 2 is linked" eq "$(linked)" "$R/run/proton-secrets.d/2"
check "generation 1 was removed" eq "$(generations)" "2 "
check "new alpha" eq "$(value alpha)" "rotated-alpha"
check "beta carried into the new generation unchanged" eq "$(value beta)" "VALUE[Vault/Stream Keys/YouTube Vertical]"
check "beta keeps its mode" eq "$(stat -c %a "$R/run/proton-secrets/beta")" 440
check "status: only alpha changed" eq "$(st '.changed | join(",")')" alpha
check "exactly alpha's units plus the global one" eq "$(restarts)" "alpha-consumer.service any-change.service "
check "symlink never dangles" not_dangling

# Rotating the shared-consumer secrets: shared.service is listed twice, restarted once.
: >"$STUB_CTL/systemctl.log"
echo active >"$STUB_CTL/unit-state/shared.service"
echo "rotated-beta" >"$STUB_CTL/values/Vault_Stream Keys_YouTube Vertical"
echo "rotated-gamma" >"$STUB_CTL/values/pass:__SHARE_ITEM_password"
run unit
check "generation 3" eq "$(generations)" "3 "
check "units deduplicated" eq "$(restarts)" "any-change.service beta-consumer.service shared.service "

# A changed symlink=false secret is replaced in place.
: >"$STUB_CTL/systemctl.log"
echo "rotated-plain" >"$STUB_CTL/values/Vault_plain_secret"
run unit
check "plain file replaced" eq "$(cat "$R/var/lib/app/plain-secret")" "rotated-plain"
check "no new generation for it" eq "$(generations)" "3 "
check "status: plain changed" eq "$(st '.changed | join(",")')" plain

# ---- 4. network down, back within the in-run wait --------------------------------

scenario network-flap
session valid
echo 2 >"$STUB_CTL/net-down-calls"
run unit
check "exit 0" eq "$RC" 0
check "probed three times" eq "$(calls '^info =>')" 3
check "no login, no logout" eq "$(calls '^log')" 0
check "all installed" eq "$(st .state)" ok

# ---- 5. network down for the whole run -------------------------------------------

scenario network-down
session valid
touch "$STUB_CTL/net-down"
before=$(cd "$R/var/lib/proton-pass-cli" && find . -type f -exec md5sum {} + | sort)
run unit
check "exit 75 (temporary)" eq "$RC" 75
check "probe attempts = preflightRetries" eq "$(calls '^info =>')" 3
check "no login, no logout, no fetch" eq "$(calls '^log\|^item')" 0
check "session files untouched" eq "$(cd "$R/var/lib/proton-pass-cli" && find . -type f -exec md5sum {} + | sort)" "$before"
check "nothing linked" no test -e "$R/run/proton-secrets"
check "status: failed (no value at all)" eq "$(st .state)" failed
check "status: retry" eq "$(st .retry)" true
check "status: session network" eq "$(st .session.state)" network
check "status: error class" eq "$(st .error.class)" network
check "status: not permanent" eq "$(st .error.permanent)" false
check "pass-cli's own words are shown" out_has "no servers available"
check "the backtrace is not" no out_has "Stack backtrace"
run unit
check "status: attempt counts up" eq "$(st .attempt)" 2
rm "$STUB_CTL/net-down"
run unit
check "recovers" eq "$RC" 0
check "status: third attempt succeeded" eq "$(st .attempt)" 3
run unit
check "status: attempt restarts after a success" eq "$(st .attempt)" 1

# Network lost between the probe and the fetch: what is linked stays, temporary.
scenario network-lost-mid-run
session valid
run unit
: >"$STUB_CTL/calls.log"
echo "rotated" >"$STUB_CTL/values/Vault_alpha_secret"
echo 1 >"$STUB_CTL/net-up-calls" # the probe gets through, the first read does not
run unit
check "exit 75" eq "$RC" 75
check "one failed item view, the rest not attempted" eq "$(calls '^item view')" 1
check "no login, no logout" eq "$(calls '^log')" 0
check "old values still linked" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"
check "status: degraded (stale values)" eq "$(st .state)" degraded
check "status: carried" eq "$(st '[.secrets[].source] | unique | join(",")')" carried
check "status: stale" eq "$(st '.secrets.alpha.stale')" true

# ---- 6. one missing field among several ------------------------------------------

scenario missing-field
session valid
echo "Vault/Stream Keys/YouTube Vertical" >"$STUB_CTL/missing"
run unit
check "exit 78 (permanent)" eq "$RC" 78
check "the others are installed" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"
check "and the ones after it too" eq "$(value gamma)" "VALUE[pass://SHARE/ITEM/password]"
check "the missing one is absent" no test -e "$R/run/proton-secrets/beta"
check "status: failed" eq "$(st .state)" failed
check "status: beta missing" eq "$(st .secrets.beta.source)" missing
check "status: beta error class" eq "$(st .secrets.beta.error.class)" missing
check "status: beta error text is pass-cli's" eq "$(st '.secrets.beta.error.detail | test("Field does not exist")')" true
check "status: alpha fetched" eq "$(st .secrets.alpha.source)" fetched
check "status: permanent" eq "$(st .error.permanent)" true
check "no in-run retry of a missing field" eq "$(calls 'YouTube Vertical')" 1
check "session left alone" eq "$(calls '^log')" 0

# The same for a field that exists but is empty.
scenario blank-field
session valid
echo "Vault/alpha/secret" >"$STUB_CTL/blank"
run unit
check "exit 78" eq "$RC" 78
check "a blank secret is not installed" no test -e "$R/run/proton-secrets/alpha"
check "status: class blank" eq "$(st .secrets.alpha.error.class)" blank

# An optional secret may be missing.
scenario optional-missing
session valid
echo "Vault/delta/secret" >"$STUB_CTL/missing"
run unit
check "exit 0" eq "$RC" 0
check "status: ok" eq "$(st .state)" ok
check "status: delta reported" eq "$(st .secrets.delta.error.class)" missing
check "status: delta missing" eq "$(st .secrets.delta.source)" missing
check "the warning names it" out_has "optional secret 'delta'"

# ---- 7. carry-forward ------------------------------------------------------------

scenario carry-forward
session valid
run unit
check "first run ok" eq "$RC" 0
echo "Vault/Stream Keys/YouTube Vertical" >"$STUB_CTL/missing"
echo "rotated-alpha" >"$STUB_CTL/values/Vault_alpha_secret"
: >"$STUB_CTL/systemctl.log"
run unit
check "exit 78" eq "$RC" 78
check "beta keeps its previous value" eq "$(value beta)" "VALUE[Vault/Stream Keys/YouTube Vertical]"
check "alpha is the new value" eq "$(value alpha)" "rotated-alpha"
check "status: degraded" eq "$(st .state)" degraded
check "status: beta carried" eq "$(st .secrets.beta.source)" carried
check "status: beta stale" eq "$(st .secrets.beta.stale)" true
check "status: beta not changed" eq "$(st .secrets.beta.changed)" false
check "only alpha's consumers restarted" eq "$(restarts)" "alpha-consumer.service any-change.service "
check "generation 2, old one gone" eq "$(generations)" "2 "

# ---- 8. no session + a valid PAT -------------------------------------------------

scenario login-from-pat
session none
run unit
check "exit 0" eq "$RC" 0
check "logged in once" eq "$(calls '^login => logged in (PAT via env)')" 1
check "the PAT was in the environment, not on argv" eq "$(calls 'via argv')" 0
check "the PAT is not in the call log" no grep -qF "pst_0123" "$STUB_CTL/calls.log"
check "the PAT is not in the output" no grep -qF "pst_0123" "$OUT"
check "the PAT is not in the status file" no grep -qF "pst_" "$R/run/proton-secrets.status"
check "no logout" eq "$(calls '^logout')" 0
check "status: logged in" eq "$(st .session.loggedIn)" true
check "session files exist" test -s "$R/var/lib/proton-pass-cli/.session/pat_key"

# Network errors during the login are retried inside the run.
scenario login-network-flap
session none
echo 2 >"$STUB_CTL/net-down-calls"
run unit
check "exit 0" eq "$RC" 0
check "three login attempts" eq "$(calls '^login')" 3
check "never a logout" eq "$(calls '^logout')" 0

# The server dropped the session. pass-cli 2.1.3 then drops most of .session and
# leaves a session.json no command can open — not even `login`.
scenario session-rejected
session valid
touch "$STUB_CTL/session-rejected"
run unit
check "exit 0" eq "$RC" 0
check "the login over the leftovers fails first" eq "$(calls '^login => store corrupt')" 1
check "one reset" eq "$(calls '^logout --force')" 1
check "then logged in from the PAT" eq "$(calls '^login => logged in')" 1
check "all secrets fetched" eq "$(st .state)" ok

# pass-cli 2.4.1 keeps the files: every command fails and `login` refuses.
scenario session-rejected-files-kept
session valid
touch "$STUB_CTL/session-rejected-keep"
run unit
check "exit 0" eq "$RC" 0
check "one reset" eq "$(calls '^logout --force')" 1
check "one login" eq "$(calls '^login => logged in')" 1
check "never tried to log in over the dead session" eq "$(calls 'already authenticated')" 0
check "status: reset" eq "$(st .session.reset)" true

# The same, noticed only in the middle of the fetch.
scenario session-rejected-mid-fetch
session valid
echo 3 >"$STUB_CTL/reject-after" # the probe and two reads get through
run unit
check "exit 0" eq "$RC" 0
check "one reset" eq "$(calls '^logout --force')" 1
check "one login" eq "$(calls '^login => logged in')" 1
check "every secret fetched in the end" eq "$(st '[.secrets[].source] | unique | join(",")')" fetched

# Without a PAT the dead session is reported, not removed.
scenario session-rejected-no-pat
session valid
manifest '.patFile = null'
touch "$STUB_CTL/session-rejected-keep"
before=$(cd "$R/var/lib/proton-pass-cli" && find . -type f -exec md5sum {} + | sort)
run unit
check "exit 78" eq "$RC" 78
check "no logout, no login" eq "$(calls '^log')" 0
check "session files untouched" eq "$(cd "$R/var/lib/proton-pass-cli" && find . -type f -exec md5sum {} + | sort)" "$before"
check "status: session-rejected" eq "$(st .session.state)" session-rejected
check "tells the operator" out_has "proton-secrets repair --force"

# No session and no PAT file: a human has to log in.
scenario no-session-no-pat
session none
rm "$R/var/lib/proton-pass-cli/pat"
run unit
check "exit 78" eq "$RC" 78
check "no login attempt" eq "$(calls '^login')" 0
check "status: no-session" eq "$(st .session.state)" no-session
check "says what to run" out_has "proton-secrets login"

# ---- 9. the empty pat_key state --------------------------------------------------

scenario empty-pat-key
session empty-pat-key
run unit
check "exit 0" eq "$RC" 0
check "the probe saw nothing wrong" eq "$(head -n 1 "$STUB_CTL/calls.log")" "info => ok"
check "one forced logout" eq "$(calls '^logout --force')" 1
check "one login" eq "$(calls '^login => logged in (PAT via env)')" 1
check "all secrets installed" eq "$(st '[.secrets[].source] | unique | join(",")')" fetched
check "status: session was reset" eq "$(st .session.reset)" true

# Without a PAT that session is not ours to throw away.
scenario empty-pat-key-no-pat
session empty-pat-key
manifest '.patFile = null'
before=$(cd "$R/var/lib/proton-pass-cli" && find . -type f -exec md5sum {} + | sort)
run unit
check "exit 78" eq "$RC" 78
check "no logout, no login" eq "$(calls '^log')" 0
check "session files untouched" eq "$(cd "$R/var/lib/proton-pass-cli" && find . -type f -exec md5sum {} + | sort)" "$before"
check "tells the operator" out_has "proton-secrets repair --force"
check "tells them once, not per secret" eq "$(grep -c 'repair --force' "$OUT")" 1

# No vault readable at all, without the tell-tale pat_key line: could be the
# session, so it gets the one reset — and stays permanent when that changes nothing.
scenario vault-not-granted
session valid
: >"$STUB_CTL/vault-hidden"
run unit
check "exit 78" eq "$RC" 78
check "exactly one reset" eq "$(calls '^logout --force')" 1
check "exactly one login" eq "$(calls '^login')" 1
check "each secret tried twice, not more" eq "$(calls '^item view')" 12
check "status: class vault" eq "$(st .secrets.alpha.error.class)" vault
check "status: permanent" eq "$(st .error.permanent)" true

# One vault not visible among good ones is a naming/grant problem: the session
# that read the others is left alone.
scenario one-vault-hidden
session valid
echo "Vault/alpha/secret" >"$STUB_CTL/vault-hidden"
run unit
check "exit 78" eq "$RC" 78
check "no reset, no login" eq "$(calls '^log')" 0
check "the others are installed" eq "$(value beta)" "VALUE[Vault/Stream Keys/YouTube Vertical]"
check "status: alpha class vault" eq "$(st .secrets.alpha.error.class)" vault

# The vault keys stay unreadable even for a fresh session: one reset, no loop.
scenario pat-key-broken
session valid
touch "$STUB_CTL/pat-key-broken"
run unit
check "exit 78" eq "$RC" 78
check "exactly one reset" eq "$(calls '^logout --force')" 1
check "exactly one login" eq "$(calls '^login')" 1
check "status: class pat-key" eq "$(st .secrets.alpha.error.class)" pat-key

# An empty pat_key AND an expired PAT: the reset cannot be undone, and the run
# says the PAT is the problem instead of retrying for ever.
scenario empty-pat-key-pat-invalid
session empty-pat-key
touch "$STUB_CTL/pat-invalid"
run unit
check "exit 78" eq "$RC" 78
check "one login attempt" eq "$(calls '^login')" 1
check "status: pat-invalid" eq "$(st .error.class)" pat-invalid
check "status: every secret permanent" eq "$(st '[.secrets[] | select(.optional | not) | .error.class] | unique | join(",")')" pat-invalid
run unit
check "again: no second login with the rejected PAT" eq "$(calls '^login')" 1
check "again: 78" eq "$RC" 78
# The PAT works again (renewed in the account, same token): repair does not wait.
rm "$STUB_CTL/pat-invalid"
wrapper repair
check "repair logs in right away" eq "$RC" 0
run unit
check "and the fetch works" eq "$RC" 0

# ---- 10. a corrupt session store --------------------------------------------------

for kind in corrupt-key corrupt-session; do
  scenario "store-$kind"
  session "$kind"
  run unit
  check "exit 0" eq "$RC" 0
  check "reset once" eq "$(calls '^logout --force')" 1
  check "logged in again" eq "$(calls '^login => logged in (PAT via env)')" 1
  check "all installed" eq "$(st .state)" ok

  scenario "store-$kind-no-pat"
  session "$kind"
  manifest '.patFile = null'
  before=$(cd "$R/var/lib/proton-pass-cli" && find . -type f -exec md5sum {} + | sort)
  run unit
  check "exit 78" eq "$RC" 78
  check "never logs out without a PAT" eq "$(calls '^logout')" 0
  check "session files untouched" eq "$(cd "$R/var/lib/proton-pass-cli" && find . -type f -exec md5sum {} + | sort)" "$before"
  check "status: store-corrupt" eq "$(st .session.state)" store-corrupt
  check "tells the operator" out_has "proton-secrets repair --force"
done

# ---- 11. the PAT is no longer valid ----------------------------------------------

scenario pat-invalid
session none
touch "$STUB_CTL/pat-invalid"
run unit
check "exit 78" eq "$RC" 78
check "one login attempt, no retry" eq "$(calls '^login')" 1
check "no forced logout" eq "$(calls '^logout')" 0
check "status: pat-invalid" eq "$(st .session.state)" pat-invalid
check "status: permanent" eq "$(st .error.permanent)" true
check "names the PAT file" out_has "$R/var/lib/proton-pass-cli/pat"
check "says how to renew" out_has "personal-access-token renew"
check "the PAT file is still there" test -s "$R/var/lib/proton-pass-cli/pat"
# Whatever starts the fetch again must not turn into a login storm with a dead PAT.
run unit
check "again: still 78" eq "$RC" 78
check "again: the rejected PAT is not presented a second time" eq "$(calls '^login')" 1
check "again: says so" out_has "not asked again"
check "again: status still pat-invalid" eq "$(st .session.state)" pat-invalid
wrapper repair
check "repair tries the PAT at once (and it is still rejected)" eq "$(calls '^login')" 2
# A new PAT in the file is tried immediately.
rm "$STUB_CTL/pat-invalid"
sleep 0.05
printf '%s\n' "$PAT" >"$R/var/lib/proton-pass-cli/pat"
run unit
check "new PAT file: logged in" eq "$(calls '^login => logged in')" 1
check "new PAT file: exit 0" eq "$RC" 0

# With secrets linked from before, they stay.
scenario pat-invalid-warm
session valid
run unit
session none
touch "$STUB_CTL/pat-invalid"
run unit
check "exit 78" eq "$RC" 78
check "previous values stay linked" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"
check "status: degraded" eq "$(st .state)" degraded

# ---- 12. errors nobody classified ------------------------------------------------

scenario odd-error-recovers
session valid
echo 2 >"$STUB_CTL/odd-errors"
run unit
check "two in-run retries are enough" eq "$RC" 0

scenario odd-error-persists
session valid
echo 99 >"$STUB_CTL/odd-errors"
run unit
check "exit 75 (unknown is temporary)" eq "$RC" 75
check "session never touched" eq "$(calls '^log')" 0
check "three tries per secret" eq "$(calls 'Vault/alpha/secret\|item view --vault-name Vault --item-title alpha')" 3

# ---- 13. activation: failClosed ---------------------------------------------------

scenario failclosed-cold
session valid
echo "Vault/alpha/secret" >"$STUB_CTL/missing"
run activate
check "non-zero" test "$RC" -ne 0
check "nothing linked" no test -e "$R/run/proton-secrets"
check "no generation" eq "$(generations)" ""
check "the symlink=false secret was not written either" no test -e "$R/var/lib/app/plain-secret"
check "status: failed" eq "$(st .state)" failed
check "says why" out_has "failClosed is set"

scenario failclosed-warm
session valid
run activate
check "first activation ok" eq "$RC" 0
check "status: mode activate" eq "$(st .mode)" activate
echo "Vault/alpha/secret" >"$STUB_CTL/missing"
echo "rotated-beta" >"$STUB_CTL/values/Vault_Stream Keys_YouTube Vertical"
: >"$STUB_CTL/systemctl.log"
run activate
check "non-zero" test "$RC" -ne 0
check "still generation 1" eq "$(generations)" "1 "
check "beta NOT updated (all or nothing)" eq "$(value beta)" "VALUE[Vault/Stream Keys/YouTube Vertical]"
check "no restarts" eq "$(restarts)" ""
check "status: degraded" eq "$(st .state)" degraded

# An optional secret does not fail a failClosed activation.
scenario failclosed-optional
session valid
echo "Vault/delta/secret" >"$STUB_CTL/missing"
run activate
check "exit 0" eq "$RC" 0
check "the rest is installed" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"

scenario failopen
session valid
manifest '.failClosed = false'
run activate
echo "Vault/alpha/secret" >"$STUB_CTL/missing"
echo "rotated-beta" >"$STUB_CTL/values/Vault_Stream Keys_YouTube Vertical"
: >"$STUB_CTL/systemctl.log"
run activate
check "exit 0" eq "$RC" 0
check "beta updated" eq "$(value beta)" "rotated-beta"
check "alpha carried" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"
check "warns" out_has "WARNING: refresh failed (failClosed=false)"
check "beta's consumers restarted" eq "$(restarts)" "any-change.service beta-consumer.service shared.service "
check "status: exit code recorded" eq "$(st .exitCode)" 78

# systemd stage-1 runs activate in the initrd: nothing to do there.
scenario initrd
session valid
RC=0
IN_NIXOS_SYSTEMD_STAGE1=true "$FETCH" --manifest "$M" activate >"$OUT" 2>&1 || RC=$?
check "exit 0" eq "$RC" 0
check "pass-cli never called" eq "$(wc -l <"$STUB_CTL/calls.log")" 0
check "nothing created" no test -e "$R/run/proton-secrets.d"

# nixos-install's chroot: no systemd, no /run/lock, nothing prepared.
scenario install-chroot
session valid
rm -rf "$R/run"
run mount
check "mount step ok" eq "$RC" 0
run activate
check "activation ok" eq "$RC" 0
check "secrets installed" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"
check "no systemctl call without systemd" eq "$(wc -l <"$STUB_CTL/systemctl.log")" 0
run chown
check "chown step ok" eq "$RC" 0

# ---- 14. repeated runs, leftovers, a blocked link ---------------------------------

scenario repeated
session valid
for i in 1 2 3 4; do
  echo "v$i" >"$STUB_CTL/values/Vault_alpha_secret"
  run unit
  check "run $i ok" eq "$RC" 0
  check "run $i: generation $i only" eq "$(generations)" "$i "
  check "run $i: link" eq "$(linked)" "$R/run/proton-secrets.d/$i"
  check "run $i: value" eq "$(value alpha)" "v$i"
  check "run $i: not dangling" not_dangling
done
# What a killed run leaves: a half-built next generation and a work directory.
mkdir -p "$R/run/proton-secrets.d/5" "$R/run/proton-secrets.d/.work.dead"
echo junk >"$R/run/proton-secrets.d/5/alpha"
echo junk >"$R/run/proton-secrets.d/.work.dead/x"
echo "v5" >"$STUB_CTL/values/Vault_alpha_secret"
run unit
check "leftovers: ok" eq "$RC" 0
check "leftovers: generation 5 rebuilt" eq "$(value alpha)" "v5"
check "leftovers: only generation 5" eq "$(generations)" "5 "
check "leftovers: work directory gone" no test -e "$R/run/proton-secrets.d/.work.dead"

# A secret dropped from the configuration leaves the ramfs.
manifest '.secrets |= map(select(.name != "gamma"))'
run unit
check "dropped: ok" eq "$RC" 0
check "dropped: gamma is gone" no test -e "$R/run/proton-secrets/gamma"
check "dropped: generation 6" eq "$(generations)" "6 "
check "dropped: nothing restarted for it" eq "$(st '.changed | length')" 0

scenario link-blocked
session valid
mkdir -p "$R/run/proton-secrets"
echo x >"$R/run/proton-secrets/stray"
run unit
check "exit 75" eq "$RC" 75
check "says what is in the way" out_has "is not the generation symlink"
check "the directory is untouched" test -f "$R/run/proton-secrets/stray"
check "no generation left behind" eq "$(generations)" ""
rm "$R/run/proton-secrets/stray"
run unit
check "an empty directory is replaced" eq "$RC" 0
check "by the link" test -L "$R/run/proton-secrets"

# ---- 15. the lock -----------------------------------------------------------------

scenario concurrent
session none
echo 0.05 >"$STUB_CTL/slow"
"$FETCH" --manifest "$M" unit >"$T/$NAME/out1" 2>&1 &
p1=$!
"$FETCH" --manifest "$M" unit >"$T/$NAME/out2" 2>&1 &
p2=$!
PROTON_SECRETS_MANIFEST="$M" "$WRAPPER" status >"$T/$NAME/out3" 2>&1 &
p3=$!
wait "$p1"
r1=$?
wait "$p2"
r2=$?
wait "$p3"
cat "$T/$NAME/out1" "$T/$NAME/out2" >>"$ALL_OUT"
OUT="$T/$NAME/out2"
check "both runs succeed" eq "$r1$r2" 00
check "no two pass-cli calls overlapped" no test -e "$STUB_CTL/overlap"
check "one login for both" eq "$(calls '^login => logged in')" 1
check "consistent result" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"
check "one generation" eq "$(generations | wc -w)" 1

scenario lock-busy
session valid
manifest '.timeouts.lock = 1'
mkdir -p "$R/run/lock"
flock "$R/run/lock/proton-pass-cli.lock" sleep 3 &
sleep 0.3
run unit
check "exit 75" eq "$RC" 75
check "pass-cli not called" eq "$(wc -l <"$STUB_CTL/calls.log")" 0
check "status: lock" eq "$(st .error.class)" lock
wait

# ---- 16. the sealed cache ---------------------------------------------------------

scenario cache
session valid
manifest '.cache.enable = true'
C="$R/var/lib/proton-secrets-cache"
run unit
check "exit 0" eq "$RC" 0
check "one entry per secret" eq "$(find "$C" -name '*.cred' | wc -l)" 6
check "cache dir is 0700" eq "$(stat -c %a "$C")" 700
check "entries are 0600" eq "$(stat -c %a "$C/alpha.cred")" 600
check "sealed with the configured key, bound to the name" eq "$(head -n 1 "$C/alpha.cred")" "SEALED host proton-secrets.alpha"
check "no plaintext in the cache" no grep -rq 'VALUE\[' "$C"
check "status: cache written" eq "$(st '.cache.written | length')" 6
ino=$(stat -c %i "$C/alpha.cred")
run unit
check "unchanged content: entries not rewritten" eq "$(stat -c %i "$C/alpha.cred")" "$ino"
check "status: nothing written" eq "$(st '.cache.written | length')" 0
echo "rotated-alpha" >"$STUB_CTL/values/Vault_alpha_secret"
run unit
check "changed content: only that entry rewritten" eq "$(st '.cache.written | join(",")')" alpha
rm "$C/beta.cred"
run unit
check "a missing entry is written again" eq "$(st '.cache.written | join(",")')" beta
echo stale >"$C/retired.cred"
: >"$C/alpha.cred.tmp"
run unit
check "entries no longer declared are pruned" no test -e "$C/retired.cred"
check "status: pruned" eq "$(st '.cache.pruned | join(",")')" retired
check "stale temp files removed" no test -e "$C/alpha.cred.tmp"

# Reboot: /run is empty. Restore before anything else, with no network at all.
rm -rf "$R/run"
mkdir -p "$R/run/systemd/system"
touch "$STUB_CTL/net-down"
: >"$STUB_CTL/calls.log"
: >"$STUB_CTL/systemctl.log"
run restore
check "restore exit 0" eq "$RC" 0
check "restore: generation 1" eq "$(linked)" "$R/run/proton-secrets.d/1"
check "restore: the last fetched value" eq "$(value alpha)" "rotated-alpha"
check "restore: mode" eq "$(stat -c %a "$R/run/proton-secrets/beta")" 440
check "restore: symlink=false secret back at its path" eq "$(cat "$R/var/lib/app/plain-secret")" "VALUE[Vault/plain/secret]"
check "restore: custom link" eq "$(readlink "$R/etc/app/linked-secret")" "$R/run/proton-secrets/linked"
check "restore: pass-cli never called" eq "$(wc -l <"$STUB_CTL/calls.log")" 0
check "restore: nothing restarted" eq "$(wc -l <"$STUB_CTL/systemctl.log")" 0
check "restore: status restored" eq "$(st .state)" restored
check "restore: sources" eq "$(st '[.secrets[].source] | unique | join(",")')" cache
check "restore: stale" eq "$(st .secrets.alpha.stale)" true
run restore
check "a second restore does not clobber" eq "$(generations)" "1 "
# Still offline when the fetch unit runs: the restored values stay.
run unit
check "offline fetch: 75" eq "$RC" 75
check "offline fetch: values stay" eq "$(value alpha)" "rotated-alpha"
check "offline fetch: degraded" eq "$(st .state)" degraded
check "offline fetch: carried" eq "$(st .secrets.alpha.source)" carried
# Online again, nothing rotated meanwhile: verified, nothing restarted.
rm "$STUB_CTL/net-down"
run unit
check "healthy boot: 0" eq "$RC" 0
check "healthy boot: same generation" eq "$(generations)" "1 "
check "healthy boot: unchanged" eq "$(st '[.secrets[].source] | unique | join(",")')" unchanged
check "healthy boot: restarts nothing" eq "$(wc -l <"$STUB_CTL/systemctl.log")" 0
check "healthy boot: cache not rewritten" eq "$(st '.cache.written | length')" 0

# Damaged and missing entries are skipped, never fatal.
rm -rf "$R/run"
echo garbage >"$C/alpha.cred"
cp "$C/gamma.cred" "$C/beta.cred" # an entry copied over another: wrong name inside
rm "$C/delta.cred"
run restore
check "partial restore exit 0" eq "$RC" 0
check "undecryptable entry skipped" no test -e "$R/run/proton-secrets/alpha"
check "entry sealed under another name refused" no test -e "$R/run/proton-secrets/beta"
check "the others restored" eq "$(value gamma)" "VALUE[pass://SHARE/ITEM/password]"
check "says which and why" out_has "cache entry for 'alpha' did not decrypt"
check "status: alpha missing" eq "$(st .secrets.alpha.source)" missing

# Nothing linked, Proton unreachable, restore unit did not run: the fetch falls
# back to the cache itself.
rm -rf "$R/run"
mkdir -p "$R/run/systemd/system"
session valid
run unit
check "repairs the cache on the next good fetch" eq "$(st '.cache.written | sort | join(",")')" "alpha,beta,delta"
rm -rf "$R/run"
mkdir -p "$R/run/systemd/system"
touch "$STUB_CTL/net-down"
run unit
check "fallback: 75" eq "$RC" 75
check "fallback: value from the cache" eq "$(value alpha)" "rotated-alpha"
check "fallback: source cache" eq "$(st .secrets.alpha.source)" cache
check "fallback: degraded" eq "$(st .state)" degraded

# The sealing tool failing never fails the fetch.
scenario cache-broken
session valid
manifest '.cache.enable = true'
touch "$STUB_CTL/creds-fail"
run unit
check "exit 0" eq "$RC" 0
check "secrets installed" eq "$(value alpha)" "VALUE[Vault/alpha/secret]"
check "status: problems listed" eq "$(st '.problems | length > 0')" true
run restore
check "restore with a broken tool: exit 0" eq "$RC" 0

# ---- 17. the proton-secrets CLI ----------------------------------------------------

scenario cli
session none
wrapper status
check "status without a session: non-zero" test "$RC" -ne 0
check "status: says to log in" out_has "proton-secrets login"
wrapper login
check "login from the manifest's PAT file" eq "$RC" 0
check "PAT via the environment" eq "$(calls '^login => logged in (PAT via env)')" 1
wrapper login
check "second login: already logged in" eq "$RC" 0
check "no second pass-cli login" eq "$(calls '^login')" 1
wrapper status
check "status with a session" eq "$RC" 0
check "status prints pass-cli info" out_has '"name"'
wrapper resolve --vault-name Vault --item-title alpha --field secret
check "resolve prints the value" eq "$(cat "$OUT")" "VALUE[Vault/alpha/secret]"
run unit
wrapper doctor
cat "$OUT" >>"$ALL_OUT"
check "doctor: exit 0" eq "$RC" 0
check "doctor: pass-cli version" out_has "0.0.0-stub"
check "doctor: session file sizes" out_has "pat_key: 60 bytes"
check "doctor: PAT file readable" out_has "pat (readable)"
check "doctor: probe result" out_has "session probe: ok"
check "doctor: last run" out_has "state: ok"
check "doctor: per-secret line" out_has "alpha: fetched (changed)"
check "doctor: prints no secret" no out_has "VALUE["
check "doctor: prints no PAT" no out_has "pst_"
: >"$R/var/lib/proton-pass-cli/.session/pat_key"
wrapper doctor
check "doctor: flags the empty pat_key" out_has "pat_key: 0 bytes   <-- EMPTY"
wrapper repair
check "repair: ok" eq "$RC" 0
check "repair: forced logout" eq "$(calls '^logout --force')" 1
check "repair: pat_key is back" test -s "$R/var/lib/proton-pass-cli/.session/pat_key"
: >"$R/var/lib/proton-pass-cli/.session/local.key"
wrapper status
check "status on a corrupt store points at repair" out_has "proton-secrets repair"
wrapper login
check "login repairs a corrupt store when there is a PAT" eq "$RC" 0
: >"$STUB_CTL/systemctl.log"
wrapper refresh
check "refresh: ok" eq "$RC" 0
check "refresh restarts the fetch unit" grep -qx -- 'restart -- proton-secrets-fetch.service' "$STUB_CTL/systemctl.log"
check "refresh shows the last run" out_has "state: ok"
wrapper logout
check "logout" eq "$(calls '^logout => logged out')" 1
wrapper help
check "help lists the new commands" out_has "repair [--force]"

# Without a PAT: repair refuses unless forced, login falls through to pass-cli's own.
scenario cli-no-pat
session valid
manifest '.patFile = null'
wrapper repair
check "repair without a PAT refuses" eq "$RC" 3
check "and removed nothing" eq "$(calls '^logout')" 0
wrapper repair --force
check "repair --force" eq "$RC" 0
check "session removed" no test -e "$R/var/lib/proton-pass-cli/.session"
wrapper login
check "interactive login is pass-cli's (the stub has no web flow)" eq "$(calls '^login => web login')" 1

# The installer image: no module, no manifest, a PAT in the environment.
scenario cli-installer
RC=0
env -u PROTON_SECRETS_MANIFEST PROTON_PASS_SESSION_DIR="$R/session" PROTON_PASS_PERSONAL_ACCESS_TOKEN="$PAT" \
  "$WRAPPER" login >"$OUT" 2>&1 || RC=$?
check "login from PROTON_PASS_PERSONAL_ACCESS_TOKEN" eq "$RC" 0
check "PAT via the environment" eq "$(calls '^login => logged in (PAT via env)')" 1
RC=0
env -u PROTON_SECRETS_MANIFEST PROTON_PASS_SESSION_DIR="$R/session" "$WRAPPER" status >"$OUT" 2>&1 || RC=$?
check "status follows PROTON_PASS_SESSION_DIR" eq "$RC" 0
printf '%s\r\n' "$PAT" >"$R/pat-crlf"
rm -rf "$R/session"
RC=0
env -u PROTON_SECRETS_MANIFEST PROTON_PASS_SESSION_DIR="$R/session" PROTON_PASS_PAT_FILE="$R/pat-crlf" \
  "$WRAPPER" login >"$OUT" 2>&1 || RC=$?
check "login from PROTON_PASS_PAT_FILE (CRLF tolerated)" eq "$RC" 0

# ---- nothing above ever printed a secret or the PAT --------------------------------

NAME=secrecy
OUT=""
check "no secret value in any fetch output" no grep -q 'VALUE\[\|rotated-' "$ALL_OUT"
check "no PAT in any fetch output" no grep -qF 'pst_0123' "$ALL_OUT"
check "no PAT in any call log" no grep -rqF 'pst_0123' --include=calls.log "$T"
check "no PAT in any status file" no grep -rqF 'pst_0123' --include=proton-secrets.status "$T"

echo
echo "$CHECKS checks, $FAILED failed"
rm -rf "$T"
[ "$FAILED" -eq 0 ]
