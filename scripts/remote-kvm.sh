# Target -> "DNS_URL IP_URL" map. One target per line, three
# whitespace-separated fields: "<name> <dns_url> <ip_url>". Override with
# REMOTE_KVM_TARGETS to add/replace targets without rebuilding.
REMOTE_KVM_TARGETS="${REMOTE_KVM_TARGETS:-homelab http://kvm.calamos.family/ http://10.10.10.26/
broadcast http://broadcast.thecompany.inc http://10.1.10.5}"

# Which KVM to open. Defaults to broadcast.
target="${1:-${REMOTE_KVM_DEFAULT:-broadcast}}"

# Look the target up in the map. dns_url/ip_url stay empty if not found.
dns_url=""
ip_url=""
known_targets=""
while read -r name dns ip; do
  # Skip blank lines.
  [ -n "$name" ] || continue
  known_targets="$known_targets $name"
  if [ "$name" = "$target" ]; then
    dns_url="$dns"
    ip_url="$ip"
  fi
done <<EOF
$REMOTE_KVM_TARGETS
EOF

if [ -z "$dns_url" ] && [ -z "$ip_url" ]; then
  # Trim the leading space off the collected target list for the usage message.
  echo "usage: remote-kvm [${known_targets# }]" >&2
  exit 1
fi

# Probe the DNS hostname: if it responds we're on that KVM's network and
# use the DNS URL; if it doesn't, we're off-network so fall back to the IP.
if curl --silent --output /dev/null --connect-timeout 3 "$dns_url"; then
  kvm_url="$dns_url"
else
  kvm_url="$ip_url"
fi

# Dedicated, throwaway-ish profile (per target) so the main profile stays untouched.
profile="${REMOTE_KVM_PROFILE_DIR:-$HOME/.local/share/remote-kvm}/$target"
mkdir -p "$profile"

# Launch chromium in --app mode: a single window with no tabs, omnibox,
# bookmarks or other browser chrome — just the KVM page. This is the
# native, stripped-down replacement for the old librewolf
# userChrome.css + user.js minimal-UI hack.
#
#   --user-data-dir                  per-target throwaway profile (isolated instance)
#   --autoplay-policy=...            KVM video stream must start without a click
#   --force-dark-mode                dark browser UI (menus, scrollbars)
#   --enable-features=...ForceDark   dark web content; drop this one if the
#                                    KVM UI already themes itself and ends
#                                    up looking double-inverted
#   --disable-features=HttpsUpgrades the KVM is http-only, so don't let
#                                    chromium auto-upgrade the connection
exec chromium \
  --user-data-dir="$profile" \
  --app="$kvm_url" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --autoplay-policy=no-user-gesture-required \
  --force-dark-mode \
  --enable-features=WebContentsForceDark \
  --disable-features=HttpsUpgrades
