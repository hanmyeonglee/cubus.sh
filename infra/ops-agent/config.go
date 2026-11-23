package main

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAdminPort       = 9091
	defaultDockerSocket    = "/var/run/docker.sock"
	defaultAllowedService  = "admin"
	defaultSampleInterval  = 5 * time.Second
	defaultRingCapacity    = 720 // 720 * 5s = 1 hour
	defaultHostOSRelease   = "/host/etc/os-release"
	defaultMaxSearchConcur = 4
	defaultMaxStreamConcur = 8
)

type Config struct {
	AdminPort         int
	AdminBindCIDR     *netip.Prefix
	DockerSocket      string
	ComposeProject    string
	AdminNetworkName  string
	AllowedService    string
	SampleInterval    time.Duration
	RingCapacity      int
	HostOSReleasePath string
	DevLoopbackToken  string
}

func (c Config) LogValue() slog.Value {
	bind := "127.0.0.1"
	if c.AdminBindCIDR != nil {
		bind = c.AdminBindCIDR.String()
	}
	return slog.GroupValue(
		slog.Int("admin_port", c.AdminPort),
		slog.String("admin_bind_cidr", bind),
		slog.String("docker_socket", c.DockerSocket),
		slog.String("compose_project", c.ComposeProject),
		slog.String("allowed_service", c.AllowedService),
		slog.Duration("sample_interval", c.SampleInterval),
		slog.Int("ring_capacity", c.RingCapacity),
		slog.Bool("dev_loopback_token_set", c.DevLoopbackToken != ""),
	)
}

func LoadConfigFromEnv() (Config, error) {
	return loadConfig(os.Getenv)
}

func loadConfig(getenv func(string) string) (Config, error) {
	cfg := Config{
		AdminPort:         defaultAdminPort,
		DockerSocket:      envOrDefault(getenv, "DOCKER_SOCKET", defaultDockerSocket),
		ComposeProject:    strings.TrimSpace(getenv("COMPOSE_PROJECT")),
		AdminNetworkName:  strings.TrimSpace(getenv("ADMIN_NETWORK_NAME")),
		AllowedService:    envOrDefault(getenv, "ALLOWED_SERVICE", defaultAllowedService),
		SampleInterval:    defaultSampleInterval,
		RingCapacity:      defaultRingCapacity,
		HostOSReleasePath: envOrDefault(getenv, "HOST_OS_RELEASE_PATH", defaultHostOSRelease),
		DevLoopbackToken:  strings.TrimSpace(getenv("DEV_LOOPBACK_TOKEN")),
	}

	if rawPort := strings.TrimSpace(getenv("ADMIN_PORT")); rawPort != "" {
		p, err := strconv.Atoi(rawPort)
		if err != nil || p < 1 || p > 65535 {
			return Config{}, fmt.Errorf("invalid ADMIN_PORT %q: must be 1..65535", rawPort)
		}
		cfg.AdminPort = p
	}

	if rawCIDR := strings.TrimSpace(getenv("ADMIN_BIND_CIDR")); rawCIDR != "" {
		pfx, err := netip.ParsePrefix(rawCIDR)
		if err != nil {
			return Config{}, fmt.Errorf("invalid ADMIN_BIND_CIDR %q: %w", rawCIDR, err)
		}
		if pfx.Bits() == 0 {
			return Config{}, fmt.Errorf("ADMIN_BIND_CIDR %q must not be /0", rawCIDR)
		}
		pfx = pfx.Masked()
		cfg.AdminBindCIDR = &pfx
	}

	if cfg.AdminBindCIDR != nil && cfg.DevLoopbackToken != "" {
		return Config{}, errors.New("DEV_LOOPBACK_TOKEN cannot be set when ADMIN_BIND_CIDR is configured")
	}

	if rawInterval := strings.TrimSpace(getenv("SAMPLE_INTERVAL")); rawInterval != "" {
		d, err := time.ParseDuration(rawInterval)
		if err != nil || d < time.Second || d > time.Minute {
			return Config{}, fmt.Errorf("invalid SAMPLE_INTERVAL %q: must be 1s..60s", rawInterval)
		}
		cfg.SampleInterval = d
	}

	if rawCap := strings.TrimSpace(getenv("RING_CAPACITY")); rawCap != "" {
		n, err := strconv.Atoi(rawCap)
		if err != nil || n < 10 || n > 3600 {
			return Config{}, fmt.Errorf("invalid RING_CAPACITY %q: must be 10..3600", rawCap)
		}
		cfg.RingCapacity = n
	}

	return cfg, nil
}

// ResolveAdminBindAddr returns the interface IP inside allowCIDR (never 0.0.0.0)
// or 127.0.0.1 when allowCIDR is nil.
func ResolveAdminBindAddr(allowCIDR *netip.Prefix, port int) (string, error) {
	if allowCIDR == nil {
		return net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), nil
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "", fmt.Errorf("list interface addresses: %w", err)
	}
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		addr, ok := netip.AddrFromSlice(ipNet.IP)
		if !ok {
			continue
		}
		addr = addr.Unmap()
		if allowCIDR.Contains(addr) {
			return net.JoinHostPort(addr.String(), strconv.Itoa(port)), nil
		}
	}
	return "", fmt.Errorf("no local interface IP found inside ADMIN_BIND_CIDR %s", allowCIDR.String())
}

func healthcheckURL(port int) string {
	if port < 1 || port > 65535 {
		port = defaultAdminPort
	}
	return "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) + "/healthz"
}

func envOrDefault(getenv func(string) string, key, fallback string) string {
	if v := strings.TrimSpace(getenv(key)); v != "" {
		return v
	}
	return fallback
}
