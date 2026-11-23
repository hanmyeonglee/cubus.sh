# AGENTS.md

Repository rules for `cubus.sh`, the Cloudflare Tunnel, `nginx-proxy`, and internal PostgreSQL platform stack for `cubus.sh` and its subdomains.

## Architecture Principles

- **Platform-as-an-Interface (Dependency Inversion):** Root `cubus.sh` provides service-agnostic infrastructure interfaces (`nginx-proxy` + `cloudflared` for ingress; `postgres` + `db-broker` for isolated databases) and should know as little as possible about individual submodules. Never hardcode per-service database lists, per-service DB credentials, or per-service provisioning scripts in root.
- **Single-Command Deployment:** Running `docker compose up --build -d` must bring up the entire stack and automatically serve newly added services with zero manual server-side bootstrap scripts.
- **Parent owns connection wiring & shared platform infra only:** subdomain mapping (`VIRTUAL_HOST`, `VIRTUAL_PORT`), shared Docker networks, proxy config (`config/`), shared internal platform services (`infra/`), and container log rotation.
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

- Keep `compose.service.yml` free of host `ports:`, `VIRTUAL_HOST`, `VIRTUAL_PORT`, `DB_BROKER_URL`, `ADMIN_BIND_CIDR`, `ADMIN_ALLOW_CIDR`, `restart`, `logging`, parent network names, and parent `depends_on:` (`db-broker`, `ops-agent`, `postgres`). Put local loopback ports (`127.0.0.1:...`) and optional local DB containers in each repo's standalone `docker-compose.yml` extending `compose.service.yml`.
- Inside `compose.service.yml`, use mapping syntax for `build` (`context: .`, `dockerfile: Dockerfile`) and canonical object syntax for `env_file` (`- path: .env`, `required: true`) so relative paths resolve against the submodule directory under `extends`.
- Keep the `tunnel` subnet (`172.30.0.0/24`) in `docker-compose.yml` identical to `set_real_ip_from` in `config/proxy-real-ip.conf`.
- Keep `web`, `db`, and `admin` (`172.31.0.0/24`, `ip_range: 172.31.0.128/25`, static `172.31.0.2` for `admin`) networks `internal: true`. Attach `web-external` only to services that require outbound internet access at runtime. Never attach `nginx-proxy` or `cloudflared` to `db` or `admin`. Attach `ops-agent` exclusively to `admin`. Services exposing an internal admin API on `admin` must bind strictly to their `ADMIN_BIND_CIDR` interface IP (never `0.0.0.0`), restrict peers via `ADMIN_ALLOW_CIDR=172.31.0.2/32`, and stay disabled unless explicitly configured.
- **Docker socket TCB:** Mount `/var/run/docker.sock` with `:ro` only on `nginx-proxy`, `db-broker`, and `ops-agent`, treating all three as host-equivalent Trusted Computing Base (TCB)—`:ro` only prevents modifying the socket mount path and does **not** restrict Docker API writes. Never mount `/var/run/docker.sock` on internet-facing app containers such as `admin`. Do not publish host ports on root services, and never commit `.env` files or credentials.
- Pin security-sensitive base images (especially `nginx` and `postgres`) to explicit patch versions rather than floating tags (`stable`, `1.31`, `18`). `config/nginx-proxy.Dockerfile` is a temporary rebuild of `nginxproxy/nginx-proxy:1.11.6-alpine` onto patched `nginx:1.31.9-alpine3.24`; switch back to an official `nginxproxy/nginx-proxy` tag once upstream ships `nginx >= 1.31.9`.

## Internal Database Platform (`postgres` + `db-broker`)

- `db-broker` (`infra/db-broker/`) is stateless and authenticates callers by resolving TCP peer IP via the Docker daemon socket (`com.docker.compose.project` + `db` network ID + `com.docker.compose.service`). Never trust `X-Forwarded-For` or caller-supplied database names.
- Root `.env` holds only `POSTGRES_PASSWORD`. Tenant credentials are stored inside `postgres`'s superuser-only `db_broker.credentials` table (`postgres-data` is the sole DB volume).
- `db-broker` allocates one isolated role and database (`svc_<normalized>`) per Compose service and is strictly create/get-only (never auto-drops databases or roles).
- Root Compose service names are permanent DB identities (renaming provisions a new empty DB and orphans the old one). Cross-service DB sharing is unsupported in `db-broker` v1. Shared PostgreSQL catalog metadata (`pg_database`, `pg_roles`) remains visible across tenants; workloads requiring strict metadata isolation need a dedicated PostgreSQL instance.
- Plaintext traffic on `db` relies on single-host `internal: true` bridge isolation: `NET_RAW`, `NET_ADMIN`, `privileged`, and `network_mode: host`/`service:*` are forbidden on any `db`-attached container.
- For client integration details (HTTP contract, `DB_BROKER_URL` vs `DATABASE_URL` precedence, startup retry helpers, driver caveats), read `.agents/skills/add-subdomain-service/references/db-broker-client.md`.

## Verification

- Validate edited Compose YAML with `python3 -c 'import yaml, pathlib; yaml.safe_load(pathlib.Path("<file>").read_text())'` and edited shell scripts with `sh -n`.
- Validate edits in `infra/db-broker/` and `infra/ops-agent/` with `go vet ./...` and `go test -race ./...`.
- Do not assume the `docker` CLI is available in local WSL environments; if unavailable, state clearly that `docker compose config` was not executed locally.

## Repo Skills

- Adding a new subdomain service: follow `.agents/skills/add-subdomain-service/SKILL.md`.
- Removing or deprecating a service: follow `.agents/skills/remove-or-deprecate-service/SKILL.md`.
