# cubus.sh

Cloudflare Tunnel, `nginx-proxy`, and internal PostgreSQL platform stack for [cubus.sh](https://cubus.sh) and its subdomains.

Each service owns its build, runtime, `.env`, and hardware requirements in its own repository (`compose.service.yml`); this repository provides uniform ingress (`nginx-proxy`) and isolated per-service database allocation (`postgres` + `db-broker`) with a single `docker compose up --build -d`.

## Subdomains

| Host | Service | Source |
| --- | --- | --- |
| `cubus.sh` | `main` | [`sites/main`](sites/main) |
| `simprob.cubus.sh` | `simprobs` | [`sites/simprob`](sites/simprob) ([README](sites/simprob/README.md)) |
| `audown.cubus.sh` | `audown` | [`sites/audown`](sites/audown) ([README](sites/audown/README.md)) |
| `choice.cubus.sh` | `choice` | [`sites/choice`](sites/choice) ([README](sites/choice/README.md)) |

> `skunor-bot` is **deprecated** and has been removed from this repository's submodules and Compose stack.

## Deploy

**Prerequisites:** Docker Engine with Compose (v2.17+), a Cloudflare Tunnel routing each hostname above to `http://nginx-proxy:80`, and any service-specific prerequisites or `.env` files documented in each submodule's README.

```sh
git clone --recurse-submodules https://github.com/hanmyeonglee/cubus.sh.git
cd cubus.sh
cp .env.example .env   # Set TUNNEL_TOKEN and POSTGRES_PASSWORD
# Configure service .env files under sites/* per each submodule's README
docker compose up --build -d
```

## Scripts

Sub-repositories are developed on their own branches under gitignored `.repos/` and deployed via Git submodules under `sites/`.

| Script | Environment | Purpose |
| --- | --- | --- |
| `./scripts/setup-repos.sh` | Local dev (initial setup or after adding a submodule) | Clones all `.gitmodules` repos into `.repos/` on their branches, skipping existing ones. Matches `origin` protocol (SSH/HTTPS); override with `REPOS_PROTOCOL=ssh\|https`. |
| `./scripts/update-submodules-and-push.sh` | Local dev (clean branch with push access) | Advances `sites/*` pointers to remote HEADs, commits, and pushes. Run after pushing changes from `.repos/*`. |
| `./scripts/pull-with-submodules.sh` | Deployment server | Pulls the parent repo and checks out the exact submodule commits pinned by it. |

## Operations Notes

- **Tunnel subnet:** `tunnel` is pinned to `172.30.0.0/24` so `nginx-proxy` trusts `CF-Connecting-IP` only from `cloudflared`. Avoid overlapping host/VPN networks; changing it requires recreating the Compose network.
- **HTTP/3 & IPv6:** Terminated at Cloudflare (enable HTTP/3 and IPv6 Compatibility in Cloudflare settings). Leave `TUNNEL_PROTOCOL=auto` unless outbound UDP/7844 is verified for forced `quic`.
- **Database backup:** `umask 077 && docker compose exec -T postgres pg_dumpall -U postgres > backup.sql` (the dump includes `db_broker.credentials` tenant passwords; protect or encrypt it like `.env`).
- **Superuser password rotation:** Run `ALTER USER postgres WITH PASSWORD '...'` inside `postgres` first, then update `POSTGRES_PASSWORD` in `.env` and recreate `db-broker`.
- **Logs:** Containers use Docker's rotating `local` driver (up to 5 × 10 MB per container); `nginx-proxy` emits JSON access logs.
