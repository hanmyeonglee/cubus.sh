#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
cd "$repo_root"

if [ ! -f .gitmodules ]; then
  printf '%s\n' 'No .gitmodules file found in repository root.' >&2
  exit 1
fi

repos_dir="$repo_root/.repos"
mkdir -p "$repos_dir"

origin_url=$(git remote get-url origin 2>/dev/null || true)
use_ssh=0
case "$origin_url" in
  git@github.com:*|ssh://git@github.com/*)
    use_ssh=1
    ;;
esac

case "${REPOS_PROTOCOL:-}" in
  ssh)
    use_ssh=1
    ;;
  https)
    use_ssh=0
    ;;
  "")
    ;;
  *)
    printf 'Unsupported REPOS_PROTOCOL: %s (expected ssh or https)\n' "$REPOS_PROTOCOL" >&2
    exit 1
    ;;
esac

submodules=$(git config --file .gitmodules --get-regexp '^submodule\..*\.url$')
if [ -z "$submodules" ]; then
  printf '%s\n' 'No submodule URLs found in .gitmodules.'
  exit 0
fi

printf '%s\n' "$submodules" | while IFS=' ' read -r key url; do
  [ -n "$key" ] || continue

  name=${key#submodule.}
  name=${name%.url}
  branch=$(git config --file .gitmodules --get "submodule.$name.branch" 2>/dev/null || true)

  repo_name=${url%/}
  repo_name=${repo_name##*/}
  repo_name=${repo_name%.git}

  clone_url=$url
  if [ "$use_ssh" -eq 1 ]; then
    case "$url" in
      https://github.com/*)
        repo_path=${url#https://github.com/}
        repo_path=${repo_path%/}
        repo_path=${repo_path%.git}
        clone_url="git@github.com:${repo_path}.git"
        ;;
    esac
  fi

  target="$repos_dir/$repo_name"
  if [ -e "$target/.git" ]; then
    printf 'Skipping existing repo: .repos/%s\n' "$repo_name"
    continue
  fi
  if [ -e "$target" ]; then
    printf 'Target exists and is not a git repository: .repos/%s\n' "$repo_name" >&2
    exit 1
  fi

  if [ -n "$branch" ]; then
    git clone --branch "$branch" "$clone_url" "$target"
  else
    git clone "$clone_url" "$target"
  fi
done
