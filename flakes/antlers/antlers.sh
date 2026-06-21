# antlers — shorthand wrapper around the antlers flake's templates and packages.
# (writeShellApplication supplies the shebang + `set -euo pipefail` + shellcheck.)

REF="${ANTLERS_REF:-__DEFAULT_REF__}"
SYSTEM="x86_64-linux"

# Bare, newline-separated names — used by `list` and by the shell-completion
# helper below. Both query the flake directly so they auto-discover.
templates_list() {
  nix eval --json "$REF#templates" --apply 'builtins.attrNames' | jq -r '.[]'
}
packages_list() {
  nix eval --json "$REF#packages.$SYSTEM" --apply 'builtins.attrNames' | jq -r '.[]'
}

usage() {
  cat <<EOF
antlers — shorthand for the antlers flake (ref: $REF)

Usage:
  antlers list                      List available templates and packages
  antlers new <template> [dir]      Scaffold a template into <dir> (default: ./<template>)
  antlers init <template>           Scaffold a template into the current directory
  antlers build <package> [args]    Build a package -> ./result
  antlers run <package> [args]      Run a package
  antlers shell                     Enter the antlers dev shell
  antlers help                      Show this help

Override the flake reference with ANTLERS_REF, e.g.
  ANTLERS_REF=github:CalamooseLabs/antlers/v1.0 antlers new nkc-master-lease

After scaffolding a document template, cd into it (direnv loads the dev shell)
and use that template's own commands — e.g. create-lease / edit-lease for
nkc-master-lease.
EOF
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  list | ls)
    echo "Templates  (antlers new <name> [dir]):"
    nix eval --json "$REF#templates" \
      --apply 'ts: builtins.mapAttrs (_: t: t.description or "") ts' \
      | jq -r 'to_entries[] | "  \(.key)|\(.value)"' \
      | column -t -s '|'
    echo
    echo "Packages   (antlers build|run <name>):"
    packages_list | while IFS= read -r p; do printf '  %s\n' "$p"; done
    ;;
  completions)
    # Hidden helper for shell completion: emit bare candidate names.
    case "${1:-}" in
      templates) templates_list ;;
      packages) packages_list ;;
      commands) printf '%s\n' list new init build run shell help ;;
      *) exit 1 ;;
    esac
    ;;
  new)
    tmpl="${1:-}"
    [ -n "$tmpl" ] || {
      echo "usage: antlers new <template> [dir]" >&2
      exit 1
    }
    dir="${2:-$tmpl}"
    exec nix flake new "$dir" -t "$REF#$tmpl"
    ;;
  init)
    tmpl="${1:-}"
    [ -n "$tmpl" ] || {
      echo "usage: antlers init <template>" >&2
      exit 1
    }
    exec nix flake init -t "$REF#$tmpl"
    ;;
  build)
    pkg="${1:-default}"
    shift || true
    exec nix build "$REF#$pkg" "$@"
    ;;
  run)
    pkg="${1:-default}"
    shift || true
    exec nix run "$REF#$pkg" -- "$@"
    ;;
  shell | develop)
    exec nix develop "$REF" "$@"
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    echo "antlers: unknown command '$cmd'" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac
