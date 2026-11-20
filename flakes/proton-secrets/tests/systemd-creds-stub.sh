# systemd-creds for the proton-secrets flake check (the build sandbox has no host
# key and no TPM): "seals" by base64 behind a header that carries the name and the
# key type, and refuses to open an entry under another name — the properties the
# engine relies on. $STUB_CTL/creds-fail makes every call fail.
# (writeShellApplication supplies the shebang and `set -euo pipefail`.)
echo "$*" >>"$STUB_CTL/creds.log"
if [ -e "$STUB_CTL/creds-fail" ]; then
  echo "Failed to determine local credential host secret: stub" >&2
  exit 1
fi
cmd=$1
shift
key=""
name=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-key=*) key=${1#--with-key=} ;;
    --name=*) name=${1#--name=} ;;
    *) break ;;
  esac
  shift
done
in=$1
out=$2
case "$cmd" in
  encrypt)
    {
      printf 'SEALED %s %s\n' "$key" "$name"
      base64 <"$in"
    } >"$out"
    ;;
  decrypt)
    if [ "$(head -n 1 "$in" | cut -d' ' -f1,3)" != "SEALED $name" ]; then
      echo "Embedded credential name does not match filename, refusing." >&2
      exit 1
    fi
    if [ "$out" = - ]; then
      tail -n +2 "$in" | base64 -d
    else
      tail -n +2 "$in" | base64 -d >"$out"
    fi
    ;;
  *) exit 64 ;;
esac
