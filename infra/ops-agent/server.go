package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

type OpsServer struct {
	docker           DockerBackend
	ring             *MetricRing
	devLoopbackToken string
	logger           *slog.Logger
	searchSem        chan struct{}
	streamSem        chan struct{}
}

func NewOpsServer(docker DockerBackend, ring *MetricRing, devLoopbackToken string, logger *slog.Logger) *OpsServer {
	if logger == nil {
		logger = slog.Default()
	}
	return &OpsServer{
		docker:           docker,
		ring:             ring,
		devLoopbackToken: devLoopbackToken,
		logger:           logger,
		searchSem:        make(chan struct{}, defaultMaxSearchConcur),
		streamSem:        make(chan struct{}, defaultMaxStreamConcur),
	}
}

func (s *OpsServer) HealthHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	return mux
}

func (s *OpsServer) APIHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ops/v1/system", s.handleSystem)
	mux.HandleFunc("GET /ops/v1/containers", s.handleContainers)
	mux.HandleFunc("GET /ops/v1/services", s.handleServices)
	mux.HandleFunc("GET /ops/v1/logs/search", s.handleLogsSearch)
	mux.HandleFunc("GET /ops/v1/logs/stream", s.handleLogsStream)
	return s.requireAdminPeer(mux)
}

// CombinedDevHandler serves both /healthz and /ops/v1/* on 127.0.0.1 in standalone mode.
func (s *OpsServer) CombinedDevHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /healthz", s.HealthHandler())
	mux.Handle("/ops/v1/", s.APIHandler())
	return mux
}

func (s *OpsServer) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	peerIP, ok := parsePeerIP(r.RemoteAddr)
	if !ok || !peerIP.IsLoopback() {
		writeJSONError(w, http.StatusForbidden, "healthz is restricted to loopback")
		return
	}
	if err := s.docker.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]bool{"ok": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *OpsServer) requireAdminPeer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		peerIP, ok := parsePeerIP(r.RemoteAddr)
		if !ok {
			writeJSONError(w, http.StatusForbidden, "unable to determine caller address")
			return
		}

		if s.devLoopbackToken != "" && peerIP.IsLoopback() {
			fields := strings.Fields(r.Header.Get("Authorization"))
			if len(fields) == 2 && strings.EqualFold(fields[0], "bearer") &&
				subtle.ConstantTimeCompare([]byte(fields[1]), []byte(s.devLoopbackToken)) == 1 {
				next.ServeHTTP(w, r)
				return
			}
			writeJSONError(w, http.StatusUnauthorized, "invalid dev loopback token")
			return
		}

		if err := s.docker.VerifyAdminPeer(r.Context(), peerIP); err != nil {
			if errors.Is(err, ErrUnknownPeer) || errors.Is(err, ErrForbiddenPeer) || errors.Is(err, ErrAmbiguousPeer) {
				s.logger.Warn("rejected unauthorized ops-agent peer", "peer_ip", peerIP.String(), "err", err)
				writeJSONError(w, http.StatusForbidden, "caller is not authorized")
				return
			}
			s.logger.Error("peer verification error", "peer_ip", peerIP.String(), "err", err)
			writeJSONError(w, http.StatusServiceUnavailable, "failed to verify caller identity")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *OpsServer) handleSystem(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	snap, ok := s.ring.Snapshot()
	if !ok {
		writeJSONError(w, http.StatusServiceUnavailable, "metrics warming up")
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *OpsServer) handleContainers(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"containers":   s.docker.Containers(),
		"collected_at": time.Now().UTC(),
	})
}

func (s *OpsServer) handleServices(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"services": s.docker.AdminServices(),
	})
}

func (s *OpsServer) handleLogsSearch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	select {
	case s.searchSem <- struct{}{}:
		defer func() { <-s.searchSem }()
	default:
		w.Header().Set("Retry-After", "1")
		writeJSONError(w, http.StatusServiceUnavailable, "log search concurrency limit reached")
		return
	}

	q := r.URL.Query()
	params := LogSearchParams{
		Service:     strings.TrimSpace(q.Get("service")),
		Query:       q.Get("q"),
		IsRegex:     q.Get("regex") == "1" || strings.EqualFold(q.Get("regex"), "true"),
		Level:       strings.ToLower(strings.TrimSpace(q.Get("level"))),
		NginxHost:   strings.TrimSpace(q.Get("nginx_host")),
		NginxStatus: strings.TrimSpace(q.Get("nginx_status")),
	}

	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		n, err := strconv.Atoi(rawLimit)
		if err != nil || n < 1 || n > maxLogLimit {
			writeJSONError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		params.Limit = n
	}
	if rawTail := strings.TrimSpace(q.Get("tail")); rawTail != "" {
		n, err := strconv.Atoi(rawTail)
		if err != nil || n < 1 || n > maxLogTail {
			writeJSONError(w, http.StatusBadRequest, "invalid tail")
			return
		}
		params.Tail = n
	}
	if rawSince := strings.TrimSpace(q.Get("since")); rawSince != "" {
		ts, err := parseTimeOrWindow(rawSince)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid since value")
			return
		}
		params.Since = &ts
	}
	if rawUntil := strings.TrimSpace(q.Get("until")); rawUntil != "" {
		ts, err := time.Parse(time.RFC3339, rawUntil)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid until value (expected RFC3339)")
			return
		}
		params.Until = &ts
	}

	res, err := s.searchLogs(r.Context(), params)
	if err != nil {
		if errors.Is(err, ErrServiceUnknown) {
			writeJSONError(w, http.StatusNotFound, "unknown service")
			return
		}
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *OpsServer) handleLogsStream(w http.ResponseWriter, r *http.Request) {
	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service == "" {
		writeJSONError(w, http.StatusBadRequest, "service query param is required")
		return
	}
	tail := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("tail")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			tail = n
		}
	}
	s.streamLogsSSE(w, r, service, tail)
}

func parseTimeOrWindow(raw string) (time.Time, error) {
	if d, err := time.ParseDuration(raw); err == nil && d > 0 && d <= 7*24*time.Hour {
		return time.Now().UTC().Add(-d), nil
	}
	return time.Parse(time.RFC3339, raw)
}

func parsePeerIP(remoteAddr string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(host))
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"encode failed"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
