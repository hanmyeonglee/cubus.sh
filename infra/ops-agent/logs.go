package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	maxLogScanBytes       = 16 << 20 // 16 MiB total scan safety ceiling
	maxLogFrameBytes      = 1 << 20  // 1 MiB single stdcopy frame cap
	maxLogLineBytes       = 32 << 10
	defaultLogTail        = 2000
	maxLogTail            = 5000
	defaultLogLimit       = 200
	maxLogLimit           = 1000
	maxRegexPatternLen    = 200
	logSearchTimeout      = 5 * time.Second
	logStreamMaxLifetime  = 30 * time.Minute
	logStreamHeartbeat    = 15 * time.Second
	logStreamWriteTimeout = 30 * time.Second
)

var (
	ansiCSIPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
	redactPatterns = []struct {
		re   *regexp.Regexp
		repl string
	}{
		{regexp.MustCompile(`(?i)(postgres(?:ql)?://)[^@\s"'\\]+(@)`), `${1}[REDACTED]${2}`},
		{regexp.MustCompile(`(?i)("?authorization"?\s*[:=]\s*"?bearer\s+)[^\s"',}\]]+`), `${1}[REDACTED]`},
		{regexp.MustCompile(`(?i)("?(?:set-)?cookie"?\s*[:=]\s*"?)[^\r\n;"'}\]]+`), `${1}[REDACTED]`},
		{regexp.MustCompile(`(?i)("?(?:password|client_secret|access_token|refresh_token)"?\s*[:=]\s*"?)[^"\s,&}\]]+`), `${1}[REDACTED]`},
	}
)

type StructuredLog struct {
	Host        string   `json:"host,omitempty"`
	Status      int      `json:"status,omitempty"`
	Request     string   `json:"request,omitempty"`
	RequestTime *float64 `json:"request_time,omitempty"`
	ClientIP    string   `json:"client_ip,omitempty"`
	Upstream    string   `json:"upstream,omitempty"`
	CFRay       string   `json:"cf_ray,omitempty"`
}

type LogEntry struct {
	Timestamp  time.Time      `json:"ts"`
	Service    string         `json:"service"`
	Stream     string         `json:"stream"`
	Level      string         `json:"level"`
	Message    string         `json:"message"`
	Structured *StructuredLog `json:"structured,omitempty"`
}

type LogSearchParams struct {
	Service     string
	Query       string
	IsRegex     bool
	Level       string
	NginxHost   string
	NginxStatus string
	Since       *time.Time
	Until       *time.Time
	Tail        int
	Limit       int
}

type LogSearchResult struct {
	Entries   []LogEntry `json:"entries"`
	Count     int        `json:"count"`
	Truncated bool       `json:"truncated"`
	NextUntil string     `json:"next_until,omitempty"`
}

func SanitizeAndRedact(raw string) string {
	cleaned := ansiCSIPattern.ReplaceAllString(raw, "")
	var b strings.Builder
	b.Grow(len(cleaned))
	for _, r := range cleaned {
		if r == '\t' || (!unicode.IsControl(r) && r != '\uFFFD') {
			b.WriteRune(r)
		} else if r == '\r' || r == '\n' {
			b.WriteByte(' ')
		}
	}
	out := b.String()
	for _, rp := range redactPatterns {
		out = rp.re.ReplaceAllString(out, rp.repl)
	}
	return out
}

// ParseDockerLogLine splits the leading Docker RFC3339 timestamp, strips ANSI/control chars,
// redacts sensitive patterns, and parses nginx-proxy / slog JSON payloads when present.
func ParseDockerLogLine(service, stream, rawLine string) LogEntry {
	ts := time.Now().UTC()
	payload := rawLine
	if idx := strings.IndexByte(rawLine, ' '); idx > 15 && idx < 45 {
		if parsed, err := time.Parse(time.RFC3339Nano, rawLine[:idx]); err == nil {
			ts = parsed.UTC()
			payload = rawLine[idx+1:]
		}
	}

	safe := SanitizeAndRedact(strings.TrimSpace(payload))
	entry := LogEntry{
		Timestamp: ts,
		Service:   service,
		Stream:    stream,
		Level:     inferLevel(stream, safe),
		Message:   safe,
	}

	if strings.HasPrefix(safe, "{") && strings.HasSuffix(safe, "}") {
		var obj map[string]any
		if err := json.Unmarshal([]byte(safe), &obj); err == nil {
			if lvl, ok := obj["level"].(string); ok && lvl != "" {
				entry.Level = normalizeLevel(lvl)
			}
			if msg, ok := obj["msg"].(string); ok && msg != "" {
				entry.Message = SanitizeAndRedact(msg)
			} else if msg, ok := obj["message"].(string); ok && msg != "" {
				entry.Message = SanitizeAndRedact(msg)
			}
			// Detect nginx-proxy JSON access log shape.
			if reqStr, ok := obj["request"].(string); ok && reqStr != "" {
				st := &StructuredLog{
					Request: SanitizeAndRedact(reqStr),
				}
				if h, ok := obj["host"].(string); ok {
					st.Host = SanitizeAndRedact(h)
				}
				if code, ok := obj["status"].(float64); ok {
					st.Status = int(code)
					switch {
					case st.Status >= 500:
						entry.Level = "error"
					case st.Status >= 400:
						entry.Level = "warn"
					default:
						entry.Level = "info"
					}
				}
				if rt, ok := obj["request_time"].(float64); ok {
					st.RequestTime = &rt
				}
				if ip, ok := obj["cf_connecting_ip"].(string); ok && ip != "" {
					st.ClientIP = SanitizeAndRedact(ip)
				} else if ip, ok := obj["client_ip"].(string); ok {
					st.ClientIP = SanitizeAndRedact(ip)
				}
				if up, ok := obj["upstream_addr"].(string); ok {
					st.Upstream = SanitizeAndRedact(up)
				}
				if ray, ok := obj["cf_ray"].(string); ok {
					st.CFRay = SanitizeAndRedact(ray)
				}
				entry.Structured = st
				entry.Message = fmt.Sprintf("%d %s %s", st.Status, st.Host, st.Request)
			}
		}
	}
	return entry
}

func inferLevel(stream, msg string) string {
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "error") || strings.Contains(low, "fatal") || strings.Contains(low, "panic"):
		return "error"
	case strings.Contains(low, "warn"):
		return "warn"
	case stream == "stderr":
		return "warn"
	default:
		return "info"
	}
}

func normalizeLevel(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "err", "error", "fatal", "crit", "critical", "emerg":
		return "error"
	case "warn", "warning":
		return "warn"
	case "debug", "trace":
		return "debug"
	default:
		return "info"
	}
}

// ReadDockerLogStream reads either 8-byte multiplexed Docker stdcopy frames (!isTTY)
// or raw TTY lines (isTTY) with strict frame, line, and total byte caps.
func ReadDockerLogStream(r io.Reader, isTTY bool, maxBytes int64, onLine func(stream, line string) bool) (bool, error) {
	if isTTY {
		return readRawLines(r, "stdout", maxBytes, onLine)
	}
	var scanned int64
	var hdr [8]byte
	partials := map[string][]byte{}
	discarding := map[string]bool{}
	flushPartials := func() {
		for _, st := range []string{"stdout", "stderr"} {
			buf := partials[st]
			if len(buf) > 0 {
				if !onLine(st, string(buf)) {
					return
				}
			}
		}
	}

	for {
		if maxBytes > 0 && scanned >= maxBytes {
			flushPartials()
			return true, nil
		}
		_, err := io.ReadFull(r, hdr[:])
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			flushPartials()
			return false, nil
		}
		if err != nil {
			flushPartials()
			return false, err
		}

		streamName := "stdout"
		if hdr[0] == 2 {
			streamName = "stderr"
		}
		frameLen := binary.BigEndian.Uint32(hdr[4:8])
		if frameLen == 0 {
			continue
		}
		if frameLen > maxLogFrameBytes {
			return true, fmt.Errorf("docker log frame too large (%d bytes)", frameLen)
		}

		toRead := int64(frameLen)
		truncated := false
		if maxBytes > 0 && scanned+toRead > maxBytes {
			toRead = maxBytes - scanned
			truncated = true
		}
		buf := make([]byte, toRead)
		if _, err := io.ReadFull(r, buf); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				flushPartials()
				return truncated, nil
			}
			return truncated, err
		}
		scanned += toRead

		// If previous frame truncated an overlong line (>maxLogLineBytes), discard remaining
		// tail bytes until the terminating newline so it never splits into a fake LogEntry.
		if discarding[streamName] {
			nl := bytes.IndexByte(buf, '\n')
			if nl < 0 {
				if truncated {
					flushPartials()
					return true, nil
				}
				continue
			}
			discarding[streamName] = false
			buf = buf[nl+1:]
		}

		combined := append(partials[streamName], buf...)
		for {
			idx := bytes.IndexByte(combined, '\n')
			if idx < 0 {
				break
			}
			lineBytes := bytes.TrimRight(combined[:idx], "\r")
			if len(lineBytes) > maxLogLineBytes {
				lineBytes = lineBytes[:maxLogLineBytes]
			}
			if !onLine(streamName, string(lineBytes)) {
				return true, nil
			}
			combined = combined[idx+1:]
		}
		if len(combined) > maxLogLineBytes {
			if !onLine(streamName, string(combined[:maxLogLineBytes])) {
				return true, nil
			}
			discarding[streamName] = true
			combined = nil
		}
		partials[streamName] = append([]byte(nil), combined...)
		if truncated {
			flushPartials()
			return true, nil
		}
	}
}

func readRawLines(r io.Reader, stream string, maxBytes int64, onLine func(stream, line string) bool) (bool, error) {
	br := bufio.NewReaderSize(r, 16<<10)
	var scanned int64
	for {
		if maxBytes > 0 && scanned >= maxBytes {
			return true, nil
		}
		line, err := readBoundedLine(br, maxLogLineBytes)
		if len(line) > 0 {
			scanned += int64(len(line))
			if !onLine(stream, string(line)) {
				return true, nil
			}
		}
		if errors.Is(err, io.EOF) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
	}
}

// readBoundedLine reads one newline-delimited line up to maxBytes, discarding any excess bytes
// on the same line so overlong lines never trigger bufio.ErrTooLong.
func readBoundedLine(br *bufio.Reader, maxBytes int) ([]byte, error) {
	var out []byte
	for {
		frag, err := br.ReadSlice('\n')
		if len(out) < maxBytes {
			rem := maxBytes - len(out)
			if len(frag) <= rem {
				out = append(out, frag...)
			} else {
				out = append(out, frag[:rem]...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		out = bytes.TrimRight(out, "\r\n")
		return out, err
	}
}

func matchLogEntry(e LogEntry, p LogSearchParams, re *regexp.Regexp) bool {
	if p.Level != "" && p.Level != "all" && e.Level != p.Level {
		return false
	}
	if p.NginxHost != "" {
		if e.Structured == nil || !strings.EqualFold(e.Structured.Host, p.NginxHost) {
			return false
		}
	}
	if p.NginxStatus != "" {
		if e.Structured == nil || !matchHTTPStatus(e.Structured.Status, p.NginxStatus) {
			return false
		}
	}
	if p.Query != "" {
		haystack := e.Message
		if e.Structured != nil {
			haystack = e.Message + " " + e.Structured.ClientIP + " " + e.Structured.Upstream + " " + e.Structured.CFRay
		}
		if re != nil {
			if !re.MatchString(haystack) {
				return false
			}
		} else if !strings.Contains(strings.ToLower(haystack), strings.ToLower(p.Query)) {
			return false
		}
	}
	return true
}

func matchHTTPStatus(code int, filter string) bool {
	f := strings.ToLower(strings.TrimSpace(filter))
	switch f {
	case "2xx":
		return code >= 200 && code < 300
	case "3xx":
		return code >= 300 && code < 400
	case "4xx":
		return code >= 400 && code < 500
	case "5xx":
		return code >= 500 && code < 600
	default:
		n, err := strconv.Atoi(f)
		return err == nil && code == n
	}
}

func (s *OpsServer) searchLogs(ctx context.Context, p LogSearchParams) (LogSearchResult, error) {
	if p.Limit <= 0 {
		p.Limit = defaultLogLimit
	}
	if p.Limit > maxLogLimit {
		p.Limit = maxLogLimit
	}
	if p.Tail <= 0 {
		p.Tail = defaultLogTail
	}
	if p.Tail > maxLogTail {
		p.Tail = maxLogTail
	}

	var re *regexp.Regexp
	if p.IsRegex && p.Query != "" {
		if len(p.Query) > maxRegexPatternLen {
			return LogSearchResult{}, fmt.Errorf("regex pattern exceeds %d characters", maxRegexPatternLen)
		}
		var err error
		re, err = regexp.Compile(p.Query)
		if err != nil {
			return LogSearchResult{}, fmt.Errorf("invalid regex: %w", err)
		}
	}

	var targets []ContainerInfo
	if p.Service == "" || p.Service == "all" {
		targets = s.docker.Containers()
	} else {
		c, ok := s.docker.FindServiceContainer(p.Service)
		if !ok {
			return LogSearchResult{}, ErrServiceUnknown
		}
		targets = []ContainerInfo{c}
	}

	searchCtx, cancel := context.WithTimeout(ctx, logSearchTimeout)
	defer cancel()

	perContainerCap := int64(maxLogScanBytes)
	if len(targets) > 1 {
		perContainerCap = max(int64(maxLogScanBytes/len(targets)), 1<<20)
	}

	entries := make([]LogEntry, 0, min(p.Limit, 256))
	truncated := false
	var oldestScannedTS time.Time

	for _, c := range targets {
		q := url.Values{
			"stdout":     {"1"},
			"stderr":     {"1"},
			"timestamps": {"1"},
			"tail":       {strconv.Itoa(p.Tail)},
		}
		if p.Since != nil {
			q.Set("since", strconv.FormatInt(p.Since.Unix(), 10))
		}
		if p.Until != nil {
			// Docker until accepts integer seconds; pass Unix()+1 and enforce exact sub-second cutoff in Go.
			q.Set("until", strconv.FormatInt(p.Until.Unix()+1, 10))
		}

		rc, err := s.docker.OpenContainerLogs(searchCtx, c.FullID, q)
		if err != nil {
			continue
		}
		var seenLines int
		// Keep a bounded sliding window of the newest p.Limit matching lines per container
		// so scanning oldest-to-newest never consumes unbounded memory or drops recent matches.
		svcMatches := make([]LogEntry, 0, min(p.Limit, 128))
		wasTrunc, _ := ReadDockerLogStream(rc, c.IsTTY, perContainerCap, func(stream, line string) bool {
			seenLines++
			entry := ParseDockerLogLine(c.Service, stream, line)
			if p.Since != nil && entry.Timestamp.Before(*p.Since) {
				return true
			}
			if p.Until != nil && !entry.Timestamp.Before(*p.Until) {
				return true
			}
			if oldestScannedTS.IsZero() || entry.Timestamp.Before(oldestScannedTS) {
				oldestScannedTS = entry.Timestamp
			}
			if matchLogEntry(entry, p, re) {
				if len(svcMatches) >= p.Limit {
					// Drop oldest match to retain newest p.Limit matches.
					copy(svcMatches, svcMatches[1:])
					svcMatches[len(svcMatches)-1] = entry
					truncated = true
				} else {
					svcMatches = append(svcMatches, entry)
				}
			}
			return true
		})
		rc.Close()
		entries = append(entries, svcMatches...)
		if wasTrunc || seenLines >= p.Tail {
			truncated = true
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp.After(entries[j].Timestamp)
	})
	if len(entries) > p.Limit {
		entries = entries[:p.Limit]
		truncated = true
	}

	res := LogSearchResult{
		Entries:   entries,
		Count:     len(entries),
		Truncated: truncated,
	}
	// Choose cursor so "Load Older" advances accurately even when a scanned window had 0 filter matches.
	var cursorTS time.Time
	if len(entries) > 0 {
		cursorTS = entries[len(entries)-1].Timestamp
		if !oldestScannedTS.IsZero() && oldestScannedTS.Before(cursorTS) && len(entries) < p.Limit {
			cursorTS = oldestScannedTS
		}
	} else if !oldestScannedTS.IsZero() {
		cursorTS = oldestScannedTS
	}
	if !cursorTS.IsZero() {
		res.NextUntil = cursorTS.UTC().Format(time.RFC3339Nano)
	}
	return res, nil
}

func (s *OpsServer) streamLogsSSE(w http.ResponseWriter, r *http.Request, service string, tail int) {
	c, ok := s.docker.FindServiceContainer(service)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "unknown service")
		return
	}
	if tail <= 0 || tail > 500 {
		tail = 50
	}

	select {
	case s.streamSem <- struct{}{}:
		defer func() { <-s.streamSem }()
	default:
		w.Header().Set("Retry-After", "2")
		writeJSONError(w, http.StatusServiceUnavailable, "too many concurrent log streams")
		return
	}

	streamCtx, cancel := context.WithTimeout(r.Context(), logStreamMaxLifetime)
	defer cancel()

	rc, err := s.docker.OpenContainerLogs(streamCtx, c.FullID, url.Values{
		"stdout":     {"1"},
		"stderr":     {"1"},
		"timestamps": {"1"},
		"follow":     {"1"},
		"tail":       {strconv.Itoa(tail)},
	})
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to attach container log stream")
		return
	}
	defer rc.Close()

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	respCtrl := http.NewResponseController(w)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	_ = respCtrl.SetWriteDeadline(time.Now().Add(logStreamWriteTimeout))
	_, _ = w.Write([]byte(": connected\n\n"))
	flusher.Flush()

	lineCh := make(chan LogEntry, 64)
	go func() {
		defer close(lineCh)
		_, _ = ReadDockerLogStream(rc, c.IsTTY, 0, func(stream, line string) bool {
			entry := ParseDockerLogLine(c.Service, stream, line)
			select {
			case lineCh <- entry:
				return true
			case <-streamCtx.Done():
				return false
			}
		})
	}()

	heartbeat := time.NewTicker(logStreamHeartbeat)
	defer heartbeat.Stop()

	for {
		select {
		case <-streamCtx.Done():
			return
		case <-heartbeat.C:
			_ = respCtrl.SetWriteDeadline(time.Now().Add(logStreamWriteTimeout))
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		case entry, open := <-lineCh:
			if !open {
				return
			}
			data, err := json.Marshal(entry)
			if err != nil {
				continue
			}
			_ = respCtrl.SetWriteDeadline(time.Now().Add(logStreamWriteTimeout))
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
