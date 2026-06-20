{
  pkgs,
  vibe,
}: let
  # ---------------------------------------------------------------------------
  # gcommit — the signed-commit workflow.
  #
  # Commits and tags in this repo are cryptographically *signed* by a human key.
  # An assistant (Claude Code) cannot produce that signature, so it never runs
  # `git commit` itself. Instead it writes the proposed message to the gitignored
  # scratchpad `GIT_COMMIT_MSG`, and a human runs `gcommit` to review, sign, and
  # commit it (and optionally cut a signed tag). See CLAUDE.md.
  # ---------------------------------------------------------------------------
  gcommit = pkgs.writeShellScriptBin "gcommit" ''
    msg_file="GIT_COMMIT_MSG"

    if [[ ! -f "$msg_file" ]] || [[ ! -s "$msg_file" ]]; then
      echo "Error: $msg_file is missing or empty. Nothing to commit." >&2
      exit 1
    fi

    echo ""
    echo "=== Commit message (from $msg_file) ==="
    cat "$msg_file"
    echo "========================================"
    echo ""
    read -r -p "Commit with this message? [y/N] " gc_confirm
    if [[ "$gc_confirm" != "y" && "$gc_confirm" != "Y" ]]; then
      echo "Aborted — $msg_file left unchanged."
      exit 0
    fi

    # -S forces a signature regardless of commit.gpgsign, so a commit through
    # gcommit is always signed (fails loudly if no signing key is configured).
    git commit -S -F "$msg_file"
    gc_exit=$?
    if [[ $gc_exit -ne 0 ]]; then
      echo "Commit failed (exit $gc_exit). $msg_file left unchanged." >&2
      exit $gc_exit
    fi

    echo ""
    read -r -p "Tag this commit? [y/N] " gc_do_tag
    if [[ "$gc_do_tag" == "y" || "$gc_do_tag" == "Y" ]]; then
      read -r -p "Tag name (e.g. v1.2.0): " gc_tag_name
      if [[ -z "$gc_tag_name" ]]; then
        echo "No tag name given — skipping tag."
      else
        read -r -p "Tag annotation (leave blank to reuse commit message): " gc_tag_msg
        if [[ -z "$gc_tag_msg" ]]; then
          git tag -s "$gc_tag_name" -F "$msg_file"
        else
          git tag -s "$gc_tag_name" -m "$gc_tag_msg"
        fi
      fi
    fi

    # Clear the scratchpad so it is not accidentally reused
    > "$msg_file"
    echo ""
    echo "$msg_file cleared. Ready for the next commit."
  '';

  # build-wiki — render docs/ into wiki pages WITHOUT cloning/pushing (preview).
  # Defaults --out to ./wiki-build/ when the caller gives no --out; forwards any
  # extra args. Detects both --out PATH and --out=PATH so the default is never
  # injected as a conflicting second --out.
  build-wiki = pkgs.writeShellScriptBin "build-wiki" ''
    root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
      echo "build-wiki: not inside a git repository" >&2
      exit 1
    }
    has_out=0
    for arg in "$@"; do
      case "$arg" in
        --out | --out=*) has_out=1 ;;
      esac
    done
    if [ "$has_out" -eq 1 ]; then
      python3 "$root/tools/build_wiki.py" "$@"
    else
      python3 "$root/tools/build_wiki.py" --out "$root/wiki-build" "$@"
    fi
  '';

  # publish-wiki — build docs/ into the GitHub wiki repo and push.
  publish-wiki = pkgs.writeShellScriptBin "publish-wiki" ''
    set -euo pipefail
    root="$(git rev-parse --show-toplevel)"
    src="$root/docs"
    builder="$root/tools/build_wiki.py"
    # Wiki repo URL: arg 1 overrides; otherwise <origin> with any trailing slash
    # and a single .git stripped, then .wiki.git appended — correct whether or
    # not origin carried the .git suffix (a naive s/\.git$/…/ would no-op on a
    # .git-less origin and target the MAIN repo).
    if [ -n "''${1:-}" ]; then
      remote="$1"
    else
      origin="$(git -C "$root" remote get-url origin)"
      remote="$(printf '%s' "$origin" | sed -E 's#/+$##; s#\.git$##').wiki.git"
      if [ "$remote" = "$origin" ]; then
        echo "publish-wiki: refusing to run — derived wiki URL equals origin ($origin)" >&2
        exit 1
      fi
    fi

    if [ ! -f "$builder" ]; then
      echo "publish-wiki: builder not found at $builder" >&2
      exit 1
    fi
    if [ ! -d "$src" ] || ! ls "$src"/*.md >/dev/null 2>&1; then
      echo "publish-wiki: no docs pages found in $src" >&2
      exit 1
    fi

    clone="$(mktemp -d)"
    trap 'rm -rf "$clone"' EXIT
    echo "Cloning $remote ..."
    git clone --quiet "$remote" "$clone"

    # Rebuild the flat wiki from docs/: flatten nested pages, rewrite relative
    # links to wiki slugs, regenerate _Sidebar.md/_Footer.md, and validate every
    # internal link + anchor (a broken one aborts here via set -e).
    echo "Building wiki pages from docs/ ..."
    rm -f "$clone"/*.md
    python3 "$builder" --out "$clone"

    cd "$clone"
    git add -A
    if git diff --cached --quiet; then
      echo "Wiki already up to date — nothing to publish."
      exit 0
    fi
    echo "Publishing changes:"
    git diff --cached --stat
    git commit -q -m "Sync wiki from docs/"
    git push
    echo "Published wiki to $remote"
  '';
in
  pkgs.mkShell {
    packages = [
      vibe
      pkgs.git
      pkgs.gh
      pkgs.python3
      gcommit
      build-wiki
      publish-wiki
    ];

    shellHook = ''
      echo "vibe-shell — Claude Code dev environment"
      echo "  vibe          start Claude Code (antlers-pinned: opus[1m], subscription-first)"
      echo "  gcommit       review + sign + commit GIT_COMMIT_MSG (then optional signed tag)"
      echo "  build-wiki    preview docs/ -> ./wiki-build"
      echo "  publish-wiki  publish docs/ -> the repo's GitHub wiki"
    '';
  }
