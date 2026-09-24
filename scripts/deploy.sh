#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
cd "$repo_root"

git pull --ff-only --no-recurse-submodules
git submodule sync --recursive
git submodule update --init --recursive

docker compose up --build -d

while IFS=' ' read -r submodule_key site_path; do
  [[ -n "${site_path:-}" ]] || continue
  [[ "$site_path" == sites/* ]] || continue
  case "/$site_path/" in
    */../*)
      printf 'Refusing submodule path outside sites/: %s\n' "$site_path" >&2
      exit 1
      ;;
  esac

  site_dir="$repo_root/$site_path"
  if [[ ! -d "$site_dir" ]]; then
    printf 'Submodule directory is missing: %s\n' "$site_path" >&2
    exit 1
  fi

  compose_file=""
  for candidate in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
    if [[ -f "$site_dir/$candidate" ]]; then
      compose_file="$candidate"
      break
    fi
  done
  if [[ -z "$compose_file" ]]; then
    printf 'No Compose file found in site submodule: %s\n' "$site_path" >&2
    exit 1
  fi

  printf 'Deploying site submodule: %s\n' "$site_path"
  (cd "$site_dir" && docker compose -f "$compose_file" up --build -d)
done < <(git config --file "$repo_root/.gitmodules" --get-regexp '^submodule\..*\.path$' || true)
