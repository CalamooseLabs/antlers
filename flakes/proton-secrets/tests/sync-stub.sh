# sync for the proton-secrets flake check: records what the engine asked to have
# flushed to disk (the session files after a login and at the end of a run, a
# rewritten cache entry) instead of flushing anything.
# (writeShellApplication supplies the shebang and `set -euo pipefail`.)
echo "$*" >>"$STUB_CTL/sync.log"
