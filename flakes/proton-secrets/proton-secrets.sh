# proton-secrets — the human front door to Proton Pass on a headless box.
# (writeShellApplication supplies the shebang, `set -euo pipefail` and shellcheck.)
#
# It never calls pass-cli itself: every command goes through proton-secrets-fetch,
# so this CLI, the activation step and the fetch unit share one lock (pass-cli has
# none, and two of them at once can leave the session store unreadable), one
# session probe and one login path.

FETCH='__FETCH__'

# What the engine makes of the session:
# ok | no-session | store-corrupt | session-rejected | network | unknown.
# (`pass-cli test` cannot answer this: it only pings an endpoint that needs no
# login, and it is gone from pass-cli 2.2.4+.)
STATE=unknown
session_state() {
  STATE=$("$FETCH" probe 2>/dev/null) || true
  if [ -z "$STATE" ]; then STATE=unknown; fi
}

not_ok() { # what to tell the user for a session that is not "ok"
  case "$STATE" in
    no-session) echo "proton-secrets: no active session — run: proton-secrets login" >&2 ;;
    store-corrupt) echo "proton-secrets: the local session store is unreadable — run: proton-secrets repair   (with no PAT: repair --force, then login)" >&2 ;;
    session-rejected) echo "proton-secrets: Proton no longer accepts the stored session — run: proton-secrets repair   (with no PAT: repair --force, then login)" >&2 ;;
    network) echo "proton-secrets: there is a session, but Proton Pass cannot be reached (network?)" >&2 ;;
    *) echo "proton-secrets: cannot tell whether the session works — run: proton-secrets doctor" >&2 ;;
  esac
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  login)
    if [ "$#" -eq 0 ]; then
      # With a PAT (PROTON_PASS_PERSONAL_ACCESS_TOKEN, PROTON_PASS_PAT_FILE or the
      # module's patFile) this is non-interactive. pass-cli reads the PAT from
      # the environment on `login`, so it never has to appear on a command line.
      rc=0
      "$FETCH" login || rc=$?
      # 3 = no PAT anywhere: only the interactive login below can help.
      if [ "$rc" -ne 3 ]; then exit "$rc"; fi
    fi
    session_state
    case "$STATE" in
      ok)
        echo "proton-secrets: already logged in."
        exit 0
        ;;
      store-corrupt | session-rejected | network)
        not_ok
        exit 1
        ;;
    esac
    # Bare `login` here is pass-cli's interactive web flow; arguments
    # (`--interactive`, a username, …) are passed through.
    exec "$FETCH" exec login "$@"
    ;;
  logout)
    exec "$FETCH" exec logout "$@"
    ;;
  status | info)
    session_state
    if [ "$STATE" = ok ]; then
      exec "$FETCH" exec info --output json "$@"
    fi
    not_ok
    exit 1
    ;;
  # resolve/decrypt: print ONE secret's plaintext to stdout (debug helper).
  #   proton-secrets resolve pass://SHARE_ID/ITEM_ID/FIELD
  #   proton-secrets resolve --vault-name V --item-title T --field F
  resolve | decrypt)
    session_state
    if [ "$STATE" != ok ]; then
      not_ok
      exit 3
    fi
    exec "$FETCH" exec item view "$@" --output human
    ;;
  doctor)
    exec "$FETCH" doctor
    ;;
  repair)
    exec "$FETCH" repair "$@"
    ;;
  refresh)
    exec "$FETCH" refresh
    ;;
  help | --help | -h)
    cat <<'EOF'
usage: proton-secrets <command> [args]
  login              log in and persist a session (from a PAT if there is one, else interactive)
  logout             drop the persisted session
  status             show account/session info (JSON), non-zero if there is no working session
  resolve <ref>      print one secret value to stdout (pass://SHARE/ITEM/FIELD)
  doctor             diagnose: pass-cli version, session files, session probe, PAT file,
                     the last fetch and the sealed cache (prints no secret)
  repair [--force]   reset the local session (pass-cli logout --force) and log in again from
                     the PAT; --force resets even when there is no PAT to log in with
  refresh            run the fetch unit now, wait for it and show the result

Secrets missing after a boot?  proton-secrets doctor  — its "session probe" line says:
  ok                the session works; look at the per-secret lines of the last run
  no-session        nobody is logged in: proton-secrets login
  store-corrupt     the session files are damaged (a power cut): proton-secrets repair
  session-rejected  Proton dropped the session: proton-secrets repair
  network           Proton cannot be reached; the fetch unit keeps retrying
then:  proton-secrets refresh

Environment:
  PROTON_PASS_SESSION_DIR            session store (default: the module's sessionDir, else the baked-in dir)
  PROTON_PASS_KEY_PROVIDER           key backend: fs|keyring|env (default: fs, headless)
  PROTON_PASS_PAT_FILE               file holding a PAT (pst_...::key) for login
  PROTON_PASS_PERSONAL_ACCESS_TOKEN  the PAT itself
The two PAT variables are for a box without services.proton-secrets. Where the
module names a patFile, that file comes first and they are only used when it
holds nothing.
EOF
    exit 0
    ;;
  *)
    echo "proton-secrets: unknown command '$cmd' (try: proton-secrets help)" >&2
    exit 64
    ;;
esac
