package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	dockerClientTimeout = 5 * time.Second
	maxDockerRespBytes  = 4 << 20 // 4 MiB
)

var (
	ErrUnknownCaller   = errors.New("caller container not found on db network")
	ErrForbiddenCaller = errors.New("caller service is not permitted to request a database")
	ErrAmbiguousCaller = errors.New("multiple containers matched caller IP")

	apiVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+$`)

	reservedInfraServices = map[string]struct{}{
		"postgres":    {},
		"db-broker":   {},
		"db_broker":   {},
		"nginx-proxy": {},
		"nginx_proxy": {},
		"cloudflared": {},
	}
)

type IdentityResolver interface {
	ResolveService(ctx context.Context, peerIP netip.Addr) (string, error)
	Ping(ctx context.Context) error
}

type DockerSocketResolver struct {
	client          *http.Client
	selfContainerID string
	apiPrefix       string
	project         string
	dbNetworkName   string
	dbNetworkID     string
}

func NewDockerSocketResolver(socketPath, projectOverride, dbNetworkNameOverride string) *DockerSocketResolver {
	dialer := &net.Dialer{Timeout: dockerClientTimeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socketPath)
		},
		DisableCompression: true,
	}
	hostname, _ := os.Hostname()
	return &DockerSocketResolver{
		client: &http.Client{
			Transport: transport,
			Timeout:   dockerClientTimeout,
		},
		selfContainerID: hostname,
		project:         projectOverride,
		dbNetworkName:   dbNetworkNameOverride,
	}
}

type dockerContainerInspect struct {
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	NetworkSettings struct {
		Networks map[string]dockerNetworkEndpoint `json:"Networks"`
	} `json:"NetworkSettings"`
}

type dockerContainerSummary struct {
	ID              string            `json:"Id"`
	Labels          map[string]string `json:"Labels"`
	NetworkSettings struct {
		Networks map[string]dockerNetworkEndpoint `json:"Networks"`
	} `json:"NetworkSettings"`
}

type dockerNetworkEndpoint struct {
	NetworkID         string `json:"NetworkID"`
	IPAddress         string `json:"IPAddress"`
	GlobalIPv6Address string `json:"GlobalIPv6Address"`
}

// Init negotiates the Docker daemon API version and discovers the Compose
// project and db network ID from db-broker's own container metadata.
func (r *DockerSocketResolver) Init(ctx context.Context) error {
	apiVer, err := r.pingAndVersion(ctx)
	if err != nil {
		return fmt.Errorf("docker ping: %w", err)
	}
	if apiVersionPattern.MatchString(apiVer) {
		r.apiPrefix = "/v" + apiVer
	} else {
		r.apiPrefix = ""
	}

	if err := r.discoverSelf(ctx); err != nil {
		return fmt.Errorf("docker self-discovery: %w", err)
	}
	return nil
}

func (r *DockerSocketResolver) Ping(ctx context.Context) error {
	_, err := r.pingAndVersion(ctx)
	return err
}

func (r *DockerSocketResolver) pingAndVersion(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/_ping", nil)
	if err != nil {
		return "", err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected docker /_ping status %d", resp.StatusCode)
	}
	return strings.TrimSpace(resp.Header.Get("Api-Version")), nil
}

func (r *DockerSocketResolver) discoverSelf(ctx context.Context) error {
	if strings.TrimSpace(r.selfContainerID) == "" {
		return errors.New("cannot determine own container hostname")
	}

	endpoint := fmt.Sprintf("http://docker%s/containers/%s/json", r.apiPrefix, url.PathEscape(r.selfContainerID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDockerRespBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("inspect self container %q returned status %d", r.selfContainerID, resp.StatusCode)
	}

	var inspect dockerContainerInspect
	if err := json.Unmarshal(body, &inspect); err != nil {
		return fmt.Errorf("decode self inspect response: %w", err)
	}

	if r.project == "" {
		r.project = strings.TrimSpace(inspect.Config.Labels["com.docker.compose.project"])
	}
	if r.project == "" {
		return errors.New("com.docker.compose.project label not found; set COMPOSE_PROJECT explicitly")
	}

	nets := inspect.NetworkSettings.Networks
	if len(nets) == 0 {
		return errors.New("db-broker container is not attached to any Docker network")
	}

	if r.dbNetworkName != "" {
		ep, ok := nets[r.dbNetworkName]
		if !ok || ep.NetworkID == "" {
			return fmt.Errorf("configured DB_NETWORK_NAME %q not found on db-broker container", r.dbNetworkName)
		}
		r.dbNetworkID = ep.NetworkID
		return nil
	}

	if len(nets) == 1 {
		for name, ep := range nets {
			if ep.NetworkID == "" {
				return fmt.Errorf("network %q has empty NetworkID", name)
			}
			r.dbNetworkName = name
			r.dbNetworkID = ep.NetworkID
			return nil
		}
	}

	defaultName := r.project + "_db"
	if ep, ok := nets[defaultName]; ok && ep.NetworkID != "" {
		r.dbNetworkName = defaultName
		r.dbNetworkID = ep.NetworkID
		return nil
	}

	return fmt.Errorf("db-broker is attached to %d networks and %q was not found; set DB_NETWORK_NAME explicitly", len(nets), defaultName)
}

func (r *DockerSocketResolver) ResolveService(ctx context.Context, peerIP netip.Addr) (string, error) {
	peerIP = peerIP.Unmap()
	if !peerIP.IsValid() || peerIP.IsUnspecified() || peerIP.IsLinkLocalUnicast() || peerIP.IsLinkLocalMulticast() || peerIP.IsMulticast() {
		return "", ErrUnknownCaller
	}

	filtersMap := map[string][]string{
		"label":   {"com.docker.compose.project=" + r.project},
		"network": {r.dbNetworkID},
		"status":  {"running"},
	}
	filtersJSON, err := json.Marshal(filtersMap)
	if err != nil {
		return "", fmt.Errorf("marshal docker filters: %w", err)
	}

	endpoint := fmt.Sprintf("http://docker%s/containers/json?filters=%s", r.apiPrefix, url.QueryEscape(string(filtersJSON)))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("query docker containers: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDockerRespBytes))
	if err != nil {
		return "", fmt.Errorf("read docker containers response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("docker /containers/json returned status %d", resp.StatusCode)
	}

	var containers []dockerContainerSummary
	if err := json.Unmarshal(body, &containers); err != nil {
		return "", fmt.Errorf("decode docker containers response: %w", err)
	}

	var matches []dockerContainerSummary
	for _, c := range containers {
		if containerMatchesIPOnNetwork(c, r.dbNetworkID, peerIP) {
			matches = append(matches, c)
		}
	}

	switch len(matches) {
	case 0:
		return "", ErrUnknownCaller
	case 1:
	default:
		return "", ErrAmbiguousCaller
	}

	service := strings.TrimSpace(matches[0].Labels["com.docker.compose.service"])
	if service == "" {
		return "", ErrUnknownCaller
	}
	if isReservedServiceName(service) {
		return "", ErrForbiddenCaller
	}
	return service, nil
}

func containerMatchesIPOnNetwork(c dockerContainerSummary, networkID string, peerIP netip.Addr) bool {
	for _, ep := range c.NetworkSettings.Networks {
		if ep.NetworkID != networkID {
			continue
		}
		if matchesParsedIP(ep.IPAddress, peerIP) || matchesParsedIP(ep.GlobalIPv6Address, peerIP) {
			return true
		}
	}
	return false
}

func matchesParsedIP(raw string, target netip.Addr) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	if addr.IsUnspecified() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsMulticast() {
		return false
	}
	return addr == target
}

func isReservedServiceName(service string) bool {
	_, reserved := reservedInfraServices[strings.ToLower(strings.TrimSpace(service))]
	return reserved
}
