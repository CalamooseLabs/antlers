# bash completion for the `antlers` CLI.
#
# Installed to $out/share/bash-completion/completions/antlers, so a NixOS host
# with bash-completion enabled (the default) lazy-loads it the first time you
# type `antlers <TAB>`.
#
# Dynamic candidates (template + package names) are queried straight from the
# flake via the hidden `antlers completions <templates|packages>` helper, so the
# list auto-discovers and never goes stale against a hardcoded copy. Results are
# cached under $XDG_CACHE_HOME/antlers (keyed by ref). The cache is *always*
# served immediately and never blocks: a refresh (`nix eval`, which for a remote
# ref can be slow or hang) runs only in the background, when the cache is missing
# or older than a day — so the shell is never frozen on TAB. The trade-off is
# that the very first completion before any cache exists yields no dynamic names;
# the next one, a moment later, has them. A single-flight lock keeps repeated
# TABs (or an offline host that never populates the cache) from piling up
# duplicate `nix eval` processes.

# shellcheck shell=bash

_antlers_refresh() {
  local key="$1" file="$2" lock="$2.lock" out
  mkdir -p -- "${file%/*}" 2>/dev/null || return 0
  # Clear a lock orphaned by a killed refresh (the fetch is `timeout`-bounded,
  # so a lock older than a minute is dead), then take it — single-flight.
  [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] &&
    rmdir -- "$lock" 2>/dev/null
  mkdir -- "$lock" 2>/dev/null || return 0
  if out=$(timeout 12 antlers completions "$key" 2>/dev/null) && [ -n "$out" ]; then
    printf '%s\n' "$out" >"$file"
  fi
  rmdir -- "$lock" 2>/dev/null || true
}

_antlers_candidates() {
  local key="$1"
  local ref="${ANTLERS_REF:-__DEFAULT_REF__}"
  local dir="${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/antlers"
  local file="$dir/${ref//[^A-Za-z0-9_.-]/_}.$key"

  # Serve whatever is cached right now (possibly nothing) — never blocks.
  [ -f "$file" ] && cat -- "$file"
  # Refresh in the background when the cache is missing/empty or stale.
  if [ ! -s "$file" ] || [ -n "$(find "$file" -mmin +1440 2>/dev/null)" ]; then
    (_antlers_refresh "$key" "$file" &) >/dev/null 2>&1
  fi
}

_antlers() {
  local cur cmd
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  cmd="${COMP_WORDS[1]:-}"

  # First word after `antlers` -> the subcommand.
  if [ "$COMP_CWORD" -eq 1 ]; then
    mapfile -t COMPREPLY < <(compgen -W "list new init build run shell help" -- "$cur")
    return
  fi

  case "$cmd" in
  new | init)
    if [ "$COMP_CWORD" -eq 2 ]; then
      mapfile -t COMPREPLY < <(compgen -W "$(_antlers_candidates templates)" -- "$cur")
    elif [ "$cmd" = new ] && [ "$COMP_CWORD" -eq 3 ]; then
      # `new <template> [dir]` -> let bash complete a target directory.
      compopt -o dirnames 2>/dev/null
    fi
    ;;
  build | run)
    if [ "$COMP_CWORD" -eq 2 ]; then
      mapfile -t COMPREPLY < <(compgen -W "$(_antlers_candidates packages)" -- "$cur")
    fi
    ;;
  esac
}

complete -F _antlers antlers
