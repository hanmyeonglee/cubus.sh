package main

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
)

const (
	defaultListenAddr              = ":8080"
	defaultDockerSocket            = "/var/run/docker.sock"
	defaultPostgresHost            = "postgres"
	defaultPostgresPort            = 5432
	defaultPostgresUser            = "postgres"
	defaultPostgresDB              = "postgres"
	defaultRoleConnectionLimit     = 15
	defaultMaxConcurrentProvisions = 4
)

type Config struct {
	ListenAddr              string
	DockerSocket            string
	ComposeProject          string
	DBNetworkName           string
	PostgresHost            string
	PostgresPort            int
	PostgresUser            string
	PostgresDB              string
	PostgresPassword        string
	RoleConnectionLimit     int
	MaxConcurrentProvisions int
}

// LogValue redacts sensitive fields so Config can be logged safely.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("listen_addr", c.ListenAddr),
		slog.String("docker_socket", c.DockerSocket),
		slog.String("compose_project", c.ComposeProject),
		slog.String("db_network_name", c.DBNetworkName),
		slog.String("postgres_host", c.PostgresHost),
		slog.Int("postgres_port", c.PostgresPort),
		slog.String("postgres_user", c.PostgresUser),
		slog.String("postgres_db", c.PostgresDB),
		slog.String("postgres_password", "[redacted]"),
		slog.Int("role_connection_limit", c.RoleConnectionLimit),
		slog.Int("max_concurrent_provisions", c.MaxConcurrentProvisions),
	)
}

func (c Config) String() string {
	return fmt.Sprintf("Config{ListenAddr:%q PostgresHost:%q PostgresPort:%d PostgresUser:%q PostgresDB:%q RoleConnectionLimit:%d MaxConcurrentProvisions:%d}",
		c.ListenAddr, c.PostgresHost, c.PostgresPort, c.PostgresUser, c.PostgresDB, c.RoleConnectionLimit, c.MaxConcurrentProvisions)
}

func loadConfig(getenv func(string) string) (Config, error) {
	cfg := Config{
		ListenAddr:              envOrDefault(getenv, "LISTEN_ADDR", defaultListenAddr),
		DockerSocket:            envOrDefault(getenv, "DOCKER_SOCKET", defaultDockerSocket),
		ComposeProject:          strings.TrimSpace(getenv("COMPOSE_PROJECT")),
		DBNetworkName:           strings.TrimSpace(getenv("DB_NETWORK_NAME")),
		PostgresHost:            envOrDefault(getenv, "POSTGRES_HOST", defaultPostgresHost),
		PostgresPort:            defaultPostgresPort,
		PostgresUser:            envOrDefault(getenv, "POSTGRES_USER", defaultPostgresUser),
		PostgresDB:              envOrDefault(getenv, "POSTGRES_DB", defaultPostgresDB),
		PostgresPassword:        getenv("POSTGRES_PASSWORD"),
		RoleConnectionLimit:     defaultRoleConnectionLimit,
		MaxConcurrentProvisions: defaultMaxConcurrentProvisions,
	}

	if _, port, err := net.SplitHostPort(cfg.ListenAddr); err != nil || port == "" {
		return Config{}, fmt.Errorf("invalid LISTEN_ADDR %q: %w", cfg.ListenAddr, err)
	}

	if rawPort := strings.TrimSpace(getenv("POSTGRES_PORT")); rawPort != "" {
		p, err := strconv.Atoi(rawPort)
		if err != nil || p < 1 || p > 65535 {
			return Config{}, fmt.Errorf("invalid POSTGRES_PORT %q: must be 1..65535", rawPort)
		}
		cfg.PostgresPort = p
	}

	if rawLimit := strings.TrimSpace(getenv("ROLE_CONNECTION_LIMIT")); rawLimit != "" {
		n, err := strconv.Atoi(rawLimit)
		if err != nil || n < 1 || n > 500 {
			return Config{}, fmt.Errorf("invalid ROLE_CONNECTION_LIMIT %q: must be 1..500", rawLimit)
		}
		cfg.RoleConnectionLimit = n
	}

	if rawMax := strings.TrimSpace(getenv("MAX_CONCURRENT_PROVISIONS")); rawMax != "" {
		n, err := strconv.Atoi(rawMax)
		if err != nil || n < 1 || n > 16 {
			return Config{}, fmt.Errorf("invalid MAX_CONCURRENT_PROVISIONS %q: must be 1..16", rawMax)
		}
		cfg.MaxConcurrentProvisions = n
	}

	trimmedPass := strings.TrimSpace(cfg.PostgresPassword)
	if trimmedPass == "" || strings.HasPrefix(strings.ToLower(trimmedPass), "replace-with-") {
		return Config{}, errors.New("POSTGRES_PASSWORD must be set to a real password (not empty or a placeholder)")
	}

	return cfg, nil
}

func envOrDefault(getenv func(string) string, key, fallback string) string {
	if v := strings.TrimSpace(getenv(key)); v != "" {
		return v
	}
	return fallback
}

func healthcheckURL(listenAddr string) (string, error) {
	if strings.TrimSpace(listenAddr) == "" {
		listenAddr = defaultListenAddr
	}
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil || port == "" {
		return "", fmt.Errorf("invalid LISTEN_ADDR %q", listenAddr)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/healthz", nil
}

func LoadConfigFromEnv() (Config, error) {
	return loadConfig(os.Getenv)
}
