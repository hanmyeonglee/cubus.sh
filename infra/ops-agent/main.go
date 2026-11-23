package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"
)

const (
	startupBudget     = 20 * time.Second
	shutdownGraceTime = 10 * time.Second
	dfRefreshInterval = 5 * time.Minute
	cpuBaselineDelay  = 200 * time.Millisecond
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe local loopback /healthz and exit")
	flag.Parse()

	if *healthcheck {
		os.Exit(runHealthcheck())
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("ops-agent exited with error", "err", err)
		os.Exit(1)
	}
}

func runHealthcheck() int {
	port := defaultAdminPort
	if raw := os.Getenv("ADMIN_PORT"); raw != "" {
		if p, err := strconv.Atoi(raw); err == nil {
			port = p
		}
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(healthcheckURL(port))
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run(logger *slog.Logger) error {
	cfg, err := LoadConfigFromEnv()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	logger.Info("starting ops-agent", "config", cfg)

	sigCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	initCtx, cancelInit := context.WithTimeout(sigCtx, startupBudget)
	defer cancelInit()

	dockerCli := NewDockerClient(cfg)
	if err := retryUntil(initCtx, 500*time.Millisecond, dockerCli.Init); err != nil {
		return fmt.Errorf("initialize docker client: %w", err)
	}
	logger.Info("initialized docker client",
		"project", dockerCli.project,
		"admin_network", dockerCli.adminNetName,
		"api_prefix", dockerCli.apiPrefix,
	)

	ring := NewMetricRing(cfg.RingCapacity)
	collector := NewHostCollector(cfg.HostOSReleasePath, dockerCli.HostInfo, dockerCli.DiskUsage)
	collector.PrimeCPUBaseline()
	select {
	case <-time.After(cpuBaselineDelay):
	case <-sigCtx.Done():
		return nil
	}

	// Collect initial snapshot before opening listeners.
	_ = dockerCli.RefreshContainers(initCtx)
	snap, pt := collector.Collect(initCtx)
	ring.Record(snap, pt)

	opsSrv := NewOpsServer(dockerCli, ring, cfg.DevLoopbackToken, logger)

	srvCtx, cancelSrv := context.WithCancel(context.Background())
	defer cancelSrv()
	baseCtxFn := func(net.Listener) context.Context { return srvCtx }

	var servers []*http.Server
	if cfg.AdminBindCIDR != nil {
		adminAddr, err := ResolveAdminBindAddr(cfg.AdminBindCIDR, cfg.AdminPort)
		if err != nil {
			return fmt.Errorf("resolve admin bind address: %w", err)
		}
		// Separate loopback-only /healthz listener + admin-CIDR-only /ops/v1/* listener.
		servers = append(servers,
			&http.Server{
				Addr:              net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.AdminPort)),
				Handler:           opsSrv.HealthHandler(),
				BaseContext:       baseCtxFn,
				ReadHeaderTimeout: 5 * time.Second,
				ReadTimeout:       5 * time.Second,
				WriteTimeout:      5 * time.Second,
			},
			&http.Server{
				Addr:              adminAddr,
				Handler:           opsSrv.APIHandler(),
				BaseContext:       baseCtxFn,
				ReadHeaderTimeout: 5 * time.Second,
				ReadTimeout:       15 * time.Second,
				WriteTimeout:      30 * time.Second, // Extended per-event for SSE via ResponseController
				IdleTimeout:       60 * time.Second,
				MaxHeaderBytes:    16 << 10,
			},
		)
	} else {
		servers = append(servers, &http.Server{
			Addr:              net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.AdminPort)),
			Handler:           opsSrv.CombinedDevHandler(),
			BaseContext:       baseCtxFn,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    16 << 10,
		})
	}

	bgCtx, cancelBg := context.WithCancel(context.Background())
	var bgWG sync.WaitGroup
	bgWG.Add(2)
	go func() {
		defer bgWG.Done()
		runMetricsSampler(bgCtx, cfg.SampleInterval, dockerCli, collector, ring, logger)
	}()
	go func() {
		defer bgWG.Done()
		runDFSampler(bgCtx, dockerCli, logger)
	}()

	errCh := make(chan error, len(servers))
	for _, srv := range servers {
		go func(s *http.Server) {
			logger.Info("ops-agent listener started", "addr", s.Addr)
			if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- fmt.Errorf("listener %s failed: %w", s.Addr, err)
			}
		}(srv)
	}

	var runErr error
	select {
	case <-sigCtx.Done():
		logger.Info("ops-agent shutting down")
	case err := <-errCh:
		runErr = err
	}

	cancelBg()
	cancelSrv() // Cancel active SSE request contexts immediately so Shutdown does not stall to SIGKILL.
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownGraceTime)
	defer cancelShutdown()
	for _, srv := range servers {
		_ = srv.Shutdown(shutdownCtx)
	}
	bgWG.Wait()
	return runErr
}

func runMetricsSampler(ctx context.Context, interval time.Duration, dockerCli *DockerClient, collector *HostCollector, ring *MetricRing, logger *slog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Separate sub-contexts so slow container stats cannot starve host/nvidia-smi collection.
			cntCtx, cancelCnt := context.WithTimeout(ctx, interval)
			if err := dockerCli.RefreshContainers(cntCtx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("container snapshot refresh failed", "err", err)
			}
			cancelCnt()

			hostCtx, cancelHost := context.WithTimeout(ctx, interval)
			snap, pt := collector.Collect(hostCtx)
			cancelHost()
			ring.Record(snap, pt)
		}
	}
}

func runDFSampler(ctx context.Context, dockerCli *DockerClient, logger *slog.Logger) {
	// Run once asynchronously after startup, then every 5 minutes with a 30s timeout.
	refresh := func() {
		dfCtx, cancel := context.WithTimeout(ctx, dockerDFTimeout)
		defer cancel()
		if err := dockerCli.RefreshSystemDF(dfCtx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("docker /system/df refresh failed", "err", err)
		}
	}
	refresh()
	ticker := time.NewTicker(dfRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}

func retryUntil(ctx context.Context, delay time.Duration, fn func(context.Context) error) error {
	var lastErr error
	for {
		if err := fn(ctx); err == nil {
			return nil
		} else {
			lastErr = err
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("%w (last error: %v)", ctx.Err(), lastErr)
		case <-timer.C:
		}
	}
}
