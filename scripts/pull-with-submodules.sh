#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
cd "$repo_root"

git -c submodule.recurse=false pull --no-rebase
git submodule sync --recursive
git submodule update --init --recursive
