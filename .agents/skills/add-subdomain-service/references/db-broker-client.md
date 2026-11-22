# Internal PostgreSQL (`db-broker`) Client Guide for Submodule Services

Reference for AI agents implementing or integrating a service that uses `cubus.sh`'s shared internal PostgreSQL platform (`postgres:18.7-alpine3.24` + stateless `db-broker`).

## 1. Environment Precedence Contract

Every DB-backed submodule must stay runnable standalone (without `cubus.sh`):

1. **Production under `cubus.sh` (`DB_BROKER_URL` is set):** Fetch database credentials at startup via `POST $DB_BROKER_URL`.
2. **Standalone local dev (`DB_BROKER_URL` is unset):** Read `DATABASE_URL` directly (for example, pointing to a local `postgres:18.7-alpine3.24` container in `.repos/<repo>/docker-compose.yml`).

Never put `DB_BROKER_URL` or parent `depends_on:` (`db-broker`, `postgres`) inside a submodule's `compose.service.yml`. Root `docker-compose.yml` injects them.

## 2. HTTP API Contract (`POST /v1/database`)

- **Endpoint:** `POST http://db-broker:8080/v1/database` (passed via `DB_BROKER_URL`)
- **Authentication:** None in headers or body. `db-broker` resolves the caller's TCP peer IP on the `db` (`internal: true`) network against Docker metadata (`com.docker.compose.project` + `db` network ID + `com.docker.compose.service`). `X-Forwarded-For` is ignored.
- **Request body:** Empty or `{}` (max 1 KiB; non-empty fields or malformed JSON return `400`; >1 KiB returns `413`).
- **One-off containers:** `docker compose run --rm <service> ...` containers inherit the service's labels on `db` and are permitted to fetch credentials (e.g., for migrations).
- **Success (`200 OK`, `Content-Type: application/json`, `Cache-Control: no-store`):**
  ```json
  {
    "database": "svc_my_app",
    "username": "svc_my_app",
    "password": "<43-char-url-safe-secret>",
    "host": "postgres",
    "port": 5432,
    "url": "postgresql://svc_my_app:<secret>@postgres:5432/svc_my_app?sslmode=disable"
  }
  ```
  - `database` and `username` are derived from the root Compose service name (`^[a-z][a-z0-9_-]{0,58}$`, `-` normalized to `_`, prefixed with `svc_`).
  - `port` is a JSON integer (`5432`).
  - Idempotent across restarts and concurrent multi-worker startups (returns the same persisted credentials).
- **Error responses (`application/json`, `{"error":"..."}`):**
  - `400` — Invalid body or invalid service identifier (fail fast).
  - `403` — Caller not on `db` network, wrong Compose project, or reserved infra service (fail fast).
  - `409` — Normalized identifier collides with another service (`my-app` vs `my_app`) or an unmanaged pre-existing PG role/DB (fail fast).
  - `503` (with `Retry-After: 1`) or network error — Transient overload/startup/lock timeout (**retry with bounded exponential backoff + jitter**).
  - `500` — Unexpected internal error (bounded retry or fail with alert).

## 3. Startup Helper Examples

Never log the returned `password` or `url`.

### Python (stdlib)
```python
import json, os, random, time, urllib.error, urllib.request


def resolve_database_config() -> dict:
    broker_url = os.environ.get("DB_BROKER_URL")
    if not broker_url:
        return {"url": os.environ["DATABASE_URL"]}

    req = urllib.request.Request(
        broker_url,
        data=b"{}",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            if exc.code in (400, 403, 409):
                raise
            delay = float(exc.headers.get("Retry-After", 0)) or (0.5 * (2**attempt))
        except urllib.error.URLError:
            delay = 0.5 * (2**attempt)
        if attempt == 4:
            raise
        time.sleep(delay + random.uniform(0, 0.25))
    raise RuntimeError("unreachable")
```

### Go (stdlib)
```go
type brokerDBConfig struct {
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	URL      string `json:"url"`
}

func resolveDatabaseURL(ctx context.Context) (string, error) {
	brokerURL := os.Getenv("DB_BROKER_URL")
	if brokerURL == "" {
		dsn := os.Getenv("DATABASE_URL")
		if dsn == "" {
			return "", errors.New("set DB_BROKER_URL or DATABASE_URL")
		}
		return dsn, nil
	}

	client := &http.Client{Timeout: 10 * time.Second}
	var lastErr error
	for attempt := range 5 {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, brokerURL, strings.NewReader("{}"))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err == nil {
			var cfg brokerDBConfig
			decErr := json.NewDecoder(resp.Body).Decode(&cfg)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK && decErr == nil && cfg.URL != "" {
				return cfg.URL, nil
			}
			if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusConflict {
				return "", fmt.Errorf("db-broker rejected request: status %d", resp.StatusCode)
			}
			lastErr = fmt.Errorf("db-broker status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		if attempt == 4 {
			break
		}
		time.Sleep(time.Duration(500<<attempt) * time.Millisecond)
	}
	return "", lastErr
}
```

### TypeScript / Node.js (`fetch`)
```ts
type BrokerDBConfig = {
  database: string;
  username: string;
  password: string;
  host: string;
  port: number;
  url: string;
};

export async function resolveDatabaseURL(): Promise<string> {
  const brokerUrl = process.env.DB_BROKER_URL;
  if (!brokerUrl) {
    if (!process.env.DATABASE_URL) throw new Error("Set DB_BROKER_URL or DATABASE_URL");
    return process.env.DATABASE_URL;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(brokerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const cfg = (await resp.json()) as BrokerDBConfig;
        return cfg.url;
      }
      if ([400, 403, 409].includes(resp.status)) {
        throw new Error(`db-broker rejected request (${resp.status})`);
      }
      const retryAfter = Number(resp.headers.get("Retry-After") ?? "0");
      lastError = new Error(`db-broker error (${resp.status})`);
      if (attempt < 4) {
        const waitMs = (retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("db-broker rejected")) throw err;
      lastError = err;
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
      }
    }
  }
  throw lastError;
}
```

## 4. PostgreSQL Capabilities, Limits & Driver Caveats

- **Role privileges:** Each service owns its own database (`svc_<normalized>`) and can freely create schemas, tables, indexes, and run migrations, plus install **trusted extensions** (`pg_trgm`, `citext`, `pgcrypto`, `uuid-ossp`, `hstore`, `btree_gin`, etc.) via `CREATE EXTENSION IF NOT EXISTS ...`.
- **Non-trusted extensions** (e.g., `pgvector`) require superuser installation and are not self-service in `db-broker` v1.
- **Role guardrails:** `CONNECTION LIMIT 15` (set your app connection pool size `<= 10`–`12` to leave headroom for migrations/reloads), `idle_in_transaction_session_timeout = '5min'`, `temp_file_limit = '512MB'`.
- **SQLAlchemy + `asyncpg` caveat:** `asyncpg` via SQLAlchemy rejects `?sslmode=disable` in connection URLs. Build `sqlalchemy.engine.URL.create("postgresql+asyncpg", username=..., password=..., host=..., port=..., database=...)` from the structured JSON fields (or strip `sslmode`).
- **Permanent identity:** Root Compose service names map 1:1 to `svc_<normalized>`. Never rename a DB-backed service key without migrating its database.

## 5. Root Compose Wiring (`docker-compose.yml`)

```yaml
  my-app:
    extends:
      file: ./sites/my-app/compose.service.yml
      service: my-app
    restart: unless-stopped
    environment:
      VIRTUAL_HOST: my-app.cubus.sh
      VIRTUAL_PORT: "8000"
      DB_BROKER_URL: http://db-broker:8080/v1/database
    depends_on:
      db-broker:
        condition: service_healthy   # Do NOT set restart: true
    logging: *default-logging
    networks:
      - web
      - db
```

Never grant `NET_RAW`, `NET_ADMIN`, `privileged`, or `network_mode: host`/`service:*` to any `db`-attached container.

## 6. Operator Inspection & Retention Quick Reference

- List allocated databases & broker records:
  ```sh
  docker compose exec postgres psql -U postgres -c '\l'
  docker compose exec postgres psql -U postgres -c 'SELECT service_name, db_identifier, created_at FROM db_broker.credentials;'
  ```
- Backup (contains `db_broker.credentials` plaintext passwords — protect like `.env`):
  ```sh
  umask 077 && docker compose exec -T postgres pg_dumpall -U postgres > backup.sql
  ```
- Databases are never auto-dropped when a service is removed; see `.agents/skills/remove-or-deprecate-service/SKILL.md` for the safe manual purge sequence.
