package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func encodeStdCopyFrame(stream byte, payload string) []byte {
	out := make([]byte, 8+len(payload))
	out[0] = stream
	binary.BigEndian.PutUint32(out[4:8], uint32(len(payload)))
	copy(out[8:], payload)
	return out
}

func TestConfigValidation(t *testing.T) {
	getenv := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}
	if _, err := loadConfig(getenv(map[string]string{"ADMIN_BIND_CIDR": "0.0.0.0/0"})); err == nil {
		t.Fatal("expected error for /0 ADMIN_BIND_CIDR")
	}
	if _, err := loadConfig(getenv(map[string]string{
		"ADMIN_BIND_CIDR":    "172.31.0.0/24",
		"DEV_LOOPBACK_TOKEN": "dev-secret",
	})); err == nil {
		t.Fatal("expected error when DEV_LOOPBACK_TOKEN combined with ADMIN_BIND_CIDR")
	}
	cfg, err := loadConfig(getenv(map[string]string{"ADMIN_BIND_CIDR": "172.31.0.0/24"}))
	if err != nil || cfg.AdminPort != 9091 || cfg.AllowedService != "admin" {
		t.Fatalf("unexpected valid config: %+v err=%v", cfg, err)
	}
}

func TestHostMetricParsersAndRing(t *testing.T) {
	s1, err := parseProcStatLine("cpu  100 0 50 850 0 0 0 0 0 0")
	if err != nil {
		t.Fatal(err)
	}
	s2, err := parseProcStatLine("cpu  200 0 100 1200 0 0 0 0 0 0")
	if err != nil {
		t.Fatal(err)
	}
	// total delta = 500, idle delta = 350 -> 30% busy
	if got := round1(computeCPUDeltaPct(s1, s2)); got != 30.0 {
		t.Fatalf("expected 30.0%% CPU, got %.1f%%", got)
	}

	mem := parseMemInfo("MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n")
	if mem.UsagePct != 75.0 || mem.SwapUsedBytes != 500000*1024 {
		t.Fatalf("unexpected meminfo parse: %+v", mem)
	}

	// NVIDIA CSV tolerating [N/A] / [Not Supported]
	devs := parseNVIDIASMICSV("0, NVIDIA GeForce RTX 4090, GPU-123, 42, 18, 4096, 24564, 58, [N/A], [Not Supported], 570.86\n")
	if len(devs) != 1 || devs[0].Name != "NVIDIA GeForce RTX 4090" || *devs[0].UtilPct != 42 || devs[0].PowerDrawW != nil || devs[0].PowerLimitW != nil {
		t.Fatalf("unexpected nvidia-smi parse: %+v", devs)
	}

	// Ring buffer wrap-around preserves chronological order.
	ring := NewMetricRing(3)
	for i := 1; i <= 5; i++ {
		ring.Record(SystemSnapshot{CPU: CPUStats{UsagePct: float64(i * 10)}}, MetricPoint{CPUPct: float64(i * 10)})
	}
	snap, ok := ring.Snapshot()
	if !ok || len(snap.History) != 3 || snap.History[0].CPUPct != 30 || snap.History[2].CPUPct != 50 {
		t.Fatalf("unexpected ring snapshot: ok=%v history=%+v", ok, snap.History)
	}
}

func TestLogDemuxSanitizeRedactAndSearch(t *testing.T) {
	// 1. Multiplexed stdcopy framing (stdout + stderr)
	var frames bytes.Buffer
	frames.Write(encodeStdCopyFrame(1, "2026-11-22T12:00:01Z {\"host\":\"artifact.cubus.sh\",\"status\":502,\"request\":\"GET /mcp HTTP/2\",\"request_time\":0.123,\"cf_connecting_ip\":\"203.0.113.5\"}\n"))
	frames.Write(encodeStdCopyFrame(2, "2026-11-22T12:00:02Z \x1b[31mERROR\x1b[0m connect postgres://svc_art:supersecret@postgres:5432/svc_art Authorization: Bearer tok_abc123\n"))

	var lines []LogEntry
	_, err := ReadDockerLogStream(&frames, false, maxLogScanBytes, func(stream, line string) bool {
		lines = append(lines, ParseDockerLogLine("nginx-proxy", stream, line))
		return true
	})
	if err != nil || len(lines) != 2 {
		t.Fatalf("expected 2 demuxed lines, got %d err=%v", len(lines), err)
	}
	if lines[0].Structured == nil || lines[0].Structured.Status != 502 || lines[0].Level != "error" {
		t.Fatalf("expected parsed nginx 502 log, got %+v", lines[0])
	}
	if strings.Contains(lines[1].Message, "supersecret") || strings.Contains(lines[1].Message, "tok_abc123") || strings.Contains(lines[1].Message, "\x1b") {
		t.Fatalf("secrets or ANSI codes leaked: %q", lines[1].Message)
	}

	// 2. Overlong TTY line (> 64 KiB) must not fail with bufio.ErrTooLong.
	hugeLine := strings.Repeat("x", 80<<10) + "\nshort\n"
	var ttyLines []string
	_, err = ReadDockerLogStream(strings.NewReader(hugeLine), true, maxLogScanBytes, func(_, line string) bool {
		ttyLines = append(ttyLines, line)
		return true
	})
	if err != nil || len(ttyLines) != 2 || len(ttyLines[0]) != maxLogLineBytes || ttyLines[1] != "short" {
		t.Fatalf("unexpected overlong TTY handling: len=%d first=%d err=%v", len(ttyLines), len(ttyLines[0]), err)
	}
}

func TestDockerClientUnixSocketPeerVerifyStatsAndDiscovery(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "docker.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	var statsCalls atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/_ping", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Api-Version", "1.45")
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/v1.45/info", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Name":            "cubus-prod",
			"OperatingSystem": "Ubuntu 24.04",
			"KernelVersion":   "6.8.0",
			"NCPU":            8,
		})
	})
	mux.HandleFunc("/v1.45/containers/ops-self/json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Config": map[string]any{
				"Labels": map[string]string{"com.docker.compose.project": "cubus", "com.docker.compose.service": "ops-agent"},
			},
			"NetworkSettings": map[string]any{
				"Networks": map[string]any{
					"cubus_admin": map[string]string{"NetworkID": "net-admin-1", "IPAddress": "172.31.0.129"},
				},
			},
		})
	})
	mux.HandleFunc("/v1.45/containers/json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"Id": "aaaa111122223333", "Names": []string{"/cubus-admin-1"}, "Image": "cubus-admin:latest",
				"State": "running", "Status": "Up 1 hour",
				"Labels": map[string]string{"com.docker.compose.project": "cubus", "com.docker.compose.service": "admin"},
				"NetworkSettings": map[string]any{
					"Networks": map[string]any{"cubus_admin": map[string]string{"NetworkID": "net-admin-1", "IPAddress": "172.31.0.2"}},
				},
			},
			{
				"Id": "bbbb111122223333", "Names": []string{"/cubus-artifact-1"}, "Image": "cubus-artifact:latest",
				"State": "running", "Status": "Up 1 hour",
				"Labels": map[string]string{
					"com.docker.compose.project": "cubus",
					"com.docker.compose.service": "artifact",
					"cubus.admin.port":           "9090",
					"cubus.admin.name":           "artifact",
				},
				"NetworkSettings": map[string]any{
					"Networks": map[string]any{"cubus_admin": map[string]string{"NetworkID": "net-admin-1", "IPAddress": "172.31.0.130"}},
				},
			},
			{
				"Id": "cccc111122223333", "Names": []string{"/cubus-admin-run-1"}, "Image": "cubus-admin:latest",
				"State": "running", "Status": "Up 1 minute",
				"Labels": map[string]string{
					"com.docker.compose.project": "cubus",
					"com.docker.compose.service": "admin",
					"com.docker.compose.oneoff":  "True",
				},
				"NetworkSettings": map[string]any{
					"Networks": map[string]any{"cubus_admin": map[string]string{"NetworkID": "net-admin-1", "IPAddress": "172.31.0.131"}},
				},
			},
		})
	})
	mux.HandleFunc("/v1.45/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/json") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"RestartCount": 1,
				"Config": map[string]any{
					"Tty": false,
					"Env": []string{"SUPER_SECRET=must-never-appear"},
				},
				"State": map[string]any{
					"StartedAt": "2026-11-22T10:00:00Z",
					"Health":    map[string]string{"Status": "healthy"},
				},
			})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/stats") {
			n := statsCalls.Add(1)
			total := uint64(100_000_000 * n)
			sys := uint64(1_000_000_000 * n)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"cpu_stats": map[string]any{
					"cpu_usage":        map[string]any{"total_usage": total},
					"system_cpu_usage": sys,
					"online_cpus":      4,
				},
				"memory_stats": map[string]any{
					"usage": 200 << 20,
					"limit": 1024 << 20,
					"stats": map[string]uint64{"inactive_file": 50 << 20},
				},
			})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/logs") {
			_, _ = w.Write(encodeStdCopyFrame(1, "2026-11-22T12:00:00Z hello from artifact\n"))
			return
		}
		http.NotFound(w, r)
	})

	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	pfx := netip.MustParsePrefix("172.31.0.0/24")
	cfg := Config{
		AdminBindCIDR:  &pfx,
		DockerSocket:   sockPath,
		AllowedService: "admin",
	}
	cli := NewDockerClient(cfg)
	cli.selfContainerID = "ops-self"
	ctx := context.Background()
	if err := cli.Init(ctx); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	// VerifyAdminPeer: admin (172.31.0.2) allowed; artifact (172.31.0.130) & oneoff (172.31.0.131) & unknown rejected.
	if err := cli.VerifyAdminPeer(ctx, netip.MustParseAddr("172.31.0.2")); err != nil {
		t.Fatalf("expected admin peer allowed, got %v", err)
	}
	if err := cli.VerifyAdminPeer(ctx, netip.MustParseAddr("172.31.0.130")); err == nil {
		t.Fatal("expected artifact peer rejected")
	}
	if err := cli.VerifyAdminPeer(ctx, netip.MustParseAddr("172.31.0.131")); err == nil {
		t.Fatal("expected oneoff admin peer rejected")
	}

	// RefreshContainers twice -> second sample produces non-zero CPU diff & discovers artifact admin_ip.
	if err := cli.RefreshContainers(ctx); err != nil {
		t.Fatal(err)
	}
	if err := cli.RefreshContainers(ctx); err != nil {
		t.Fatal(err)
	}
	containers := cli.Containers()
	if len(containers) != 2 {
		t.Fatalf("expected 2 non-oneoff containers, got %d", len(containers))
	}
	serialized, _ := json.Marshal(containers)
	if strings.Contains(string(serialized), "SUPER_SECRET") {
		t.Fatal("container Env leaked into ContainerInfo JSON")
	}
	svcs := cli.AdminServices()
	if len(svcs) != 1 || svcs[0].Service != "artifact" || svcs[0].AdminIP != "172.31.0.130" || svcs[0].Port != 9090 {
		t.Fatalf("unexpected discovered services: %+v", svcs)
	}

	// Test HTTP endpoints & SSE log stream.
	ring := NewMetricRing(10)
	ring.Record(SystemSnapshot{CollectedAt: time.Now().UTC(), CPU: CPUStats{UsagePct: 12.5}}, MetricPoint{CPUPct: 12.5})
	ops := NewOpsServer(cli, ring, "", slog.New(slog.NewTextHandler(io.Discard, nil)))

	// /healthz rejects non-loopback, allows 127.0.0.1.
	hReq := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	hReq.RemoteAddr = "172.31.0.2:40000"
	hRec := httptest.NewRecorder()
	ops.HealthHandler().ServeHTTP(hRec, hReq)
	if hRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-loopback /healthz, got %d", hRec.Code)
	}
	hReq.RemoteAddr = "127.0.0.1:40000"
	hRec = httptest.NewRecorder()
	ops.HealthHandler().ServeHTTP(hRec, hReq)
	if hRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for loopback /healthz, got %d", hRec.Code)
	}

	// /ops/v1/logs/search allowed for admin peer, rejected for artifact peer.
	sReq := httptest.NewRequest(http.MethodGet, "/ops/v1/logs/search?service=artifact&q=hello", nil)
	sReq.RemoteAddr = "172.31.0.130:40001"
	sRec := httptest.NewRecorder()
	ops.APIHandler().ServeHTTP(sRec, sReq)
	if sRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for artifact peer on /ops/v1/logs/search, got %d", sRec.Code)
	}

	sReq.RemoteAddr = "172.31.0.2:40002"
	sRec = httptest.NewRecorder()
	ops.APIHandler().ServeHTTP(sRec, sReq)
	if sRec.Code != http.StatusOK || !strings.Contains(sRec.Body.String(), "hello from artifact") {
		t.Fatalf("unexpected log search response: %d %s", sRec.Code, sRec.Body.String())
	}

	// Ensure unused url import check stays clean.
	_ = url.Values{}
}
