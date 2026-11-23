package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"
)

const (
	maxRequestBodyBytes = 1024
	healthProbeTimeout  = 1500 * time.Millisecond
	provisionTimeout    = 20 * time.Second
	adminStatsTimeout   = 3 * time.Second
	defaultAdminService = "admin"
)

var errOverloaded = errors.New("provisioner concurrency limit reached")

type inflightCall struct {
	done  chan struct{}
	creds DatabaseCredentials
	err   error
}

type BrokerServer struct {
	baseCtx          context.Context
	resolver         IdentityResolver
	provisioner      Provisioner
	statsProvider    StatsProvider
	adminServiceName string
	logger           *slog.Logger
	sem              chan struct{}

	mu       sync.Mutex
	inflight map[netip.Addr]*inflightCall
}

func NewBrokerServer(baseCtx context.Context, resolver IdentityResolver, provisioner Provisioner, maxConcurrent int, logger *slog.Logger) *BrokerServer {
	if maxConcurrent < 1 {
		maxConcurrent = defaultMaxConcurrentProvisions
	}
	if logger == nil {
		logger = slog.Default()
	}
	var sp StatsProvider
	if provider, ok := provisioner.(StatsProvider); ok {
		sp = provider
	}
	return &BrokerServer{
		baseCtx:          baseCtx,
		resolver:         resolver,
		provisioner:      provisioner,
		statsProvider:    sp,
		adminServiceName: defaultAdminService,
		logger:           logger,
		sem:              make(chan struct{}, maxConcurrent),
		inflight:         make(map[netip.Addr]*inflightCall),
	}
}

func (s *BrokerServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/v1/database", s.handleDatabase)
	mux.HandleFunc("/v1/admin/stats", s.handleAdminStats)
	return mux
}

func (s *BrokerServer) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	peerIP, ok := parsePeerIP(r.RemoteAddr)
	if !ok || !peerIP.IsLoopback() {
		writeJSONError(w, http.StatusForbidden, "healthz is restricted to loopback")
		return
	}

	probeCtx, cancel := context.WithTimeout(r.Context(), healthProbeTimeout)
	defer cancel()

	if err := s.provisioner.Ping(probeCtx); err != nil {
		s.logger.Warn("healthz postgres ping failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]bool{"ok": false})
		return
	}
	if err := s.resolver.Ping(probeCtx); err != nil {
		s.logger.Warn("healthz docker ping failed", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]bool{"ok": false})
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *BrokerServer) handleDatabase(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	if trimmed := bytes.TrimSpace(body); len(trimmed) > 0 {
		var payload map[string]any
		dec := json.NewDecoder(bytes.NewReader(trimmed))
		if err := dec.Decode(&payload); err != nil || payload == nil || len(payload) > 0 {
			writeJSONError(w, http.StatusBadRequest, "request body must be empty or {}")
			return
		}
		if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			writeJSONError(w, http.StatusBadRequest, "request body must be empty or {}")
			return
		}
	}

	// Strictly trust TCP socket peer address; ignore X-Forwarded-For / Forwarded.
	peerIP, ok := parsePeerIP(r.RemoteAddr)
	if !ok {
		writeJSONError(w, http.StatusForbidden, "unable to determine caller address")
		return
	}

	creds, err := s.provisionForPeer(r.Context(), peerIP)
	if err != nil {
		s.writeProvisionError(w, peerIP, err)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, creds)
}

func (s *BrokerServer) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.statsProvider == nil {
		writeJSONError(w, http.StatusNotImplemented, "cluster stats unavailable")
		return
	}

	peerIP, ok := parsePeerIP(r.RemoteAddr)
	if !ok {
		writeJSONError(w, http.StatusForbidden, "unable to determine caller address")
		return
	}

	opCtx, cancel := context.WithTimeout(r.Context(), adminStatsTimeout)
	defer cancel()

	serviceName, err := s.resolver.ResolveService(opCtx, peerIP)
	if err != nil {
		if errors.Is(err, ErrUnknownCaller) || errors.Is(err, ErrForbiddenCaller) || errors.Is(err, ErrAmbiguousCaller) {
			s.logger.Warn("rejected admin stats request", "peer_ip", peerIP.String(), "error", err)
			writeJSONError(w, http.StatusForbidden, "caller is not authorized")
			return
		}
		s.logger.Error("resolve caller for admin stats failed", "peer_ip", peerIP.String(), "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "unable to verify caller identity")
		return
	}
	if serviceName != s.adminServiceName {
		s.logger.Warn("rejected non-admin caller for stats", "service", serviceName, "peer_ip", peerIP.String())
		writeJSONError(w, http.StatusForbidden, "admin stats restricted to admin service")
		return
	}

	stats, err := s.statsProvider.ClusterStats(opCtx)
	if err != nil {
		s.logger.Error("collect postgres cluster stats failed", "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "failed to collect postgres cluster stats")
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, stats)
}

func (s *BrokerServer) provisionForPeer(reqCtx context.Context, peerIP netip.Addr) (DatabaseCredentials, error) {
	s.mu.Lock()
	if existing, ok := s.inflight[peerIP]; ok {
		s.mu.Unlock()
		select {
		case <-existing.done:
			return existing.creds, existing.err
		case <-reqCtx.Done():
			return DatabaseCredentials{}, reqCtx.Err()
		}
	}

	select {
	case s.sem <- struct{}{}:
	default:
		s.mu.Unlock()
		return DatabaseCredentials{}, errOverloaded
	}

	call := &inflightCall{done: make(chan struct{})}
	s.inflight[peerIP] = call
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.inflight, peerIP)
			s.mu.Unlock()
			<-s.sem
			close(call.done)
		}()

		opCtx, cancel := context.WithTimeout(s.baseCtx, provisionTimeout)
		defer cancel()

		serviceName, err := s.resolver.ResolveService(opCtx, peerIP)
		if err != nil {
			call.err = err
			return
		}

		creds, err := s.provisioner.Provision(opCtx, serviceName)
		if err != nil {
			call.err = err
			return
		}
		s.logger.Info("provisioned database", "service", serviceName, "database", creds.Database, "peer_ip", peerIP.String())
		call.creds = creds
	}()

	select {
	case <-call.done:
		return call.creds, call.err
	case <-reqCtx.Done():
		return DatabaseCredentials{}, reqCtx.Err()
	}
}

func (s *BrokerServer) writeProvisionError(w http.ResponseWriter, peerIP netip.Addr, err error) {
	switch {
	case errors.Is(err, ErrUnknownCaller), errors.Is(err, ErrForbiddenCaller), errors.Is(err, ErrAmbiguousCaller):
		s.logger.Warn("rejected database request", "peer_ip", peerIP.String(), "error", err)
		writeJSONError(w, http.StatusForbidden, "caller is not authorized")
	case errors.Is(err, ErrInvalidIdentifier):
		s.logger.Warn("invalid service identifier", "peer_ip", peerIP.String(), "error", err)
		writeJSONError(w, http.StatusBadRequest, "invalid service identifier")
	case errors.Is(err, ErrIdentifierConflict), errors.Is(err, ErrUnmanagedObject):
		s.logger.Error("database identifier conflict", "peer_ip", peerIP.String(), "error", err)
		writeJSONError(w, http.StatusConflict, "database identifier conflict")
	case errors.Is(err, errOverloaded), errors.Is(err, ErrLockTimeout), errors.Is(err, context.DeadlineExceeded):
		s.logger.Warn("transient provisioner error", "peer_ip", peerIP.String(), "error", err)
		w.Header().Set("Retry-After", "1")
		writeJSONError(w, http.StatusServiceUnavailable, "database broker temporarily unavailable; retry")
	default:
		s.logger.Error("database provisioning failed", "peer_ip", peerIP.String(), "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal server error")
	}
}

func parsePeerIP(remoteAddr string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return netip.Addr{}, false
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"failed to encode response"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
