---
name: remove-or-deprecate-service
description: >-
  Cleanly remove a submodule service from cubus.sh (git submodule, root compose,
  vhost config, and README), optionally mark its standalone repository under
  .repos/ as deprecated, and document safe PostgreSQL retention or manual purge.
  Use when retiring, removing, or deprecating a site or service from cubus.sh.
---

# Remove or Deprecate Service

Use this skill when removing a submodule service from `cubus.sh` or retiring it as deprecated.

## Steps

### 1. Pre-flight check for local secrets or uncommitted work

1. Check `sites/<slug>/` for ignored or untracked files (especially `.env` or local data) before removing it:
   ```sh
   git -C sites/<slug> status --ignored -s
   ```
   If any local secret or data file exists, stop and ask the user before deleting it.
2. Check `.repos/<repo>/` for uncommitted changes (`git -C .repos/<repo> status -s`) so local work is not missed.

### 2. Remove the submodule cleanly from `cubus.sh`

1. Unregister and remove the submodule:
   ```sh
   git submodule deinit -f sites/<slug>
   git rm -f sites/<slug>
   ```
2. Inspect `.git/modules/sites/` and `.git/config` to remove any leftover module directory (historical renames can leave a directory name that differs from `<slug>`):
   ```sh
   ls -la .git/modules/sites/
   rm -rf .git/modules/sites/<matching-module-dir>
   grep -n "<slug>" .git/config || true
   ```

### 3. Clean up root routing and infrastructure

1. Remove the service block from root `docker-compose.yml`.
2. Remove any top-level `networks:` or `volumes:` entries in root `docker-compose.yml` that were used exclusively by this service. **Always keep shared platform resources:** `tunnel`, `web`, `db`, `admin`, and `postgres-data` (even if no active subdomain currently uses `db` or `admin`).
3. Remove any host-specific proxy override files under `config/vhost.d/<hostname>*`.

### 4. Update documentation

1. If the service is being deprecated, add a prominent deprecation banner at the top of `.repos/<repo>/README.md`:
   ```markdown
   > [!WARNING]
   > **Deprecated:** This repository is no longer maintained and has been removed from `cubus.sh`.
   ```
   (Match the language of that repository's existing `README.md`.)
2. Remove the service row from the **Subdomains** table in root `README.md`, and add or update a concise one-line deprecation note if requested.

### 5. Database retention & optional manual cleanup

- **Default policy:** `db-broker` never auto-drops databases or roles; the retired service's PostgreSQL database (`svc_<normalized>`) is preserved by default.
- If the user explicitly wants to purge the retired service's database on the server, follow this exact order (never delete `db_broker.credentials` before removing the running container, or it will re-provision on restart):
  1. Deploy the updated `docker-compose.yml` without the service so no container can reconnect:
     ```sh
     docker compose up -d --remove-orphans
     ```
  2. Take a final backup:
     ```sh
     umask 077 && docker compose exec -T postgres pg_dump -U postgres -Fc "svc_<normalized>" > svc_<normalized>.dump
     ```
  3. Drop the database, role, and broker credential row:
     ```sh
     docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
     DROP DATABASE IF EXISTS "svc_<normalized>" WITH (FORCE);
     DROP ROLE IF EXISTS "svc_<normalized>";
     DELETE FROM db_broker.credentials WHERE service_name = '<service>';
     SQL
     ```

### 6. Verify

1. Validate root `docker-compose.yml` YAML syntax and confirm no dangling references remain:
   ```sh
   python3 -c 'import yaml, pathlib; d = yaml.safe_load(pathlib.Path("docker-compose.yml").read_text()); print("OK:", list(d["services"]), list(d.get("networks", {})), list(d.get("volumes", {})))'
   grep -rn "<slug>\|<service>" .gitmodules docker-compose.yml config/ || true
   ```
2. Run `git submodule status` and `./scripts/setup-repos.sh` to verify the removed repository is no longer listed or synced.
3. Remind the user to remove the retired hostname route in Cloudflare Tunnel if the service had public ingress.
