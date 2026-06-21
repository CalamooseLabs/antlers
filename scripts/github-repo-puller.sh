# Clone the repos listed in $REPO_MAP into their target folders.
# $REPO_MAP is newline-separated "ref dir", where ref = github:Owner[/Repo]:
#   github:Owner/Repo  -> clones into  dir/Repo
#   github:Owner       -> clones every public repo of Owner into dir/<repo>
# Idempotent: existing clones are fast-forwarded, not re-cloned.
#
# REPO_MAP comes from the env (baked default below); GITHUB_TOKEN is optional.

if [ "$(id -u)" -eq 0 ]; then
  echo "Run github-repo-puller as your user, not root — the clones must be owned by you." >&2
  exit 1
fi

# Host-specific repo map. The NixOS module bakes this via programs.antlers-scripts;
# override at runtime with REPO_MAP (newline-separated "ref dir").
REPO_MAP="${REPO_MAP:-github:CalamooseLab/OpenReturn /home/hub/nkc}"

api="${GITHUB_API:-https://api.github.com}"

auth=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

clone_or_update() {
  url="$1"
  dest="$2"
  if [ -d "$dest/.git" ]; then
    echo "update: $dest"
    git -C "$dest" pull --ff-only || true
  else
    echo "clone:  $url -> $dest"
    mkdir -p "$(dirname "$dest")"
    git clone "$url" "$dest"
  fi
}

while IFS=' ' read -r ref dir; do
  [ -z "$ref" ] && continue
  spec="${ref#github:}"
  owner="${spec%%/*}"
  mkdir -p "$dir"

  if [ "$spec" = "$owner" ]; then
    # owner-only -> every public repo
    page=1
    while true; do
      resp="$(curl -fsSL "${auth[@]}" \
        "$api/users/$owner/repos?per_page=100&page=$page&type=owner")"
      [ "$(jq 'length' <<<"$resp")" -eq 0 ] && break
      while IFS=$'\t' read -r url name; do
        clone_or_update "$url" "$dir/$name"
      done < <(jq -r '.[] | [.clone_url, .name] | @tsv' <<<"$resp")
      page=$((page + 1))
    done
  else
    repo="${spec#*/}"
    clone_or_update "https://github.com/$owner/$repo.git" "$dir/$repo"
  fi
done <<<"$REPO_MAP"
