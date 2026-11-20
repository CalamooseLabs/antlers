# systemctl for the proton-secrets flake check: answers `show -P ActiveState` from
# $STUB_CTL/unit-state/<unit> (default: active) and records every call.
# (writeShellApplication supplies the shebang and `set -euo pipefail`.)
echo "$*" >>"$STUB_CTL/systemctl.log"
if [ "${1:-}" = show ]; then
  unit=${*: -1}
  cat "$STUB_CTL/unit-state/$unit" 2>/dev/null || echo active
fi
if [ "${1:-}" = is-active ]; then echo active; fi
if [ "${1:-}" = restart ] && [ -e "$STUB_CTL/unit-restart-fails" ]; then exit 1; fi
exit 0
