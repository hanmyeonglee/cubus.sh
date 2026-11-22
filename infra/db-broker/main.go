package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	startupBudget      = 20 * time.Second
	startupRetryDelay  = 500 * time.Millisecond
	shutdownGraceTime  = 10 * time.Second
	healthClientExpiry = 2 * time.Second
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "run HTTP healthcheck against local db-broker and exit")
	flag.Parse()

	if *healthcheck {
		os.Exit(runHealthcheck(os.Getenv("LISTEN_ADDR")))
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := runServer(logger); err != nil {
		logger.Error("db-broker exited with error", "error", err)
		os.Exit(1)
	}
}

func runHealthcheck(listenAddr string) int {
	target, err := healthcheckURL(listenAddr)
	if err != nil {
		return 1
	}
	client := &http.Client{Timeout: healthClientExpiry}
	resp, err := client.Get(target)
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func runServer(logger *slog.Logger) error {
	cfg, err := LoadConfigFromEnv()
	if err != nil {
		return err
	}
	logger.Info("loaded configuration", "config", cfg)

	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	initCtx, initCancel := context.WithTimeout(rootCtx, startupBudget)
	defer initCancel()

	resolver := NewDockerSocketResolver(cfg.DockerSocket, cfg.ComposeProject, cfg.DBNetworkName)
	if err := retryUntil(initCtx, startupRetryDelay, resolver.Init); err != nil {
		return fmt.Errorf("initialize docker identity resolver: %w", err)
	}
	logger.Info("initialized docker identity resolver",
		"project", resolver.project,
		"db_network", resolver.dbNetworkName,
		"api_prefix", resolver.apiPrefix,
	)

	provisioner, err := NewPGProvisioner(initCtx, cfg)
	if err != nil {
		return fmt.Errorf("create postgres provisioner: %w", err)
	}
	defer provisioner.Close()

	if err := retryUntil(initCtx, startupRetryDelay, provisioner.Bootstrap); err != nil {
		return fmt.Errorf("bootstrap postgres metadata: %w", err)
	}
	logger.Info("bootstrapped postgres metadata and locked down system databases")

	broker := NewBrokerServer(rootCtx, resolver, provisioner, cfg.MaxConcurrentProvisions, logger)
	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           broker.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("db-broker listening", "addr", cfg.ListenAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-rootCtx.Done():
		logger.Info("shutting down db-broker")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGraceTime)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("http server shutdown: %w", err)
		}
		return <-errCh
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
