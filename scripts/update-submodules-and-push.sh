#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
cd "$repo_root"

if [ -z "$(git branch --show-current)" ]; then
  printf '%s\n' 'Run this script from a checkout on a branch, not a detached HEAD.' >&2
  exit 1
fi

if ! git rev-parse --verify '@{upstream}' >/dev/null 2>&1; then
  printf '%s\n' 'The current branch needs an upstream before this script can push.' >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  printf '%s\n' 'Commit or stash tracked changes before updating submodule pointers.' >&2
  exit 1
fi

git submodule foreach --recursive '
  if ! git diff --quiet || ! git diff --cached --quiet; then
    printf "Submodule has tracked changes: %s\\n" "$displaypath" >&2
    exit 1
  fi
'

git submodule sync --recursive
git submodule update --init --remote

if git diff --quiet; then
  printf '%s\n' 'Submodule pointers already match their remote branches.'
  exit 0
fi

git add --update
git commit -m "Update submodule pointers"
git push
