# Non-persistent: every launch gets a fresh, throwaway profile that is
# deleted when the browser exits. Nothing — history, cookies, cache,
# logins — survives across runs. Prefer the per-user tmpfs runtime dir
# so it never touches persistent storage.
profile="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/chromium-ephemeral.XXXXXX")"
trap 'rm -rf "$profile"' EXIT

# ungoogled-chromium already strips Google's telemetry, sync and tracking
# integrations at build time; the flags below silence the remaining
# background chatter and first-run/crash nags. Args ("$@") pass through,
# so `chromium-ephemeral <url>` works.
"${CHROMIUM_EPHEMERAL_BIN:-chromium}" \
  --user-data-dir="$profile" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-background-networking \
  --disable-breakpad \
  --no-pings \
  "$@"
