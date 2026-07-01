# proton-secrets — a headless-friendly wrapper CLI around Proton Pass `pass-cli`.
#
# A thin `writeShellApplication` (like flakes/scripts) that pins a persistent,
# out-of-store session directory and the `fs` key provider so `pass-cli` works
# with no dbus/keyring — i.e. on servers and inside NixOS activation. The
# companion module.nix uses `pkgs.proton-pass-cli` directly (absolute store
# paths, explicit env); this wrapper is the human-facing front door:
#
#   proton-secrets login     # interactive web/`--interactive`, or PAT-driven
#   proton-secrets status    # -> `pass-cli info` (there is no upstream `status`)
#   proton-secrets logout
#   proton-secrets resolve pass://SHARE/ITEM/FIELD   # debug: print one value
#
# The bundled `pass-cli` (nixpkgs `proton-pass-cli`) is UNFREE / non-redistributable
# and needs a paid Proton plan; antlers' pkgs set allowUnfree. Downstream consumers
# must permit it too (a narrow allowUnfreePredicate is enough).
{
  lib,
  writeShellApplication,
  proton-pass-cli,
  jq,
  coreutils,
  # Baked defaults; the environment (module / caller) can override either.
  defaultSessionDir ? "/var/lib/proton-pass-cli",
  defaultKeyProvider ? "fs",
}:
writeShellApplication {
  name = "proton-secrets";
  runtimeInputs = [proton-pass-cli jq coreutils];
  text = ''
    # Persistent, out-of-store session store + headless key provider. Callers may
    # override PROTON_PASS_SESSION_DIR / PROTON_PASS_KEY_PROVIDER in the env; we
    # only fill in defaults so `proton-secrets` and the activation step agree.
    export PROTON_PASS_SESSION_DIR="''${PROTON_PASS_SESSION_DIR:-${defaultSessionDir}}"
    export PROTON_PASS_KEY_PROVIDER="''${PROTON_PASS_KEY_PROVIDER:-${defaultKeyProvider}}"
    export PROTON_PASS_NO_UPDATE_CHECK=1

    # Optional: load a Personal Access Token from a file into the env that
    # `pass-cli login` consumes (never printed, never in the store).
    if [ -n "''${PROTON_PASS_PAT_FILE:-}" ] && [ -r "''${PROTON_PASS_PAT_FILE}" ]; then
      PROTON_PASS_PERSONAL_ACCESS_TOKEN="$(cat "''${PROTON_PASS_PAT_FILE}")"
      export PROTON_PASS_PERSONAL_ACCESS_TOKEN
    fi

    # Best-effort: on a real host the module's tmpfiles rule already owns this dir.
    mkdir -p "''${PROTON_PASS_SESSION_DIR}" 2>/dev/null || true

    # A live, usable session is the single source of truth (a PAT env var alone
    # does NOT authenticate reads — it only feeds `login`).
    have_session() { pass-cli test >/dev/null 2>&1; }

    cmd="''${1:-help}"
    shift || true
    case "$cmd" in
      login)
        if have_session; then
          echo "proton-secrets: already logged in (session at $PROTON_PASS_SESSION_DIR)."
          exit 0
        fi
        # PAT present -> non-interactive personal-access-token flow; else the
        # default interactive login (web/device flow, or pass `--interactive`).
        exec pass-cli login "$@"
        ;;
      logout)
        exec pass-cli logout "$@"
        ;;
      status | info)
        if have_session; then
          exec pass-cli info --output json "$@"
        fi
        echo "proton-secrets: no active session — run: proton-secrets login" >&2
        exit 1
        ;;
      # resolve/decrypt: print ONE secret's plaintext to stdout (debug helper).
      #   proton-secrets resolve pass://SHARE_ID/ITEM_ID/FIELD
      #   proton-secrets resolve --vault-name V --item-title T --field F
      resolve | decrypt)
        if ! have_session; then
          echo "proton-secrets: not authenticated — run: proton-secrets login" >&2
          exit 3
        fi
        exec pass-cli item view "$@" --output human
        ;;
      help | --help | -h)
        cat <<'EOF'
    usage: proton-secrets <command> [args]
      login              log in and persist a session (interactive, or PAT via env/file)
      logout             drop the persisted session
      status             show account/session info (JSON), non-zero if logged out
      resolve <ref>      print one secret value to stdout (pass://SHARE/ITEM/FIELD)
    Environment:
      PROTON_PASS_SESSION_DIR   session store (default: baked-in persistent dir)
      PROTON_PASS_KEY_PROVIDER  key backend: fs|keyring|env (default: fs, headless)
      PROTON_PASS_PAT_FILE      file holding a PAT (pst_...::key) for login
EOF
        exit 0
        ;;
      *)
        echo "proton-secrets: unknown command '$cmd' (try: proton-secrets help)" >&2
        exit 64
        ;;
    esac
  '';
  meta = {
    description = "Headless wrapper around Proton Pass pass-cli (fixed session dir + fs key provider)";
    mainProgram = "proton-secrets";
    platforms = ["x86_64-linux" "aarch64-linux"];
  };
}
