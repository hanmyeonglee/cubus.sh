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
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	dockerClientTimeout = 5 * time.Second
	dockerDFTimeout     = 30 * time.Second
	maxDockerRespBytes  = 8 << 20
	statsMaxWorkers     = 4
)

var (
	ErrUnknownPeer    = errors.New("caller container not found on admin network")
	ErrForbiddenPeer  = errors.New("caller service is not permitted")
	ErrAmbiguousPeer  = errors.New("multiple containers matched caller IP")
	ErrServiceUnknown = errors.New("unknown project service")

	apiVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+$`)
)

type DockerHostInfo struct {
	Name            string
	OperatingSystem string
	KernelVersion   string
	NCPU            int
	MemTotal        int64
}

type ContainerInfo struct {
	ID            string  `json:"id"`
	FullID        string  `json:"-"`
	Service       string  `json:"service"`
	Name          string  `json:"name"`
	Image         string  `json:"image"`
	State         string  `json:"state"`
	Status        string  `json:"status"`
	Health        string  `json:"health,omitempty"`
	StartedAt     string  `json:"started_at,omitempty"`
	RestartCount  int     `json:"restart_count"`
	CPUPct        float64 `json:"cpu_pct"`
	MemUsageBytes uint64  `json:"mem_usage_bytes"`
	MemLimitBytes uint64  `json:"mem_limit_bytes"`
	MemPct        float64 `json:"mem_pct"`
	AdminPort     int     `json:"admin_port,omitempty"`
	AdminName     string  `json:"admin_name,omitempty"`
	AdminIP       string  `json:"admin_ip,omitempty"`
	IsTTY         bool    `json:"-"`
}

type AdminServiceTarget struct {
	Service string `json:"service"`
	Name    string `json:"name"`
	AdminIP string `json:"admin_ip"`
	Port    int    `json:"port"`
	State   string `json:"state"`
	Health  string `json:"health,omitempty"`
}

type containerInspectMeta struct {
	Tty          bool
	StartedAt    string
	RestartCount int
	Health       string
	StatusKey    string
}

type prevContainerCPU struct {
	startedAt   string
	totalUsage  uint64
	systemUsage uint64
	valid       bool
}

type DockerBackend interface {
	Ping(ctx context.Context) error
	VerifyAdminPeer(ctx context.Context, peerIP netip.Addr) error
	HostInfo(ctx context.Context) (DockerHostInfo, error)
	Containers() []ContainerInfo
	AdminServices() []AdminServiceTarget
	DiskUsage() *DockerDiskUsage
	OpenContainerLogs(ctx context.Context, containerID string, query url.Values) (io.ReadCloser, error)
	FindServiceContainer(service string) (ContainerInfo, bool)
}

type DockerClient struct {
	client          *http.Client
	dfClient        *http.Client
	streamClient    *http.Client
	selfContainerID string
	apiPrefix       string
	project         string
	adminNetName    string
	adminNetID      string
	adminCIDR       *netip.Prefix
	allowedService  string

	mu            sync.RWMutex
	hostInfo      DockerHostInfo
	hasHostInfo   bool
	containers    []ContainerInfo
	services      []AdminServiceTarget
	dockerDF      *DockerDiskUsage
	inspectCache  map[string]containerInspectMeta
	prevCPUStats  map[string]prevContainerCPU
}

func NewDockerClient(cfg Config) *DockerClient {
	dialer := &net.Dialer{Timeout: dockerClientTimeout}
	mkTransport := func(respHeaderTimeout time.Duration) *http.Transport {
		return &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", cfg.DockerSocket)
			},
			ResponseHeaderTimeout: respHeaderTimeout,
			DisableCompression:    true,
		}
	}
	hostname, _ := os.Hostname()
	return &DockerClient{
		client: &http.Client{
			Transport: mkTransport(dockerClientTimeout),
			Timeout:   dockerClientTimeout,
		},
		dfClient: &http.Client{
			Transport: mkTransport(dockerDFTimeout),
			Timeout:   dockerDFTimeout,
		},
		streamClient: &http.Client{
			Transport: mkTransport(dockerClientTimeout),
			Timeout:   0, // Streaming responses live beyond 5s
		},
		selfContainerID: hostname,
		project:         cfg.ComposeProject,
		adminNetName:    cfg.AdminNetworkName,
		adminCIDR:       cfg.AdminBindCIDR,
		allowedService:  cfg.AllowedService,
		inspectCache:    make(map[string]containerInspectMeta),
		prevCPUStats:    make(map[string]prevContainerCPU),
	}
}

func (d *DockerClient) Init(ctx context.Context) error {
	apiVer, err := d.pingVersion(ctx)
	if err != nil {
		return fmt.Errorf("docker ping: %w", err)
	}
	if apiVersionPattern.MatchString(apiVer) {
		d.apiPrefix = "/v" + apiVer
	}
	if err := d.discoverSelf(ctx); err != nil {
		return fmt.Errorf("docker self-discovery: %w", err)
	}
	_, _ = d.HostInfo(ctx)
	return nil
}

func (d *DockerClient) Ping(ctx context.Context) error {
	_, err := d.pingVersion(ctx)
	return err
}

func (d *DockerClient) pingVersion(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/_ping", nil)
	if err != nil {
		return "", err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("docker /_ping returned %d", resp.StatusCode)
	}
	return strings.TrimSpace(resp.Header.Get("Api-Version")), nil
}

type dockerSelfInspect struct {
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	NetworkSettings struct {
		Networks map[string]dockerNetEndpoint `json:"Networks"`
	} `json:"NetworkSettings"`
}

type dockerNetEndpoint struct {
	NetworkID         string `json:"NetworkID"`
	IPAddress         string `json:"IPAddress"`
	GlobalIPv6Address string `json:"GlobalIPv6Address"`
}

func (d *DockerClient) discoverSelf(ctx context.Context) error {
	if strings.TrimSpace(d.selfContainerID) == "" {
		return errors.New("empty container hostname")
	}
	var self dockerSelfInspect
	if err := d.getJSON(ctx, d.client, fmt.Sprintf("/containers/%s/json", url.PathEscape(d.selfContainerID)), &self); err != nil {
		return err
	}
	if d.project == "" {
		d.project = strings.TrimSpace(self.Config.Labels["com.docker.compose.project"])
	}
	if d.project == "" {
		return errors.New("com.docker.compose.project label missing on ops-agent container")
	}

	// Discover the admin network ID attached to ops-agent.
	for name, ep := range self.NetworkSettings.Networks {
		if d.adminNetName != "" && name == d.adminNetName {
			d.adminNetID = ep.NetworkID
			break
		}
		if d.adminCIDR != nil {
			if ip, err := netip.ParseAddr(strings.TrimSpace(ep.IPAddress)); err == nil && d.adminCIDR.Contains(ip.Unmap()) {
				d.adminNetName = name
				d.adminNetID = ep.NetworkID
				break
			}
		}
		if d.adminNetID == "" && (name == "admin" || strings.HasSuffix(name, "_admin")) {
			d.adminNetName = name
			d.adminNetID = ep.NetworkID
		}
	}
	if d.adminNetID == "" && len(self.NetworkSettings.Networks) == 1 {
		for name, ep := range self.NetworkSettings.Networks {
			d.adminNetName = name
			d.adminNetID = ep.NetworkID
		}
	}
	if d.adminNetID == "" {
		return errors.New("unable to identify admin Docker network on ops-agent container")
	}
	return nil
}

func (d *DockerClient) HostInfo(ctx context.Context) (DockerHostInfo, error) {
	d.mu.RLock()
	if d.hasHostInfo {
		info := d.hostInfo
		d.mu.RUnlock()
		return info, nil
	}
	d.mu.RUnlock()

	var raw struct {
		Name            string `json:"Name"`
		OperatingSystem string `json:"OperatingSystem"`
		KernelVersion   string `json:"KernelVersion"`
		NCPU            int    `json:"NCPU"`
		MemTotal        int64  `json:"MemTotal"`
	}
	if err := d.getJSON(ctx, d.client, "/info", &raw); err != nil {
		return DockerHostInfo{}, err
	}
	info := DockerHostInfo{
		Name:            raw.Name,
		OperatingSystem: raw.OperatingSystem,
		KernelVersion:   raw.KernelVersion,
		NCPU:            raw.NCPU,
		MemTotal:        raw.MemTotal,
	}
	d.mu.Lock()
	d.hostInfo = info
	d.hasHostInfo = true
	d.mu.Unlock()
	return info, nil
}

type dockerListEntry struct {
	ID              string            `json:"Id"`
	Names           []string          `json:"Names"`
	Image           string            `json:"Image"`
	State           string            `json:"State"`
	Status          string            `json:"Status"`
	Labels          map[string]string `json:"Labels"`
	NetworkSettings struct {
		Networks map[string]dockerNetEndpoint `json:"Networks"`
	} `json:"NetworkSettings"`
}

func (d *DockerClient) VerifyAdminPeer(ctx context.Context, peerIP netip.Addr) error {
	if !peerIP.IsValid() {
		return ErrUnknownPeer
	}
	peerIP = peerIP.Unmap()

	filtersJSON, _ := json.Marshal(map[string][]string{
		"label":  {"com.docker.compose.project=" + d.project},
		"status": {"running"},
	})
	var list []dockerListEntry
	if err := d.getJSON(ctx, d.client, "/containers/json?filters="+url.QueryEscape(string(filtersJSON)), &list); err != nil {
		return err
	}

	var matched []dockerListEntry
	for _, c := range list {
		for _, ep := range c.NetworkSettings.Networks {
			if ep.NetworkID != d.adminNetID {
				continue
			}
			if ip, err := netip.ParseAddr(strings.TrimSpace(ep.IPAddress)); err == nil && ip.Unmap() == peerIP {
				matched = append(matched, c)
				break
			}
			if ip6, err := netip.ParseAddr(strings.TrimSpace(ep.GlobalIPv6Address)); err == nil && ip6.Unmap() == peerIP {
				matched = append(matched, c)
				break
			}
		}
	}

	if len(matched) == 0 {
		return ErrUnknownPeer
	}
	if len(matched) > 1 {
		return ErrAmbiguousPeer
	}

	labels := matched[0].Labels
	if strings.EqualFold(strings.TrimSpace(labels["com.docker.compose.oneoff"]), "true") {
		return fmt.Errorf("%w: oneoff container rejected", ErrForbiddenPeer)
	}
	svc := strings.TrimSpace(labels["com.docker.compose.service"])
	if svc != d.allowedService {
		return fmt.Errorf("%w: service %q not allowed", ErrForbiddenPeer, svc)
	}
	return nil
}

// RefreshContainers updates the cached project container snapshot, CPU/RAM stats,
// and discovered cubus.admin.* services. Never reads Config.Env/Cmd/Args.
func (d *DockerClient) RefreshContainers(ctx context.Context) error {
	filtersJSON, _ := json.Marshal(map[string][]string{
		"label": {"com.docker.compose.project=" + d.project},
	})
	var list []dockerListEntry
	if err := d.getJSON(ctx, d.client, "/containers/json?all=1&filters="+url.QueryEscape(string(filtersJSON)), &list); err != nil {
		return err
	}

	out := make([]ContainerInfo, 0, len(list))
	services := make([]AdminServiceTarget, 0)
	liveIDs := make(map[string]struct{}, len(list))

	for _, c := range list {
		if strings.EqualFold(strings.TrimSpace(c.Labels["com.docker.compose.oneoff"]), "true") {
			continue
		}
		liveIDs[c.ID] = struct{}{}
		svc := strings.TrimSpace(c.Labels["com.docker.compose.service"])
		name := svc
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		shortID := c.ID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}

		meta := d.getOrInspectMeta(ctx, c.ID, c.State+"|"+c.Status)
		adminIP := d.extractAdminIP(c.NetworkSettings.Networks)
		adminPort := 0
		if rawPort := strings.TrimSpace(c.Labels["cubus.admin.port"]); rawPort != "" {
			if p, err := strconv.Atoi(rawPort); err == nil && p >= 1 && p <= 65535 {
				adminPort = p
			}
		}
		adminName := strings.TrimSpace(c.Labels["cubus.admin.name"])
		if adminName == "" && adminPort > 0 {
			adminName = svc
		}

		ci := ContainerInfo{
			ID:           shortID,
			FullID:       c.ID,
			Service:      svc,
			Name:         name,
			Image:        c.Image,
			State:        c.State,
			Status:       c.Status,
			Health:       meta.Health,
			StartedAt:    meta.StartedAt,
			RestartCount: meta.RestartCount,
			AdminPort:    adminPort,
			AdminName:    adminName,
			AdminIP:      adminIP,
			IsTTY:        meta.Tty,
		}
		out = append(out, ci)

		if adminPort > 0 && adminIP != "" && svc != "" {
			services = append(services, AdminServiceTarget{
				Service: svc,
				Name:    adminName,
				AdminIP: adminIP,
				Port:    adminPort,
				State:   c.State,
				Health:  meta.Health,
			})
		}
	}

	// Fetch live CPU & memory stats concurrently for running containers only.
	sem := make(chan struct{}, statsMaxWorkers)
	var wg sync.WaitGroup
	for i := range out {
		if out[i].State != "running" {
			continue
		}
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			cpuPct, memUsage, memLimit, memPct := d.collectContainerStats(ctx, out[idx].FullID, out[idx].StartedAt)
			out[idx].CPUPct = cpuPct
			out[idx].MemUsageBytes = memUsage
			out[idx].MemLimitBytes = memLimit
			out[idx].MemPct = memPct
		}(i)
	}
	wg.Wait()

	sort.Slice(out, func(i, j int) bool { return out[i].Service < out[j].Service })
	sort.Slice(services, func(i, j int) bool { return services[i].Service < services[j].Service })

	d.mu.Lock()
	d.containers = out
	d.services = services
	for id := range d.inspectCache {
		if _, ok := liveIDs[id]; !ok {
			delete(d.inspectCache, id)
		}
	}
	for id := range d.prevCPUStats {
		if _, ok := liveIDs[id]; !ok {
			delete(d.prevCPUStats, id)
		}
	}
	d.mu.Unlock()
	return nil
}

func (d *DockerClient) getOrInspectMeta(ctx context.Context, containerID, statusKey string) containerInspectMeta {
	d.mu.RLock()
	cached, ok := d.inspectCache[containerID]
	d.mu.RUnlock()
	if ok && cached.StatusKey == statusKey {
		return cached
	}

	// Decode strictly non-sensitive fields (never Config.Env, Config.Cmd, or Args).
	var raw struct {
		RestartCount int `json:"RestartCount"`
		Config       struct {
			Tty bool `json:"Tty"`
		} `json:"Config"`
		State struct {
			StartedAt string `json:"StartedAt"`
			Health    *struct {
				Status string `json:"Status"`
			} `json:"Health"`
		} `json:"State"`
	}
	if err := d.getJSON(ctx, d.client, fmt.Sprintf("/containers/%s/json", url.PathEscape(containerID)), &raw); err != nil {
		return cached
	}
	health := ""
	if raw.State.Health != nil {
		health = raw.State.Health.Status
	}
	meta := containerInspectMeta{
		Tty:          raw.Config.Tty,
		StartedAt:    raw.State.StartedAt,
		RestartCount: raw.RestartCount,
		Health:       health,
		StatusKey:    statusKey,
	}
	d.mu.Lock()
	d.inspectCache[containerID] = meta
	d.mu.Unlock()
	return meta
}

type dockerStatsPayload struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PerCPUUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

func (d *DockerClient) collectContainerStats(ctx context.Context, containerID, startedAt string) (cpuPct float64, memUsage, memLimit uint64, memPct float64) {
	var st dockerStatsPayload
	path := fmt.Sprintf("/containers/%s/stats?stream=false&one-shot=true", url.PathEscape(containerID))
	if err := d.getJSON(ctx, d.client, path, &st); err != nil {
		return 0, 0, 0, 0
	}

	// Compute memory excluding inactive_file cache (cgroup v2) / cache (cgroup v1).
	memUsage = st.MemoryStats.Usage
	if inactiveFile, ok := st.MemoryStats.Stats["inactive_file"]; ok && memUsage >= inactiveFile {
		memUsage -= inactiveFile
	} else if cache, ok := st.MemoryStats.Stats["cache"]; ok && memUsage >= cache {
		memUsage -= cache
	}
	memLimit = st.MemoryStats.Limit
	if memLimit > 0 {
		memPct = round1(float64(memUsage) / float64(memLimit) * 100.0)
	}

	// Diff consecutive one-shot samples per (containerID, startedAt) to avoid zeroed precpu_stats.
	onlineCPUs := float64(st.CPUStats.OnlineCPUs)
	if onlineCPUs == 0 {
		onlineCPUs = float64(len(st.CPUStats.CPUUsage.PerCPUUsage))
	}
	if onlineCPUs == 0 {
		onlineCPUs = 1
	}

	d.mu.Lock()
	prev := d.prevCPUStats[containerID]
	curr := prevContainerCPU{
		startedAt:   startedAt,
		totalUsage:  st.CPUStats.CPUUsage.TotalUsage,
		systemUsage: st.CPUStats.SystemCPUUsage,
		valid:       true,
	}
	d.prevCPUStats[containerID] = curr
	d.mu.Unlock()

	if prev.valid && prev.startedAt == startedAt {
		cpuPct = computeContainerCPUDiff(prev, curr, onlineCPUs)
	}
	return cpuPct, memUsage, memLimit, memPct
}

func computeContainerCPUDiff(prev, curr prevContainerCPU, onlineCPUs float64) float64 {
	if curr.totalUsage < prev.totalUsage || curr.systemUsage <= prev.systemUsage {
		return 0
	}
	cpuDelta := float64(curr.totalUsage - prev.totalUsage)
	sysDelta := float64(curr.systemUsage - prev.systemUsage)
	if sysDelta <= 0 {
		return 0
	}
	return round1((cpuDelta / sysDelta) * onlineCPUs * 100.0)
}

func (d *DockerClient) RefreshSystemDF(ctx context.Context) error {
	var raw struct {
		Images []struct {
			Size int64 `json:"Size"`
		} `json:"Images"`
		Containers []struct {
			SizeRw int64 `json:"SizeRw"`
		} `json:"Containers"`
		Volumes []struct {
			UsageData struct {
				Size int64 `json:"Size"`
			} `json:"UsageData"`
		} `json:"Volumes"`
		BuildCache []struct {
			Size int64 `json:"Size"`
		} `json:"BuildCache"`
	}
	if err := d.getJSON(ctx, d.dfClient, "/system/df", &raw); err != nil {
		return err
	}

	var imgB, cntB, volB, bcB int64
	for _, im := range raw.Images {
		if im.Size > 0 {
			imgB += im.Size
		}
	}
	for _, c := range raw.Containers {
		if c.SizeRw > 0 {
			cntB += c.SizeRw
		}
	}
	for _, v := range raw.Volumes {
		if v.UsageData.Size > 0 {
			volB += v.UsageData.Size
		}
	}
	for _, b := range raw.BuildCache {
		if b.Size > 0 {
			bcB += b.Size
		}
	}
	df := &DockerDiskUsage{
		ImagesBytes:     imgB,
		ContainersBytes: cntB,
		VolumesBytes:    volB,
		BuildCacheBytes: bcB,
		TotalBytes:      imgB + cntB + volB + bcB,
		CollectedAt:     time.Now().UTC(),
	}
	d.mu.Lock()
	d.dockerDF = df
	d.mu.Unlock()
	return nil
}

func (d *DockerClient) extractAdminIP(nets map[string]dockerNetEndpoint) string {
	for _, ep := range nets {
		if ep.NetworkID != d.adminNetID {
			continue
		}
		ip, err := netip.ParseAddr(strings.TrimSpace(ep.IPAddress))
		if err != nil {
			continue
		}
		ip = ip.Unmap()
		if d.adminCIDR != nil && !d.adminCIDR.Contains(ip) {
			continue
		}
		return ip.String()
	}
	return ""
}

func (d *DockerClient) Containers() []ContainerInfo {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return slices.Clone(d.containers)
}

func (d *DockerClient) AdminServices() []AdminServiceTarget {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return slices.Clone(d.services)
}

func (d *DockerClient) DiskUsage() *DockerDiskUsage {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if d.dockerDF == nil {
		return nil
	}
	cp := *d.dockerDF
	return &cp
}

func (d *DockerClient) FindServiceContainer(service string) (ContainerInfo, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, c := range d.containers {
		if c.Service == service {
			return c, true
		}
	}
	return ContainerInfo{}, false
}

func (d *DockerClient) OpenContainerLogs(ctx context.Context, containerID string, query url.Values) (io.ReadCloser, error) {
	endpoint := fmt.Sprintf("http://docker%s/containers/%s/logs?%s", d.apiPrefix, url.PathEscape(containerID), query.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	client := d.client
	if query.Get("follow") == "1" {
		client = d.streamClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("docker logs returned status %d", resp.StatusCode)
	}
	return resp.Body, nil
}

func (d *DockerClient) getJSON(ctx context.Context, cli *http.Client, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+d.apiPrefix+path, nil)
	if err != nil {
		return err
	}
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDockerRespBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker GET %s returned status %d", path, resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}
