# systemctl for the proton-secrets flake check: answers `show -P ActiveState` from
# $STUB_CTL/unit-state/<unit> (default: active) and records every call.
# $STUB_CTL/kill-on-show (once): the first `show` ends the whole process group
# with SIGTERM, the way systemd stops a unit — at that point the engine has
# linked the new generation and not yet restarted anything.
# (writeShellApplication supplies the shebang and `set -euo pipefail`.)
echo "$*" >>"$STUB_CTL/systemctl.log"
if [ "${1:-}" = show ] && [ -e "$STUB_CTL/kill-on-show" ]; then
  rm -f "$STUB_CTL/kill-on-show"
  kill -TERM 0
fi
if [ "${1:-}" = show ]; then
  unit=${*: -1}
  cat "$STUB_CTL/unit-state/$unit" 2>/dev/null || echo active
fi
if [ "${1:-}" = is-active ]; then echo active; fi
# $STUB_CTL/unit-restart-fails: every restart is refused.
case " $* " in
  *" restart "*) if [ -e "$STUB_CTL/unit-restart-fails" ]; then exit 1; fi ;;
esac
exit 0
