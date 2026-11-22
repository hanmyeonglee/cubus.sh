# AGENTS.md

Repository rules for `cubus.sh`, the Cloudflare Tunnel and `nginx-proxy` routing stack for `cubus.sh` and its subdomains.

## Architecture Boundary

- **Parent (`cubus.sh`) owns connection wiring only:** subdomain mapping (`VIRTUAL_HOST`, `VIRTUAL_PORT`), shared Docker networks, proxy config (`config/`), and container log rotation.
- **Submodules own service runtime contracts:** each service defines its `build`, `expose`, `healthcheck`, `env_file`, volumes, and hardware/GPU reservations in its own `compose.service.yml`. Root `docker-compose.yml` consumes services via `extends` only.
- **Root `README.md` stays a minimal hub:** do not duplicate service-specific `.env` variable names, hardware prerequisites, or internal commands in root `README.md`; link to each submodule's `README.md`.

## Working Directories (`.repos/` vs `sites/`)

- **Edit submodule repositories in `.repos/<repo-name>/`**, never directly inside `sites/<slug>/`. Submodule checkouts in `sites/` must stay clean or `./scripts/update-submodules-and-push.sh` will abort.
- **Exception:** `sites/main/` is tracked directly in `cubus.sh` (not a submodule).
- Run `./scripts/setup-repos.sh` to clone all `.gitmodules` repositories into gitignored `.repos/` on initial setup or after adding a submodule.
- **Submodule sync order** (only commit/push when requested):
  1. Commit and push changes in `.repos/<repo-name>/`.
  2. Commit root changes in `cubus.sh`.
  3. Run `./scripts/update-submodules-and-push.sh` to advance `sites/*` pointers and push.

## Compose, Proxy & Security Invariants

- Keep `compose.service.yml` free of host `ports:`, `VIRTUAL_HOST`, `VIRTUAL_PORT`, `restart`, `logging`, and parent network names. Put local loopback ports (`127.0.0.1:...`) in each repo's standalone `docker-compose.yml` extending `compose.service.yml`.
- Inside `compose.service.yml`, use mapping syntax for `build` (`context: .`, `dockerfile: Dockerfile`) and canonical object syntax for `env_file` (`- path: .env`, `required: true`) so relative paths resolve against the submodule directory under `extends`.
- Keep the `tunnel` subnet (`172.30.0.0/24`) in `docker-compose.yml` identical to `set_real_ip_from` in `config/proxy-real-ip.conf`.
- Keep the `web` network `internal: true`. Attach `web-external` only to services that require outbound internet access at runtime.
- Keep `nginx-proxy`'s Docker socket mount read-only (`/var/run/docker.sock:/tmp/docker.sock:ro`). Do not publish host ports on root services (ingress goes through Cloudflare Tunnel). Never commit `.env` files or credentials.
- Pin security-sensitive base images (especially `nginx`) to explicit patch versions rather than floating tags (`stable`, `1.31`). `config/nginx-proxy.Dockerfile` is a temporary rebuild of `nginxproxy/nginx-proxy:1.11.6-alpine` onto patched `nginx:1.31.9-alpine3.24`; switch back to an official `nginxproxy/nginx-proxy` tag once upstream ships `nginx >= 1.31.9`.

## Verification

- Validate edited Compose YAML with `python3 -c 'import yaml, pathlib; yaml.safe_load(pathlib.Path("<file>").read_text())'` and edited shell scripts with `sh -n`.
- Do not assume the `docker` CLI is available in local WSL environments; if unavailable, state clearly that `docker compose config` was not executed locally.

## Repo Skills

- Adding a new subdomain service: follow `.agents/skills/add-subdomain-service/SKILL.md`.
- Removing or deprecating a service: follow `.agents/skills/remove-or-deprecate-service/SKILL.md`.
