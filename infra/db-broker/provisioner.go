package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	servicePrefix               = "svc_"
	maxServiceNameLen           = 59 // len("svc_") + 59 == 63 (PostgreSQL NAMEDATALEN - 1)
	tenantPasswordBytes         = 32
	pgPoolMaxConns              = 4
	advisoryLockTimeout         = 10 * time.Second
	advisoryLockPollInterval    = 50 * time.Millisecond
	advisoryUnlockTimeout       = 3 * time.Second
	connCloseTimeout            = 2 * time.Second
	roleIdleInTxTimeout         = "5min"
	roleTempFileLimit           = "512MB"
	roleIdleInTxConfigEntry     = "idle_in_transaction_session_timeout=" + roleIdleInTxTimeout
	roleTempFileLimitConfigLine = "temp_file_limit=" + roleTempFileLimit
	clusterStatsCacheTTL        = 20 * time.Second
)

var (
	ErrInvalidIdentifier  = errors.New("invalid service name for PostgreSQL identifier")
	ErrIdentifierConflict = errors.New("normalized database identifier collides with another service")
	ErrUnmanagedObject    = errors.New("unmanaged PostgreSQL role or database already exists")
	ErrLockTimeout        = errors.New("timed out waiting for provisioning lock")

	serviceNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,58}$`)
)

type DatabaseCredentials struct {
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	URL      string `json:"url"`
}

func (c DatabaseCredentials) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("database", c.Database),
		slog.String("username", c.Username),
		slog.String("password", "[redacted]"),
		slog.String("host", c.Host),
		slog.Int("port", c.Port),
		slog.String("url", "[redacted]"),
	)
}

func (c DatabaseCredentials) String() string {
	return fmt.Sprintf("DatabaseCredentials{Database:%q Username:%q Host:%q Port:%d}", c.Database, c.Username, c.Host, c.Port)
}

type Provisioner interface {
	Provision(ctx context.Context, serviceName string) (DatabaseCredentials, error)
	Ping(ctx context.Context) error
}

type DatabaseStats struct {
	Name        string     `json:"name"`
	ServiceName *string    `json:"service_name,omitempty"`
	SizeBytes   int64      `json:"size_bytes"`
	Connections int        `json:"connections"`
	CreatedAt   *time.Time `json:"created_at,omitempty"`
}

type ClusterStats struct {
	ServerVersion   string          `json:"server_version"`
	StartedAt       time.Time       `json:"started_at"`
	MaxConnections  int             `json:"max_connections"`
	ClientConns     int             `json:"client_connections"`
	ActiveQueries   int             `json:"active_queries"`
	TotalSizeBytes  int64           `json:"total_size_bytes"`
	Databases       []DatabaseStats `json:"databases"`
	CollectedAt     time.Time       `json:"collected_at"`
}

type StatsProvider interface {
	ClusterStats(ctx context.Context) (ClusterStats, error)
}

// NormalizeIdentifier converts a Compose service name into a safe,
// broker-namespaced PostgreSQL identifier (`svc_<normalized>`, <= 63 bytes).
func NormalizeIdentifier(serviceName string) (string, error) {
	serviceName = strings.TrimSpace(serviceName)
	if len(serviceName) == 0 || len(serviceName) > maxServiceNameLen || !serviceNamePattern.MatchString(serviceName) {
		return "", fmt.Errorf("%w: %q", ErrInvalidIdentifier, serviceName)
	}
	if isReservedServiceName(serviceName) {
		return "", fmt.Errorf("%w: %q", ErrForbiddenCaller, serviceName)
	}
	return servicePrefix + strings.ReplaceAll(serviceName, "-", "_"), nil
}

type credentialRow struct {
	ServiceName  string
	DBIdentifier string
	Password     string
}

type roleState struct {
	Exists          bool
	CanLogin        bool
	Superuser       bool
	CreateDB        bool
	CreateRole      bool
	Inherit         bool
	Replication     bool
	ConnectionLimit int
	Config          []string
}

type dbState struct {
	Exists        bool
	Owner         string
	AllowConn     bool
	PublicRevoked bool
}

// pgSession abstracts single-session SQL operations so reconciliation logic can
// be thoroughly unit-tested without requiring a live PostgreSQL instance.
type pgSession interface {
	Exec(ctx context.Context, sql string, args ...any) error
	GetCredentialByService(ctx context.Context, serviceName string) (credentialRow, bool, error)
	CredentialExistsByIdentifier(ctx context.Context, dbIdent string) (bool, error)
	InsertCredential(ctx context.Context, row credentialRow) error
	GetRoleState(ctx context.Context, roleName string) (roleState, error)
	GetDatabaseState(ctx context.Context, dbName string) (dbState, error)
}

type PGProvisioner struct {
	pool             *pgxpool.Pool
	cfg              Config
	passwordGen      func() (string, error)
	scramVerifierGen func(string) (string, error)

	statsMu       sync.Mutex
	statsCached   ClusterStats
	statsCachedAt time.Time
}

func NewPGProvisioner(ctx context.Context, cfg Config) (*PGProvisioner, error) {
	dsn := buildPostgresURL(cfg.PostgresUser, cfg.PostgresPassword, cfg.PostgresHost, cfg.PostgresPort, cfg.PostgresDB)
	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres config: %w", err)
	}
	poolCfg.MaxConns = pgPoolMaxConns
	poolCfg.MinConns = 0
	poolCfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("create postgres pool: %w", err)
	}

	return &PGProvisioner{
		pool:             pool,
		cfg:              cfg,
		passwordGen:      generateTenantPassword,
		scramVerifierGen: generateSCRAMSHA256,
	}, nil
}

func (p *PGProvisioner) Close() {
	p.pool.Close()
}

func (p *PGProvisioner) Ping(ctx context.Context) error {
	return p.pool.Ping(ctx)
}

// ClusterStats returns cached read-only PostgreSQL cluster and per-database metadata
// for admin observability. It never reads or exposes tenant passwords.
func (p *PGProvisioner) ClusterStats(ctx context.Context) (ClusterStats, error) {
	p.statsMu.Lock()
	if !p.statsCachedAt.IsZero() && time.Since(p.statsCachedAt) < clusterStatsCacheTTL {
		cached := p.statsCached
		cached.Databases = slices.Clone(p.statsCached.Databases)
		p.statsMu.Unlock()
		return cached, nil
	}
	p.statsMu.Unlock()

	tx, err := p.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return ClusterStats{}, fmt.Errorf("begin stats tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = '2s'`); err != nil {
		return ClusterStats{}, fmt.Errorf("set stats timeout: %w", err)
	}

	var out ClusterStats
	if err := tx.QueryRow(ctx, `SHOW server_version`).Scan(&out.ServerVersion); err != nil {
		return ClusterStats{}, fmt.Errorf("query server_version: %w", err)
	}
	if err := tx.QueryRow(ctx, `SELECT pg_postmaster_start_time(), current_setting('max_connections')::int`).Scan(&out.StartedAt, &out.MaxConnections); err != nil {
		return ClusterStats{}, fmt.Errorf("query server info: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE state = 'active')::int
		FROM pg_stat_activity
		WHERE backend_type = 'client backend'
	`).Scan(&out.ClientConns, &out.ActiveQueries); err != nil {
		return ClusterStats{}, fmt.Errorf("query client connections: %w", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT d.datname,
		       c.service_name,
		       pg_database_size(d.datname)::bigint,
		       COALESCE((
		           SELECT COUNT(*)::int
		           FROM pg_stat_activity a
		           WHERE a.datname = d.datname AND a.backend_type = 'client backend'
		       ), 0),
		       c.created_at
		FROM pg_database d
		LEFT JOIN db_broker.credentials c ON c.db_identifier = d.datname
		WHERE NOT d.datistemplate
		ORDER BY d.datname
	`)
	if err != nil {
		return ClusterStats{}, fmt.Errorf("query database sizes: %w", err)
	}
	defer rows.Close()

	dbs := make([]DatabaseStats, 0, 8)
	var totalBytes int64
	for rows.Next() {
		var d DatabaseStats
		if err := rows.Scan(&d.Name, &d.ServiceName, &d.SizeBytes, &d.Connections, &d.CreatedAt); err != nil {
			return ClusterStats{}, fmt.Errorf("scan database stats: %w", err)
		}
		totalBytes += d.SizeBytes
		dbs = append(dbs, d)
	}
	if err := rows.Err(); err != nil {
		return ClusterStats{}, fmt.Errorf("iterate database stats: %w", err)
	}

	out.TotalSizeBytes = totalBytes
	out.Databases = dbs
	out.CollectedAt = time.Now().UTC()

	p.statsMu.Lock()
	p.statsCached = out
	p.statsCached.Databases = slices.Clone(dbs)
	p.statsCachedAt = time.Now()
	p.statsMu.Unlock()

	return out, nil
}

// Bootstrap locks down system databases and initializes the superuser-only
// db_broker.credentials table before the HTTP listener starts.
func (p *PGProvisioner) Bootstrap(ctx context.Context) error {
	statements := []string{
		`REVOKE ALL ON DATABASE postgres FROM PUBLIC`,
		`REVOKE ALL ON DATABASE template1 FROM PUBLIC`,
		`REVOKE ALL ON SCHEMA public FROM PUBLIC`,
		`CREATE SCHEMA IF NOT EXISTS db_broker`,
		`REVOKE ALL ON SCHEMA db_broker FROM PUBLIC`,
		`CREATE TABLE IF NOT EXISTS db_broker.credentials (
			service_name  TEXT PRIMARY KEY,
			db_identifier TEXT NOT NULL UNIQUE,
			password      TEXT NOT NULL,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`REVOKE ALL ON TABLE db_broker.credentials FROM PUBLIC`,
	}

	for _, stmt := range statements {
		if _, err := p.pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("bootstrap statement failed: %w", err)
		}
	}
	return nil
}

func (p *PGProvisioner) Provision(ctx context.Context, serviceName string) (DatabaseCredentials, error) {
	dbIdent, err := NormalizeIdentifier(serviceName)
	if err != nil {
		return DatabaseCredentials{}, err
	}

	conn, err := p.pool.Acquire(ctx)
	if err != nil {
		return DatabaseCredentials{}, fmt.Errorf("acquire postgres connection: %w", err)
	}
	defer conn.Release()

	lockHeld := false
	lockUncertain := false
	defer func() {
		if lockUncertain {
			closeCtx, cancel := context.WithTimeout(context.Background(), connCloseTimeout)
			defer cancel()
			_ = conn.Conn().Close(closeCtx)
			return
		}
		if !lockHeld {
			return
		}
		unlockCtx, cancel := context.WithTimeout(context.Background(), advisoryUnlockTimeout)
		defer cancel()
		var unlocked bool
		if err := conn.QueryRow(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, dbIdent).Scan(&unlocked); err != nil || !unlocked {
			closeCtx, closeCancel := context.WithTimeout(context.Background(), connCloseTimeout)
			defer closeCancel()
			_ = conn.Conn().Close(closeCtx)
		}
	}()

	acquired, uncertain, err := acquireAdvisoryLock(ctx, conn, dbIdent)
	lockHeld = acquired
	lockUncertain = uncertain
	if err != nil {
		return DatabaseCredentials{}, err
	}

	sess := &pgxPoolSession{conn: conn}
	return reconcileService(ctx, sess, p.cfg, serviceName, dbIdent, p.passwordGen, p.scramVerifierGen)
}

func acquireAdvisoryLock(ctx context.Context, conn *pgxpool.Conn, lockKey string) (acquired bool, uncertain bool, err error) {
	lockCtx, cancel := context.WithTimeout(ctx, advisoryLockTimeout)
	defer cancel()

	for {
		var ok bool
		err := conn.QueryRow(lockCtx, `SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, lockKey).Scan(&ok)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				return false, true, ErrLockTimeout
			}
			return false, true, fmt.Errorf("acquire advisory lock: %w", err)
		}
		if ok {
			return true, false, nil
		}

		timer := time.NewTimer(advisoryLockPollInterval)
		select {
		case <-lockCtx.Done():
			timer.Stop()
			if errors.Is(lockCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
				return false, false, ErrLockTimeout
			}
			return false, false, lockCtx.Err()
		case <-timer.C:
		}
	}
}

func reconcileService(
	ctx context.Context,
	sess pgSession,
	cfg Config,
	serviceName string,
	dbIdent string,
	passwordGen func() (string, error),
	scramVerifierGen func(string) (string, error),
) (DatabaseCredentials, error) {
	cred, found, err := sess.GetCredentialByService(ctx, serviceName)
	if err != nil {
		return DatabaseCredentials{}, fmt.Errorf("lookup credentials: %w", err)
	}

	if !found {
		collides, err := sess.CredentialExistsByIdentifier(ctx, dbIdent)
		if err != nil {
			return DatabaseCredentials{}, fmt.Errorf("check identifier collision: %w", err)
		}
		if collides {
			return DatabaseCredentials{}, fmt.Errorf("%w: %s", ErrIdentifierConflict, dbIdent)
		}

		existingRole, err := sess.GetRoleState(ctx, dbIdent)
		if err != nil {
			return DatabaseCredentials{}, fmt.Errorf("check existing role: %w", err)
		}
		existingDB, err := sess.GetDatabaseState(ctx, dbIdent)
		if err != nil {
			return DatabaseCredentials{}, fmt.Errorf("check existing database: %w", err)
		}
		if existingRole.Exists || existingDB.Exists {
			return DatabaseCredentials{}, fmt.Errorf("%w: %s", ErrUnmanagedObject, dbIdent)
		}

		password, err := passwordGen()
		if err != nil {
			return DatabaseCredentials{}, fmt.Errorf("generate tenant password: %w", err)
		}
		cred = credentialRow{
			ServiceName:  serviceName,
			DBIdentifier: dbIdent,
			Password:     password,
		}
		if err := sess.InsertCredential(ctx, cred); err != nil {
			return DatabaseCredentials{}, fmt.Errorf("persist credentials: %w", err)
		}
	}

	identSQL := pgx.Identifier{cred.DBIdentifier}.Sanitize()

	role, err := sess.GetRoleState(ctx, cred.DBIdentifier)
	if err != nil {
		return DatabaseCredentials{}, fmt.Errorf("inspect role state: %w", err)
	}
	if !role.Exists {
		verifier, err := scramVerifierGen(cred.Password)
		if err != nil {
			return DatabaseCredentials{}, fmt.Errorf("compute scram verifier: %w", err)
		}
		if strings.ContainsRune(verifier, '\'') {
			return DatabaseCredentials{}, errors.New("unexpected quote in scram verifier")
		}
		createRoleSQL := fmt.Sprintf(
			`CREATE ROLE %s WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT %d PASSWORD '%s'`,
			identSQL,
			cfg.RoleConnectionLimit,
			verifier,
		)
		if err := sess.Exec(ctx, createRoleSQL); err != nil {
			return DatabaseCredentials{}, fmt.Errorf("create role: %w", err)
		}
		if err := applyRoleGuardrails(ctx, sess, identSQL, nil); err != nil {
			return DatabaseCredentials{}, err
		}
	} else {
		if roleAttributesDrifted(role, cfg.RoleConnectionLimit) {
			alterRoleSQL := fmt.Sprintf(
				`ALTER ROLE %s WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT %d`,
				identSQL,
				cfg.RoleConnectionLimit,
			)
			if err := sess.Exec(ctx, alterRoleSQL); err != nil {
				return DatabaseCredentials{}, fmt.Errorf("reconcile role attributes: %w", err)
			}
		}
		if err := applyRoleGuardrails(ctx, sess, identSQL, role.Config); err != nil {
			return DatabaseCredentials{}, err
		}
	}

	db, err := sess.GetDatabaseState(ctx, cred.DBIdentifier)
	if err != nil {
		return DatabaseCredentials{}, fmt.Errorf("inspect database state: %w", err)
	}
	if !db.Exists {
		// Create closed to non-superusers, lock down PUBLIC privileges, then open.
		// CREATE DATABASE cannot execute inside a transaction block.
		if err := sess.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %s OWNER %s ALLOW_CONNECTIONS false`, identSQL, identSQL)); err != nil {
			return DatabaseCredentials{}, fmt.Errorf("create database: %w", err)
		}
		if err := lockDownAndOpenDatabase(ctx, sess, identSQL); err != nil {
			return DatabaseCredentials{}, err
		}
	} else if db.Owner != cred.DBIdentifier || !db.AllowConn || !db.PublicRevoked {
		if db.Owner != cred.DBIdentifier {
			if err := sess.Exec(ctx, fmt.Sprintf(`ALTER DATABASE %s OWNER TO %s`, identSQL, identSQL)); err != nil {
				return DatabaseCredentials{}, fmt.Errorf("reconcile database owner: %w", err)
			}
		}
		if err := lockDownAndOpenDatabase(ctx, sess, identSQL); err != nil {
			return DatabaseCredentials{}, err
		}
	}

	dsn := buildPostgresURL(cred.DBIdentifier, cred.Password, cfg.PostgresHost, cfg.PostgresPort, cred.DBIdentifier)
	return DatabaseCredentials{
		Database: cred.DBIdentifier,
		Username: cred.DBIdentifier,
		Password: cred.Password,
		Host:     cfg.PostgresHost,
		Port:     cfg.PostgresPort,
		URL:      dsn,
	}, nil
}

func roleAttributesDrifted(r roleState, connLimit int) bool {
	return !r.CanLogin ||
		r.Superuser ||
		r.CreateDB ||
		r.CreateRole ||
		r.Inherit ||
		r.Replication ||
		r.ConnectionLimit != connLimit
}

func applyRoleGuardrails(ctx context.Context, sess pgSession, identSQL string, existingConfig []string) error {
	if !slices.Contains(existingConfig, roleIdleInTxConfigEntry) {
		if err := sess.Exec(ctx, fmt.Sprintf(`ALTER ROLE %s SET idle_in_transaction_session_timeout = '%s'`, identSQL, roleIdleInTxTimeout)); err != nil {
			return fmt.Errorf("set idle_in_transaction_session_timeout: %w", err)
		}
	}
	if !slices.Contains(existingConfig, roleTempFileLimitConfigLine) {
		if err := sess.Exec(ctx, fmt.Sprintf(`ALTER ROLE %s SET temp_file_limit = '%s'`, identSQL, roleTempFileLimit)); err != nil {
			return fmt.Errorf("set temp_file_limit: %w", err)
		}
	}
	return nil
}

func lockDownAndOpenDatabase(ctx context.Context, sess pgSession, identSQL string) error {
	if err := sess.Exec(ctx, fmt.Sprintf(`REVOKE ALL ON DATABASE %s FROM PUBLIC`, identSQL)); err != nil {
		return fmt.Errorf("revoke public database privileges: %w", err)
	}
	if err := sess.Exec(ctx, fmt.Sprintf(`GRANT ALL PRIVILEGES ON DATABASE %s TO %s`, identSQL, identSQL)); err != nil {
		return fmt.Errorf("grant owner database privileges: %w", err)
	}
	if err := sess.Exec(ctx, fmt.Sprintf(`ALTER DATABASE %s ALLOW_CONNECTIONS true`, identSQL)); err != nil {
		return fmt.Errorf("enable database connections: %w", err)
	}
	return nil
}

func generateTenantPassword() (string, error) {
	buf := make([]byte, tenantPasswordBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func buildPostgresURL(username, password, host string, port int, database string) string {
	u := url.URL{
		Scheme:   "postgresql",
		User:     url.UserPassword(username, password),
		Host:     net.JoinHostPort(host, strconv.Itoa(port)),
		Path:     "/" + database,
		RawQuery: "sslmode=disable",
	}
	return u.String()
}

type pgxPoolSession struct {
	conn *pgxpool.Conn
}

func (s *pgxPoolSession) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := s.conn.Exec(ctx, sql, args...)
	return err
}

func (s *pgxPoolSession) GetCredentialByService(ctx context.Context, serviceName string) (credentialRow, bool, error) {
	var row credentialRow
	err := s.conn.QueryRow(
		ctx,
		`SELECT service_name, db_identifier, password FROM db_broker.credentials WHERE service_name = $1`,
		serviceName,
	).Scan(&row.ServiceName, &row.DBIdentifier, &row.Password)
	if errors.Is(err, pgx.ErrNoRows) {
		return credentialRow{}, false, nil
	}
	if err != nil {
		return credentialRow{}, false, err
	}
	return row, true, nil
}

func (s *pgxPoolSession) CredentialExistsByIdentifier(ctx context.Context, dbIdent string) (bool, error) {
	var exists bool
	err := s.conn.QueryRow(
		ctx,
		`SELECT EXISTS (SELECT 1 FROM db_broker.credentials WHERE db_identifier = $1)`,
		dbIdent,
	).Scan(&exists)
	return exists, err
}

func (s *pgxPoolSession) InsertCredential(ctx context.Context, row credentialRow) error {
	_, err := s.conn.Exec(
		ctx,
		`INSERT INTO db_broker.credentials (service_name, db_identifier, password) VALUES ($1, $2, $3)`,
		row.ServiceName,
		row.DBIdentifier,
		row.Password,
	)
	return err
}

func (s *pgxPoolSession) GetRoleState(ctx context.Context, roleName string) (roleState, error) {
	var st roleState
	err := s.conn.QueryRow(
		ctx,
		`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolconnlimit, COALESCE(rolconfig, ARRAY[]::text[])
		 FROM pg_roles
		 WHERE rolname = $1`,
		roleName,
	).Scan(
		&st.CanLogin,
		&st.Superuser,
		&st.CreateDB,
		&st.CreateRole,
		&st.Inherit,
		&st.Replication,
		&st.ConnectionLimit,
		&st.Config,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return roleState{Exists: false}, nil
	}
	if err != nil {
		return roleState{}, err
	}
	st.Exists = true
	return st, nil
}

func (s *pgxPoolSession) GetDatabaseState(ctx context.Context, dbName string) (dbState, error) {
	var st dbState
	err := s.conn.QueryRow(
		ctx,
		`SELECT pg_get_userbyid(datdba),
		        datallowconn,
		        datacl IS NOT NULL
		          AND NOT EXISTS (
		            SELECT 1 FROM unnest(datacl) AS acl
		            WHERE acl::text LIKE '=%'
		          )
		 FROM pg_database
		 WHERE datname = $1`,
		dbName,
	).Scan(&st.Owner, &st.AllowConn, &st.PublicRevoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return dbState{Exists: false}, nil
	}
	if err != nil {
		return dbState{}, err
	}
	st.Exists = true
	return st, nil
}
