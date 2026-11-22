---
name: add-subdomain-service
description: >-
  Onboard a new subdomain service into cubus.sh by registering its Git submodule,
  authoring its compose.service.yml contract in .repos/, wiring subdomain routing
  (and optional internal PostgreSQL db-broker access) in root docker-compose.yml
  via extends, and updating root documentation. Use when adding or connecting a
  new site or subdomain to cubus.sh.
---

# Add Subdomain Service

Use this skill when connecting a new repository as a subdomain under `cubus.sh`. Keep all runtime, build, `.env`, and hardware details inside the service repository; root `cubus.sh` should only hold subdomain and platform-interface wiring.

See [compose-service-template.yml](./references/compose-service-template.yml) for the exact YAML contract and [db-broker-client.md](./references/db-broker-client.md) for the `db-broker` HTTP contract, startup client helpers, and driver caveats.

## Steps

### 1. Register the submodule and clone into `.repos/`

1. Add the submodule using its HTTPS GitHub URL (so deployment servers can clone without SSH keys) and explicit branch:
   ```sh
   git submodule add -b main https://github.com/<owner>/<repo>.git sites/<slug>
   ```
2. Run `./scripts/setup-repos.sh` to clone the repository into `.repos/<repo>/` using the parent repo's `origin` protocol.
3. Make all subsequent edits to the service repository inside `.repos/<repo>/`, never inside `sites/<slug>/`.

### 2. Author the service contract in `.repos/<repo>/`

1. Create `.repos/<repo>/compose.service.yml` defining the service's standalone runtime contract:
   - `build` in mapping form (`context: .`, `dockerfile: Dockerfile`)
   - `expose` for the internal container port
   - `healthcheck` appropriate for the container's installed tools
   - Optional `env_file` in canonical form (`- path: .env`, `required: true`), `volumes`, or `deploy` GPU reservations
   - Do **not** include host `ports:`, `VIRTUAL_HOST`, `VIRTUAL_PORT`, `DB_BROKER_URL`, `ADMIN_BIND_CIDR`, `restart`, `logging`, parent `networks:`, or parent `depends_on:` (`db-broker`, `postgres`).
2. Create or update `.repos/<repo>/docker-compose.yml` to extend `compose.service.yml` and publish loopback-only `ports: ["127.0.0.1:<local-port>:<container-port>"]` for local runs (plus an optional local `postgres:18.7-alpine3.24` container mounted at `/var/lib/postgresql` if the service uses PostgreSQL).
3. Verify the service's `Dockerfile` pins security-sensitive base images (such as `nginx` or `postgres`) to explicit patch versions.
4. Ensure `.repos/<repo>/README.md` documents any required `.env` keys and prerequisites so root `README.md` can simply link to it.

### 3. Wire subdomain routing (and optional DB interface) in `cubus.sh`

1. Add a minimal service entry in root `docker-compose.yml`:
   - `extends` pointing to `./sites/<slug>/compose.service.yml`
   - `restart: unless-stopped`
   - `environment` with `VIRTUAL_HOST` and `VIRTUAL_PORT`
   - `logging: *default-logging`
   - `networks: [web]` — add `web-external` **only** if the container needs outbound internet access at runtime
2. **If the service requires PostgreSQL:**
   - Choose a permanent Compose service name matching `^[a-z][a-z0-9_-]{0,58}$` (hyphens normalize to `_`, prefixed with `svc_`; renaming later creates a new empty DB and orphans the old one).
   - Add `db` to `networks:`, add `DB_BROKER_URL: "http://db-broker:8080/v1/database"` to `environment:`, and add:
     ```yaml
     depends_on:
       db-broker:
         condition: service_healthy
     ```
     Do **not** add `restart: true` on `depends_on: db-broker` so `db-broker` updates do not restart running app containers.
   - Never grant `NET_RAW`, `NET_ADMIN`, `privileged`, or `network_mode: host`/`service:*` to a `db`-attached container.
   - **Submodule client contract:**
     - Prefer `DB_BROKER_URL` when set (production under `cubus.sh`); fall back to `DATABASE_URL` when `DB_BROKER_URL` is unset (standalone local dev).
     - Call `POST $DB_BROKER_URL` with an empty body or `{}` (no token required; identity is verified from peer IP on `db`).
     - Response `200 application/json` (`Cache-Control: no-store`):
       `{"database":"svc_<name>","username":"svc_<name>","password":"...","host":"postgres","port":5432,"url":"postgresql://...?sslmode=disable"}` (`port` is a JSON integer).
     - Error responses are JSON `{"error":"..."}`. Retry network errors and HTTP `429`/`503` (honoring `Retry-After`) with bounded exponential backoff + jitter; fail fast on `403`/`409`.
     - **Driver caveat:** SQLAlchemy + `asyncpg` rejects `?sslmode=disable` in URLs; construct the DSN from `{host, port, database, username, password}` (or strip `sslmode`).
     - Trusted PostgreSQL extensions (`pg_trgm`, `citext`, `pgcrypto`, `uuid-ossp`, etc.) can be installed directly by the service role inside its own database (`CREATE EXTENSION IF NOT EXISTS ...`).
3. If the service exposes an optional internal admin API for `admin.cubus.sh`, attach the `admin` network and pass `ADMIN_BIND_CIDR: "172.31.0.0/24"` in root `docker-compose.yml` (never bind the admin listener to `0.0.0.0`, and never attach `nginx-proxy` or `cloudflared` to `admin`).
4. If the service needs custom nginx proxy directives (for example, an extended `proxy_read_timeout` or `client_max_body_size`), add `config/vhost.d/<hostname>_location`.
5. Add a single row to the **Subdomains** table in root `README.md` linking to `sites/<slug>` and `sites/<slug>/README.md`. Do not copy internal `.env` variable names or setup details into root `README.md`.

### 4. Verify

1. Validate YAML syntax of `.repos/<repo>/compose.service.yml`, `.repos/<repo>/docker-compose.yml`, and root `docker-compose.yml`:
   ```sh
   python3 -c 'import yaml, pathlib
   for p in ["docker-compose.yml", ".repos/<repo>/compose.service.yml", ".repos/<repo>/docker-compose.yml"]:
       data = yaml.safe_load(pathlib.Path(p).read_text())
       assert "services" in data, p
       print("OK:", p, list(data["services"]))'
   ```
2. Run `./scripts/setup-repos.sh` and confirm `.repos/<repo>` is detected and skipped cleanly.
3. Confirm `sites/` submodules have no local edits (`git submodule foreach git status --short`).
4. Remind the user of the remaining external/release steps:
   - Push `.repos/<repo>/` first, commit root `cubus.sh`, then run `./scripts/update-submodules-and-push.sh` so `sites/<slug>/compose.service.yml` is checked out at the new commit.
   - Add the Cloudflare Tunnel public hostname route `<hostname>` -> `http://nginx-proxy:80`.
