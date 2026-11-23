package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSCRAMSHA256RFC7677Vector(t *testing.T) {
	salt, err := base64.StdEncoding.DecodeString("QSXCR+Q6sek8bf92")
	if err != nil {
		t.Fatalf("decode salt: %v", err)
	}
	got, err := formatSCRAMSHA256("pencil", salt, 4096)
	if err != nil {
		t.Fatalf("formatSCRAMSHA256: %v", err)
	}
	want := "SCRAM-SHA-256$4096:QSXCR+Q6sek8bf92$FO+9jBb3MUukt6jJnzjPZOWc5ow/Pu6JtPyju0aqaE8=:qxJ1SbmSAi5EcS0J5Ck/cKAm/+Ixa+Kwp63f4OHDgzo="
	if got != want {
		t.Fatalf("SCRAM verifier mismatch:\ngot:  %s\nwant: %s", got, want)
	}

	randomVerifier, err := generateSCRAMSHA256("test-secret-value")
	if err != nil {
		t.Fatalf("generateSCRAMSHA256: %v", err)
	}
	if !strings.HasPrefix(randomVerifier, "SCRAM-SHA-256$4096:") {
		t.Fatalf("unexpected verifier prefix: %s", randomVerifier)
	}
	if strings.ContainsRune(randomVerifier, '\'') {
		t.Fatalf("verifier unexpectedly contains single quote: %s", randomVerifier)
	}
}

func TestNormalizeIdentifier(t *testing.T) {
	valid := map[string]string{
		"choice":                        "svc_choice",
		"my-app":                        "svc_my_app",
		"user":                          "svc_user", // PG keyword safely namespaced
		"order":                         "svc_order",
		"a":                             "svc_a",
		strings.Repeat("a", 59):         "svc_" + strings.Repeat("a", 59),
		"notes_api-2":                   "svc_notes_api_2",
	}
	for input, want := range valid {
		got, err := NormalizeIdentifier(input)
		if err != nil {
			t.Errorf("NormalizeIdentifier(%q) unexpected error: %v", input, err)
			continue
		}
		if got != want {
			t.Errorf("NormalizeIdentifier(%q) = %q, want %q", input, got, want)
		}
		if len(got) > 63 {
			t.Errorf("NormalizeIdentifier(%q) exceeded 63 bytes: %d", input, len(got))
		}
	}

	invalid := []struct {
		name    string
		wantErr error
	}{
		{"", ErrInvalidIdentifier},
		{"2fa", ErrInvalidIdentifier},
		{"-bad", ErrInvalidIdentifier},
		{"_bad", ErrInvalidIdentifier},
		{"UpperCase", ErrInvalidIdentifier},
		{"bad.name", ErrInvalidIdentifier},
		{"bad;drop", ErrInvalidIdentifier},
		{strings.Repeat("a", 60), ErrInvalidIdentifier},
		{"postgres", ErrForbiddenCaller},
		{"db-broker", ErrForbiddenCaller},
		{"nginx-proxy", ErrForbiddenCaller},
		{"cloudflared", ErrForbiddenCaller},
	}
	for _, tc := range invalid {
		got, err := NormalizeIdentifier(tc.name)
		if !errors.Is(err, tc.wantErr) {
			t.Errorf("NormalizeIdentifier(%q) = (%q, %v), want error %v", tc.name, got, err, tc.wantErr)
		}
	}
}

func TestConfigValidationAndRedaction(t *testing.T) {
	baseEnv := map[string]string{
		"POSTGRES_PASSWORD": "super-secret-value-123",
	}
	getenv := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}

	cfg, err := loadConfig(getenv(baseEnv))
	if err != nil {
		t.Fatalf("loadConfig valid env failed: %v", err)
	}
	if cfg.RoleConnectionLimit != defaultRoleConnectionLimit || cfg.MaxConcurrentProvisions != defaultMaxConcurrentProvisions {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if strings.Contains(cfg.String(), "super-secret-value-123") {
		t.Fatalf("Config.String() leaked POSTGRES_PASSWORD")
	}
	var logBuf bytes.Buffer
	slog.New(slog.NewJSONHandler(&logBuf, nil)).Info("cfg", "config", cfg)
	if strings.Contains(logBuf.String(), "super-secret-value-123") {
		t.Fatalf("Config.LogValue() leaked POSTGRES_PASSWORD: %s", logBuf.String())
	}

	// Reject empty / placeholder passwords
	for _, badPass := range []string{"", "   ", "replace-with-a-random-postgres-password", "REPLACE-WITH-anything"} {
		m := map[string]string{"POSTGRES_PASSWORD": badPass}
		if _, err := loadConfig(getenv(m)); err == nil {
			t.Errorf("expected loadConfig error for POSTGRES_PASSWORD=%q", badPass)
		}
	}

	// Reject out-of-range limits and ports
	for _, bad := range []map[string]string{
		{"POSTGRES_PASSWORD": "real-password", "POSTGRES_PORT": "0"},
		{"POSTGRES_PASSWORD": "real-password", "POSTGRES_PORT": "70000"},
		{"POSTGRES_PASSWORD": "real-password", "ROLE_CONNECTION_LIMIT": "0"},
		{"POSTGRES_PASSWORD": "real-password", "ROLE_CONNECTION_LIMIT": "501"},
		{"POSTGRES_PASSWORD": "real-password", "MAX_CONCURRENT_PROVISIONS": "0"},
		{"POSTGRES_PASSWORD": "real-password", "MAX_CONCURRENT_PROVISIONS": "17"},
		{"POSTGRES_PASSWORD": "real-password", "LISTEN_ADDR": "not-an-addr"},
	} {
		if _, err := loadConfig(getenv(bad)); err == nil {
			t.Errorf("expected loadConfig error for %v", bad)
		}
	}
}

func TestHealthcheckURLParsing(t *testing.T) {
	cases := map[string]string{
		"":              "http://127.0.0.1:8080/healthz",
		":8080":         "http://127.0.0.1:8080/healthz",
		":9091":         "http://127.0.0.1:9091/healthz",
		"0.0.0.0:9092":  "http://127.0.0.1:9092/healthz",
		"[::]:9093":     "http://127.0.0.1:9093/healthz",
		"127.0.0.1:777": "http://127.0.0.1:777/healthz",
	}
	for input, want := range cases {
		got, err := healthcheckURL(input)
		if err != nil {
			t.Errorf("healthcheckURL(%q) error: %v", input, err)
			continue
		}
		if got != want {
			t.Errorf("healthcheckURL(%q) = %q, want %q", input, got, want)
		}
	}
	if _, err := healthcheckURL("invalid"); err == nil {
		t.Fatal("expected error for invalid LISTEN_ADDR")
	}
}

func TestDockerSocketResolver(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "docker.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	defer ln.Close()

	const (
		selfID      = "broker-container-id"
		dbNetworkID = "net-db-12345"
		webNetID    = "net-web-99999"
	)

	containers := []dockerContainerSummary{
		makeContainer("c1", "cubus", "notes", "", map[string]dockerNetworkEndpoint{
			"cubus_db":  {NetworkID: dbNetworkID, IPAddress: "172.31.0.10"},
			"cubus_web": {NetworkID: webNetID, IPAddress: "172.32.0.10"},
		}),
		makeContainer("c2", "cubus", "notes-v6", "", map[string]dockerNetworkEndpoint{
			"cubus_db": {NetworkID: dbNetworkID, GlobalIPv6Address: "fd00:db::12"},
		}),
		makeContainer("c3", "cubus", "notes", "True", map[string]dockerNetworkEndpoint{
			"cubus_db": {NetworkID: dbNetworkID, IPAddress: "172.31.0.11"},
		}),
		makeContainer("c4", "cubus", "postgres", "", map[string]dockerNetworkEndpoint{
			"cubus_db": {NetworkID: dbNetworkID, IPAddress: "172.31.0.2"},
		}),
		makeContainer("c5", "cubus", "dup-a", "", map[string]dockerNetworkEndpoint{
			"cubus_db": {NetworkID: dbNetworkID, IPAddress: "172.31.0.99"},
		}),
		makeContainer("c6", "cubus", "dup-b", "", map[string]dockerNetworkEndpoint{
			"cubus_db": {NetworkID: dbNetworkID, IPAddress: "172.31.0.99"},
		}),
		makeContainer("c7", "cubus", "web-only", "", map[string]dockerNetworkEndpoint{
			"cubus_web": {NetworkID: webNetID, IPAddress: "172.32.0.50"},
		}),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/_ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Api-Version", "1.47")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	mux.HandleFunc("/v1.47/containers/"+selfID+"/json", func(w http.ResponseWriter, r *http.Request) {
		var resp dockerContainerInspect
		resp.Config.Labels = map[string]string{
			"com.docker.compose.project": "cubus",
			"com.docker.compose.service": "db-broker",
		}
		resp.NetworkSettings.Networks = map[string]dockerNetworkEndpoint{
			"cubus_db": {NetworkID: dbNetworkID, IPAddress: "172.31.0.3"},
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
	mux.HandleFunc("/v1.47/containers/json", func(w http.ResponseWriter, r *http.Request) {
		rawFilters := r.URL.Query().Get("filters")
		var f map[string][]string
		if err := json.Unmarshal([]byte(rawFilters), &f); err != nil {
			http.Error(w, "bad filters", http.StatusBadRequest)
			return
		}
		if !contains(f["label"], "com.docker.compose.project=cubus") || !contains(f["network"], dbNetworkID) || !contains(f["status"], "running") {
			http.Error(w, "unexpected filters", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(containers)
	})

	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	resolver := NewDockerSocketResolver(sockPath, "", "")
	resolver.selfContainerID = selfID
	if err := resolver.Init(context.Background()); err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	if resolver.apiPrefix != "/v1.47" || resolver.project != "cubus" || resolver.dbNetworkID != dbNetworkID {
		t.Fatalf("unexpected auto-discovered state: prefix=%q project=%q netID=%q", resolver.apiPrefix, resolver.project, resolver.dbNetworkID)
	}

	// IPv4 match
	svc, err := resolver.ResolveService(context.Background(), netip.MustParseAddr("172.31.0.10"))
	if err != nil || svc != "notes" {
		t.Fatalf("IPv4 resolve = (%q, %v), want (notes, nil)", svc, err)
	}

	// IPv4-mapped IPv6 match
	svc, err = resolver.ResolveService(context.Background(), netip.MustParseAddr("::ffff:172.31.0.10"))
	if err != nil || svc != "notes" {
		t.Fatalf("IPv4-mapped IPv6 resolve = (%q, %v), want (notes, nil)", svc, err)
	}

	// Pure IPv6 match
	svc, err = resolver.ResolveService(context.Background(), netip.MustParseAddr("fd00:db::12"))
	if err != nil || svc != "notes-v6" {
		t.Fatalf("IPv6 resolve = (%q, %v), want (notes-v6, nil)", svc, err)
	}

	// One-off docker compose run migration container allowed
	svc, err = resolver.ResolveService(context.Background(), netip.MustParseAddr("172.31.0.11"))
	if err != nil || svc != "notes" {
		t.Fatalf("one-off container resolve = (%q, %v), want (notes, nil)", svc, err)
	}

	// Reserved infra service rejected
	if _, err := resolver.ResolveService(context.Background(), netip.MustParseAddr("172.31.0.2")); !errors.Is(err, ErrForbiddenCaller) {
		t.Fatalf("expected ErrForbiddenCaller for postgres, got %v", err)
	}

	// Container on another network rejected
	if _, err := resolver.ResolveService(context.Background(), netip.MustParseAddr("172.32.0.50")); !errors.Is(err, ErrUnknownCaller) {
		t.Fatalf("expected ErrUnknownCaller for non-db network IP, got %v", err)
	}

	// Unknown IP rejected
	if _, err := resolver.ResolveService(context.Background(), netip.MustParseAddr("172.31.0.250")); !errors.Is(err, ErrUnknownCaller) {
		t.Fatalf("expected ErrUnknownCaller for unknown IP, got %v", err)
	}

	// Ambiguous IP rejected
	if _, err := resolver.ResolveService(context.Background(), netip.MustParseAddr("172.31.0.99")); !errors.Is(err, ErrAmbiguousCaller) {
		t.Fatalf("expected ErrAmbiguousCaller, got %v", err)
	}

	// Link-local / unspecified rejected before querying
	for _, badIP := range []string{"0.0.0.0", "::", "fe80::1", "169.254.1.1"} {
		if _, err := resolver.ResolveService(context.Background(), netip.MustParseAddr(badIP)); !errors.Is(err, ErrUnknownCaller) {
			t.Errorf("expected ErrUnknownCaller for %s, got %v", badIP, err)
		}
	}
}

func makeContainer(id, project, service, oneoff string, nets map[string]dockerNetworkEndpoint) dockerContainerSummary {
	var c dockerContainerSummary
	c.ID = id
	c.Labels = map[string]string{
		"com.docker.compose.project": project,
		"com.docker.compose.service": service,
	}
	if oneoff != "" {
		c.Labels["com.docker.compose.oneoff"] = oneoff
	}
	c.NetworkSettings.Networks = nets
	return c
}

func contains(list []string, target string) bool {
	for _, v := range list {
		if v == target {
			return true
		}
	}
	return false
}

// fakePGSession simulates PostgreSQL metadata tables and records executed DDL.
type fakePGSession struct {
	creds map[string]credentialRow
	roles map[string]roleState
	dbs   map[string]dbState
	execs []string
}

func newFakePGSession() *fakePGSession {
	return &fakePGSession{
		creds: make(map[string]credentialRow),
		roles: make(map[string]roleState),
		dbs:   make(map[string]dbState),
	}
}

func (f *fakePGSession) Exec(_ context.Context, sql string, _ ...any) error {
	f.execs = append(f.execs, sql)
	return nil
}

func (f *fakePGSession) GetCredentialByService(_ context.Context, serviceName string) (credentialRow, bool, error) {
	row, ok := f.creds[serviceName]
	return row, ok, nil
}

func (f *fakePGSession) CredentialExistsByIdentifier(_ context.Context, dbIdent string) (bool, error) {
	for _, row := range f.creds {
		if row.DBIdentifier == dbIdent {
			return true, nil
		}
	}
	return false, nil
}

func (f *fakePGSession) InsertCredential(_ context.Context, row credentialRow) error {
	f.creds[row.ServiceName] = row
	return nil
}

func (f *fakePGSession) GetRoleState(_ context.Context, roleName string) (roleState, error) {
	st, ok := f.roles[roleName]
	if !ok {
		return roleState{Exists: false}, nil
	}
	return st, nil
}

func (f *fakePGSession) GetDatabaseState(_ context.Context, dbName string) (dbState, error) {
	st, ok := f.dbs[dbName]
	if !ok {
		return dbState{Exists: false}, nil
	}
	return st, nil
}

func TestReconcileServiceLifecycle(t *testing.T) {
	cfg := Config{
		PostgresHost:        "postgres",
		PostgresPort:        5432,
		RoleConnectionLimit: 15,
	}
	fixedPass := func() (string, error) { return "fixed-tenant-secret-token", nil }
	fixedSCRAM := func(pass string) (string, error) { return "SCRAM-SHA-256$4096:salt$stored:server", nil }

	// 1. Fresh service creation: closed DB -> REVOKE -> GRANT -> open DB, SCRAM verifier (no plaintext password in DDL)
	sess := newFakePGSession()
	creds, err := reconcileService(context.Background(), sess, cfg, "my-app", "svc_my_app", fixedPass, fixedSCRAM)
	if err != nil {
		t.Fatalf("fresh reconcileService failed: %v", err)
	}
	if creds.Database != "svc_my_app" || creds.Username != "svc_my_app" || creds.Password != "fixed-tenant-secret-token" || creds.Port != 5432 {
		t.Fatalf("unexpected credentials: %+v", creds)
	}
	if creds.URL != "postgresql://svc_my_app:fixed-tenant-secret-token@postgres:5432/svc_my_app?sslmode=disable" {
		t.Fatalf("unexpected URL: %s", creds.URL)
	}
	for _, stmt := range sess.execs {
		if strings.Contains(stmt, "fixed-tenant-secret-token") {
			t.Fatalf("plaintext tenant password appeared in SQL DDL: %s", stmt)
		}
	}
	wantOrder := []string{
		`CREATE ROLE "svc_my_app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 15 PASSWORD 'SCRAM-SHA-256$4096:salt$stored:server'`,
		`ALTER ROLE "svc_my_app" SET idle_in_transaction_session_timeout = '5min'`,
		`ALTER ROLE "svc_my_app" SET temp_file_limit = '512MB'`,
		`CREATE DATABASE "svc_my_app" OWNER "svc_my_app" ALLOW_CONNECTIONS false`,
		`REVOKE ALL ON DATABASE "svc_my_app" FROM PUBLIC`,
		`GRANT ALL PRIVILEGES ON DATABASE "svc_my_app" TO "svc_my_app"`,
		`ALTER DATABASE "svc_my_app" ALLOW_CONNECTIONS true`,
	}
	if len(sess.execs) != len(wantOrder) {
		t.Fatalf("got %d DDL statements, want %d:\n%v", len(sess.execs), len(wantOrder), sess.execs)
	}
	for i, want := range wantOrder {
		if sess.execs[i] != want {
			t.Errorf("DDL[%d]:\ngot:  %s\nwant: %s", i, sess.execs[i], want)
		}
	}

	// 2. Steady-state repeat call: zero DDL executed
	sess.execs = nil
	sess.roles["svc_my_app"] = roleState{
		Exists:          true,
		CanLogin:        true,
		ConnectionLimit: 15,
		Config:          []string{roleIdleInTxConfigEntry, roleTempFileLimitConfigLine},
	}
	sess.dbs["svc_my_app"] = dbState{
		Exists:        true,
		Owner:         "svc_my_app",
		AllowConn:     true,
		PublicRevoked: true,
	}
	creds2, err := reconcileService(context.Background(), sess, cfg, "my-app", "svc_my_app", fixedPass, fixedSCRAM)
	if err != nil {
		t.Fatalf("steady-state reconcileService failed: %v", err)
	}
	if creds2.Password != creds.Password {
		t.Fatalf("expected idempotent password on repeat call")
	}
	if len(sess.execs) != 0 {
		t.Fatalf("expected 0 DDL statements on steady-state call, got: %v", sess.execs)
	}

	// 3. Collision: my_app collides with my-app -> 409 ErrIdentifierConflict
	if _, err := reconcileService(context.Background(), sess, cfg, "my_app", "svc_my_app", fixedPass, fixedSCRAM); !errors.Is(err, ErrIdentifierConflict) {
		t.Fatalf("expected ErrIdentifierConflict for my_app vs my-app, got %v", err)
	}

	// 4. Unmanaged pre-existing role/DB rejected with ErrUnmanagedObject (never hijacked)
	unmanagedSess := newFakePGSession()
	unmanagedSess.roles["svc_legacy"] = roleState{Exists: true, CanLogin: true}
	if _, err := reconcileService(context.Background(), unmanagedSess, cfg, "legacy", "svc_legacy", fixedPass, fixedSCRAM); !errors.Is(err, ErrUnmanagedObject) {
		t.Fatalf("expected ErrUnmanagedObject for pre-existing role, got %v", err)
	}
	if len(unmanagedSess.execs) != 0 {
		t.Fatalf("must not execute DDL when unmanaged role exists: %v", unmanagedSess.execs)
	}

	// 5. Crash recovery: credential + role exist, DB created with ALLOW_CONNECTIONS false -> self-heals without touching password
	crashSess := newFakePGSession()
	crashSess.creds["recover"] = credentialRow{ServiceName: "recover", DBIdentifier: "svc_recover", Password: "saved"}
	crashSess.roles["svc_recover"] = roleState{
		Exists:          true,
		CanLogin:        true,
		ConnectionLimit: 10, // drifted connection limit
		Config:          []string{roleIdleInTxConfigEntry, roleTempFileLimitConfigLine},
	}
	crashSess.dbs["svc_recover"] = dbState{
		Exists:        true,
		Owner:         "svc_recover",
		AllowConn:     false,
		PublicRevoked: false,
	}
	if _, err := reconcileService(context.Background(), crashSess, cfg, "recover", "svc_recover", fixedPass, fixedSCRAM); err != nil {
		t.Fatalf("crash recovery reconcileService failed: %v", err)
	}
	for _, stmt := range crashSess.execs {
		if strings.Contains(stmt, "PASSWORD") {
			t.Fatalf("recovery must not rewrite PASSWORD when role exists: %s", stmt)
		}
	}
	if !contains(crashSess.execs, `REVOKE ALL ON DATABASE "svc_recover" FROM PUBLIC`) ||
		!contains(crashSess.execs, `ALTER DATABASE "svc_recover" ALLOW_CONNECTIONS true`) {
		t.Fatalf("expected crash recovery to revoke PUBLIC and re-enable connections, got: %v", crashSess.execs)
	}
}

type mockResolver struct {
	resolveFn func(context.Context, netip.Addr) (string, error)
	pingErr   error
}

func (m *mockResolver) ResolveService(ctx context.Context, ip netip.Addr) (string, error) {
	return m.resolveFn(ctx, ip)
}

func (m *mockResolver) Ping(context.Context) error {
	return m.pingErr
}

type mockProvisioner struct {
	provisionFn func(context.Context, string) (DatabaseCredentials, error)
	pingErr     error
}

func (m *mockProvisioner) Provision(ctx context.Context, svc string) (DatabaseCredentials, error) {
	return m.provisionFn(ctx, svc)
}

func (m *mockProvisioner) Ping(context.Context) error {
	return m.pingErr
}

func TestBrokerHTTPHandlers(t *testing.T) {
	silentLogger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	var capturedPeer netip.Addr

	resolver := &mockResolver{
		resolveFn: func(_ context.Context, ip netip.Addr) (string, error) {
			capturedPeer = ip
			switch ip.String() {
			case "172.31.0.10":
				return "notes", nil
			case "172.31.0.11":
				return "conflict-app", nil
			default:
				return "", ErrUnknownCaller
			}
		},
	}
	provisioner := &mockProvisioner{
		provisionFn: func(_ context.Context, svc string) (DatabaseCredentials, error) {
			if svc == "conflict-app" {
				return DatabaseCredentials{}, ErrIdentifierConflict
			}
			return DatabaseCredentials{
				Database: "svc_" + svc,
				Username: "svc_" + svc,
				Password: "secret-password",
				Host:     "postgres",
				Port:     5432,
				URL:      "postgresql://svc_" + svc + ":secret-password@postgres:5432/svc_" + svc + "?sslmode=disable",
			}, nil
		},
	}

	broker := NewBrokerServer(context.Background(), resolver, provisioner, 2, silentLogger)
	handler := broker.Handler()

	// Happy path + X-Forwarded-For ignored + empty body
	req := httptest.NewRequest(http.MethodPost, "/v1/database", nil)
	req.RemoteAddr = "172.31.0.10:54321"
	req.Header.Set("X-Forwarded-For", "172.31.0.99")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /v1/database status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if capturedPeer.String() != "172.31.0.10" {
		t.Fatalf("peer IP = %s, want 172.31.0.10 (XFF must be ignored)", capturedPeer)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("missing Cache-Control: no-store")
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response JSON: %v", err)
	}
	if resp["database"] != "svc_notes" || resp["port"] != float64(5432) {
		t.Fatalf("unexpected response payload: %v", resp)
	}

	// Empty JSON object `{}` also accepted
	req = httptest.NewRequest(http.MethodPost, "/v1/database", strings.NewReader(" {} \n"))
	req.RemoteAddr = "172.31.0.10:54322"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /v1/database with {} status = %d, want 200", rec.Code)
	}

	// Invalid / non-empty JSON body -> 400
	for _, body := range []string{`{"database":"evil"}`, `not-json`, `[]`, `{}{}`} {
		req = httptest.NewRequest(http.MethodPost, "/v1/database", strings.NewReader(body))
		req.RemoteAddr = "172.31.0.10:54323"
		rec = httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: status = %d, want 400", body, rec.Code)
		}
	}

	// Oversized body -> 413
	req = httptest.NewRequest(http.MethodPost, "/v1/database", strings.NewReader(strings.Repeat(" ", 2048)))
	req.RemoteAddr = "172.31.0.10:54324"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d, want 413", rec.Code)
	}

	// Non-POST -> 405
	req = httptest.NewRequest(http.MethodGet, "/v1/database", nil)
	req.RemoteAddr = "172.31.0.10:54325"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /v1/database status = %d, want 405", rec.Code)
	}

	// Unknown caller -> 403
	req = httptest.NewRequest(http.MethodPost, "/v1/database", nil)
	req.RemoteAddr = "172.31.0.99:54326"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unknown caller status = %d, want 403", rec.Code)
	}

	// Conflict -> 409
	req = httptest.NewRequest(http.MethodPost, "/v1/database", nil)
	req.RemoteAddr = "172.31.0.11:54327"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, want 409", rec.Code)
	}

	// Healthz loopback-only
	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.RemoteAddr = "127.0.0.1:40000"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback /healthz status = %d, want 200", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.RemoteAddr = "172.31.0.10:40001"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-loopback /healthz status = %d, want 403", rec.Code)
	}

	// Healthz fails with 503 when postgres or docker is unhealthy
	provisioner.pingErr = errors.New("db down")
	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.RemoteAddr = "127.0.0.1:40002"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unhealthy postgres /healthz status = %d, want 503", rec.Code)
	}
	provisioner.pingErr = nil
	resolver.pingErr = errors.New("docker down")
	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.RemoteAddr = "127.0.0.1:40003"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unhealthy docker /healthz status = %d, want 503", rec.Code)
	}
}

func TestBrokerConcurrencySemaphoreAndSingleflight(t *testing.T) {
	silentLogger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	release := make(chan struct{})
	started := make(chan struct{}, 4)
	var calls atomic.Int32

	resolver := &mockResolver{
		resolveFn: func(_ context.Context, ip netip.Addr) (string, error) {
			return "app-" + strings.ReplaceAll(ip.String(), ".", "_"), nil
		},
	}
	provisioner := &mockProvisioner{
		provisionFn: func(_ context.Context, svc string) (DatabaseCredentials, error) {
			calls.Add(1)
			started <- struct{}{}
			<-release
			return DatabaseCredentials{Database: "svc_" + svc, Username: "svc_" + svc, Host: "postgres", Port: 5432}, nil
		},
	}

	broker := NewBrokerServer(context.Background(), resolver, provisioner, 1, silentLogger)
	handler := broker.Handler()

	// Two concurrent requests from the SAME peer IP deduplicate via singleflight (1 provisioner call, both get 200).
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range 2 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/v1/database", nil)
			req.RemoteAddr = "172.31.0.10:5000"
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			codes[idx] = rec.Code
		}(i)
	}

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for in-flight provision to start")
	}

	// Meanwhile, a DIFFERENT peer IP hits semaphore saturation (cap=1) -> 503 + Retry-After: 1
	req2 := httptest.NewRequest(http.MethodPost, "/v1/database", nil)
	req2.RemoteAddr = "172.31.0.20:5001"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusServiceUnavailable || rec2.Header().Get("Retry-After") != "1" {
		t.Fatalf("expected 503 with Retry-After=1 on saturation, got %d (Retry-After=%q)", rec2.Code, rec2.Header().Get("Retry-After"))
	}

	close(release)
	wg.Wait()

	if codes[0] != http.StatusOK || codes[1] != http.StatusOK {
		t.Fatalf("expected both singleflight callers to receive 200, got %v", codes)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected singleflight to deduplicate to 1 call, got %d", calls.Load())
	}
}

type mockStatsProvisioner struct {
	mockProvisioner
	statsFn func(context.Context) (ClusterStats, error)
}

func (m *mockStatsProvisioner) ClusterStats(ctx context.Context) (ClusterStats, error) {
	return m.statsFn(ctx)
}

func TestAdminStatsEndpointAndReservedOpsAgent(t *testing.T) {
	if _, err := NormalizeIdentifier("ops-agent"); !errors.Is(err, ErrForbiddenCaller) {
		t.Fatalf("expected ops-agent to be rejected as reserved infra service, got %v", err)
	}

	silentLogger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	resolver := &mockResolver{
		resolveFn: func(_ context.Context, ip netip.Addr) (string, error) {
			switch ip.String() {
			case "172.18.0.2":
				return "admin", nil
			case "172.18.0.3":
				return "artifact", nil
			case "172.18.0.4":
				return "", ErrAmbiguousCaller
			default:
				return "", ErrUnknownCaller
			}
		},
	}

	svcName := "artifact"
	now := time.Now().UTC()
	prov := &mockStatsProvisioner{
		statsFn: func(context.Context) (ClusterStats, error) {
			return ClusterStats{
				ServerVersion:  "18.7",
				StartedAt:      now.Add(-time.Hour),
				MaxConnections: 200,
				ClientConns:    4,
				ActiveQueries:  1,
				TotalSizeBytes: 123456,
				Databases: []DatabaseStats{
					{Name: "postgres", SizeBytes: 10000, Connections: 1},
					{Name: "svc_artifact", ServiceName: &svcName, SizeBytes: 113456, Connections: 3, CreatedAt: &now},
				},
				CollectedAt: now,
			}, nil
		},
	}

	broker := NewBrokerServer(context.Background(), resolver, prov, 2, silentLogger)
	h := broker.Handler()

	// admin caller -> 200 OK with metadata and zero credential fields.
	req := httptest.NewRequest(http.MethodGet, "/v1/admin/stats", nil)
	req.RemoteAddr = "172.18.0.2:40000"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for admin caller, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("missing Cache-Control: no-store")
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), "password") {
		t.Fatalf("unexpected password field in stats response: %s", rec.Body.String())
	}
	var got ClusterStats
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal stats: %v", err)
	}
	if got.ServerVersion != "18.7" || len(got.Databases) != 2 {
		t.Fatalf("unexpected stats payload: %+v", got)
	}

	// Non-admin service (artifact) -> 403 Forbidden.
	req = httptest.NewRequest(http.MethodGet, "/v1/admin/stats", nil)
	req.RemoteAddr = "172.18.0.3:40001"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for artifact caller, got %d", rec.Code)
	}

	// Ambiguous caller -> 403 Forbidden (not 500).
	req = httptest.NewRequest(http.MethodGet, "/v1/admin/stats", nil)
	req.RemoteAddr = "172.18.0.4:40002"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for ambiguous caller, got %d", rec.Code)
	}

	// POST method rejected -> 405.
	req = httptest.NewRequest(http.MethodPost, "/v1/admin/stats", nil)
	req.RemoteAddr = "172.18.0.2:40003"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for POST /v1/admin/stats, got %d", rec.Code)
	}
}
