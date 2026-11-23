package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const nvidiaSMITimeout = 3 * time.Second

type CPUStats struct {
	UsagePct float64 `json:"usage_pct"`
	Cores    int     `json:"cores"`
	Load1    float64 `json:"load_1"`
	Load5    float64 `json:"load_5"`
	Load15   float64 `json:"load_15"`
}

type MemoryStats struct {
	TotalBytes     uint64  `json:"total_bytes"`
	UsedBytes      uint64  `json:"used_bytes"`
	AvailableBytes uint64  `json:"available_bytes"`
	UsagePct       float64 `json:"usage_pct"`
	SwapTotalBytes uint64  `json:"swap_total_bytes"`
	SwapUsedBytes  uint64  `json:"swap_used_bytes"`
}

type DiskStats struct {
	MountHint      string  `json:"mount_hint"`
	TotalBytes     uint64  `json:"total_bytes"`
	UsedBytes      uint64  `json:"used_bytes"`
	AvailableBytes uint64  `json:"available_bytes"`
	UsagePct       float64 `json:"usage_pct"`
}

type ThermalSensor struct {
	Name  string  `json:"name"`
	TempC float64 `json:"temp_c"`
}

type GPUDevice struct {
	Index         int      `json:"index"`
	Name          string   `json:"name"`
	UUID          string   `json:"uuid"`
	UtilPct       *float64 `json:"util_pct,omitempty"`
	MemUtilPct    *float64 `json:"mem_util_pct,omitempty"`
	MemUsedMiB    *float64 `json:"mem_used_mib,omitempty"`
	MemTotalMiB   *float64 `json:"mem_total_mib,omitempty"`
	TempC         *float64 `json:"temp_c,omitempty"`
	PowerDrawW    *float64 `json:"power_draw_w,omitempty"`
	PowerLimitW   *float64 `json:"power_limit_w,omitempty"`
	DriverVersion string   `json:"driver_version,omitempty"`
}

type GPUStats struct {
	Available bool        `json:"available"`
	Devices   []GPUDevice `json:"devices,omitempty"`
	Note      string      `json:"note,omitempty"`
}

type DockerDiskUsage struct {
	ImagesBytes     int64     `json:"images_bytes"`
	ContainersBytes int64     `json:"containers_bytes"`
	VolumesBytes    int64     `json:"volumes_bytes"`
	BuildCacheBytes int64     `json:"build_cache_bytes"`
	TotalBytes      int64     `json:"total_bytes"`
	CollectedAt     time.Time `json:"collected_at"`
}

type HostInfo struct {
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	Kernel        string `json:"kernel"`
	UptimeSeconds int64  `json:"uptime_seconds"`
}

type MetricPoint struct {
	Timestamp  time.Time `json:"ts"`
	CPUPct     float64   `json:"cpu_pct"`
	MemPct     float64   `json:"mem_pct"`
	GPUUtilPct *float64  `json:"gpu_util_pct,omitempty"`
	GPUMemPct  *float64  `json:"gpu_mem_pct,omitempty"`
	GPUTempC   *float64  `json:"gpu_temp_c,omitempty"`
}

type SystemSnapshot struct {
	CollectedAt time.Time        `json:"collected_at"`
	Host        HostInfo         `json:"host"`
	CPU         CPUStats         `json:"cpu"`
	Memory      MemoryStats      `json:"memory"`
	Disk        DiskStats        `json:"disk"`
	DockerDF    *DockerDiskUsage `json:"docker_df,omitempty"`
	Thermals    []ThermalSensor  `json:"thermals,omitempty"`
	GPU         GPUStats         `json:"gpu"`
	History     []MetricPoint    `json:"history"`
}

type cpuSample struct {
	total uint64
	idle  uint64
	valid bool
}

type MetricRing struct {
	mu      sync.RWMutex
	points  []MetricPoint
	cap     int
	head    int
	count   int
	latest  SystemSnapshot
	hasSnap bool
}

func NewMetricRing(capacity int) *MetricRing {
	if capacity < 1 {
		capacity = defaultRingCapacity
	}
	return &MetricRing{
		points: make([]MetricPoint, capacity),
		cap:    capacity,
	}
}

func (r *MetricRing) Record(snap SystemSnapshot, pt MetricPoint) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.points[r.head] = pt
	r.head = (r.head + 1) % r.cap
	if r.count < r.cap {
		r.count++
	}
	snap.History = nil
	r.latest = snap
	r.hasSnap = true
}

func (r *MetricRing) Snapshot() (SystemSnapshot, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if !r.hasSnap {
		return SystemSnapshot{}, false
	}
	out := r.latest
	hist := make([]MetricPoint, r.count)
	start := (r.head - r.count + r.cap) % r.cap
	for i := range r.count {
		hist[i] = r.points[(start+i)%r.cap]
	}
	out.History = hist
	return out, true
}

type HostCollector struct {
	osReleasePath string
	hostInfoFn    func(context.Context) (DockerHostInfo, error)
	dockerDFFn    func() *DockerDiskUsage
	nvidiaFn      func(context.Context) GPUStats

	mu      sync.Mutex
	prevCPU cpuSample
}

func NewHostCollector(osReleasePath string, hostInfoFn func(context.Context) (DockerHostInfo, error), dockerDFFn func() *DockerDiskUsage) *HostCollector {
	return &HostCollector{
		osReleasePath: osReleasePath,
		hostInfoFn:    hostInfoFn,
		dockerDFFn:    dockerDFFn,
		nvidiaFn:      collectNVIDIAGPU,
	}
}

// PrimeCPUBaseline takes an initial /proc/stat reading so the first visible
// snapshot reports accurate CPU utilization instead of 0%.
func (c *HostCollector) PrimeCPUBaseline() {
	if s, err := readProcStat("/proc/stat"); err == nil {
		c.mu.Lock()
		c.prevCPU = s
		c.mu.Unlock()
	}
}

func (c *HostCollector) Collect(ctx context.Context) (SystemSnapshot, MetricPoint) {
	now := time.Now().UTC()

	cpuPct := 0.0
	if cur, err := readProcStat("/proc/stat"); err == nil {
		c.mu.Lock()
		if c.prevCPU.valid {
			cpuPct = computeCPUDeltaPct(c.prevCPU, cur)
		}
		c.prevCPU = cur
		c.mu.Unlock()
	}

	l1, l5, l15 := readLoadAvg("/proc/loadavg")
	mem := readMemInfo("/proc/meminfo")
	uptimeSec := readUptime("/proc/uptime")
	osPretty := readOSPrettyName(c.osReleasePath)
	disk := readDiskStatfs(c.osReleasePath)
	thermals := readThermalSensors()

	host := HostInfo{
		OS:            osPretty,
		Kernel:        readTrimmedFile("/proc/sys/kernel/osrelease"),
		UptimeSeconds: uptimeSec,
	}
	cores := runtime.NumCPU()
	if c.hostInfoFn != nil {
		if di, err := c.hostInfoFn(ctx); err == nil {
			if di.Name != "" {
				host.Hostname = di.Name
			}
			if host.OS == "" && di.OperatingSystem != "" {
				host.OS = di.OperatingSystem
			}
			if host.Kernel == "" && di.KernelVersion != "" {
				host.Kernel = di.KernelVersion
			}
			if di.NCPU > 0 {
				cores = di.NCPU
			}
		}
	}
	if host.Hostname == "" {
		host.Hostname = readTrimmedFile("/proc/sys/kernel/hostname")
	}

	var df *DockerDiskUsage
	if c.dockerDFFn != nil {
		df = c.dockerDFFn()
	}

	gpu := GPUStats{Available: false}
	if c.nvidiaFn != nil {
		gpu = c.nvidiaFn(ctx)
	}

	snap := SystemSnapshot{
		CollectedAt: now,
		Host:        host,
		CPU: CPUStats{
			UsagePct: round1(cpuPct),
			Cores:    cores,
			Load1:    l1,
			Load5:    l5,
			Load15:   l15,
		},
		Memory:   mem,
		Disk:     disk,
		DockerDF: df,
		Thermals: thermals,
		GPU:      gpu,
	}

	pt := MetricPoint{
		Timestamp: now,
		CPUPct:    snap.CPU.UsagePct,
		MemPct:    snap.Memory.UsagePct,
	}
	if gpu.Available && len(gpu.Devices) > 0 {
		dev := gpu.Devices[0]
		pt.GPUUtilPct = dev.UtilPct
		pt.GPUTempC = dev.TempC
		if dev.MemUsedMiB != nil && dev.MemTotalMiB != nil && *dev.MemTotalMiB > 0 {
			pct := round1((*dev.MemUsedMiB / *dev.MemTotalMiB) * 100.0)
			pt.GPUMemPct = &pct
		}
	}
	return snap, pt
}

func readProcStat(path string) (cpuSample, error) {
	f, err := os.Open(path)
	if err != nil {
		return cpuSample{}, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return cpuSample{}, errors.New("empty /proc/stat")
	}
	return parseProcStatLine(sc.Text())
}

func parseProcStatLine(line string) (cpuSample, error) {
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSample{}, errors.New("unexpected /proc/stat cpu line")
	}
	var vals []uint64
	for _, f := range fields[1:] {
		v, err := strconv.ParseUint(f, 10, 64)
		if err != nil {
			return cpuSample{}, err
		}
		vals = append(vals, v)
	}
	var total uint64
	for _, v := range vals {
		total += v
	}
	idle := vals[3]
	if len(vals) > 4 {
		idle += vals[4] // iowait
	}
	return cpuSample{total: total, idle: idle, valid: true}, nil
}

func computeCPUDeltaPct(prev, curr cpuSample) float64 {
	if curr.total <= prev.total {
		return 0
	}
	totalDelta := curr.total - prev.total
	var idleDelta uint64
	if curr.idle >= prev.idle {
		idleDelta = curr.idle - prev.idle
	}
	if idleDelta >= totalDelta {
		return 0
	}
	return float64(totalDelta-idleDelta) / float64(totalDelta) * 100.0
}

func readLoadAvg(path string) (float64, float64, float64) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, 0
	}
	fields := strings.Fields(string(b))
	if len(fields) < 3 {
		return 0, 0, 0
	}
	l1, _ := strconv.ParseFloat(fields[0], 64)
	l5, _ := strconv.ParseFloat(fields[1], 64)
	l15, _ := strconv.ParseFloat(fields[2], 64)
	return l1, l5, l15
}

func readMemInfo(path string) MemoryStats {
	b, err := os.ReadFile(path)
	if err != nil {
		return MemoryStats{}
	}
	return parseMemInfo(string(b))
}

func parseMemInfo(content string) MemoryStats {
	kv := make(map[string]uint64, 16)
	for _, line := range strings.Split(content, "\n") {
		k, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		kv[strings.TrimSpace(k)] = v * 1024 // KiB -> bytes
	}
	total := kv["MemTotal"]
	avail := kv["MemAvailable"]
	if avail == 0 {
		avail = kv["MemFree"] + kv["Buffers"] + kv["Cached"]
	}
	var used uint64
	if total >= avail {
		used = total - avail
	}
	pct := 0.0
	if total > 0 {
		pct = round1(float64(used) / float64(total) * 100.0)
	}
	swapTotal := kv["SwapTotal"]
	swapFree := kv["SwapFree"]
	var swapUsed uint64
	if swapTotal >= swapFree {
		swapUsed = swapTotal - swapFree
	}
	return MemoryStats{
		TotalBytes:     total,
		UsedBytes:      used,
		AvailableBytes: avail,
		UsagePct:       pct,
		SwapTotalBytes: swapTotal,
		SwapUsedBytes:  swapUsed,
	}
}

func readUptime(path string) int64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	f, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || f < 0 {
		return 0
	}
	return int64(f)
}

func readOSPrettyName(primaryPath string) string {
	paths := []string{primaryPath, "/etc/os-release"}
	for _, p := range paths {
		if p == "" {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"' `)
			}
		}
	}
	return ""
}

func readDiskStatfs(primaryPath string) DiskStats {
	target := primaryPath
	hint := "host root filesystem"
	if target == "" {
		target = "/"
		hint = "container root filesystem (/)"
	} else if _, err := os.Stat(target); err != nil {
		target = "/"
		hint = "container root filesystem (/)"
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(target, &st); err != nil {
		return DiskStats{MountHint: hint}
	}
	bsize := uint64(st.Frsize)
	if bsize == 0 {
		bsize = uint64(st.Bsize)
	}
	total := st.Blocks * bsize
	free := st.Bfree * bsize
	avail := st.Bavail * bsize
	var used uint64
	if total >= free {
		used = total - free
	}
	pct := 0.0
	if total > 0 {
		pct = round1(float64(used) / float64(total) * 100.0)
	}
	return DiskStats{
		MountHint:      hint,
		TotalBytes:     total,
		UsedBytes:      used,
		AvailableBytes: avail,
		UsagePct:       pct,
	}
}

// readThermalSensors reads non-namespaced container /sys thermal and hwmon sensors.
func readThermalSensors() []ThermalSensor {
	var sensors []ThermalSensor
	seen := make(map[string]struct{})

	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*")
	for _, z := range zones {
		rawTemp := readTrimmedFile(filepath.Join(z, "temp"))
		if rawTemp == "" {
			continue
		}
		milli, err := strconv.ParseFloat(rawTemp, 64)
		if err != nil || milli <= 0 || milli > 150000 {
			continue
		}
		name := readTrimmedFile(filepath.Join(z, "type"))
		if name == "" {
			name = filepath.Base(z)
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		sensors = append(sensors, ThermalSensor{
			Name:  name,
			TempC: round1(milli / 1000.0),
		})
		if len(sensors) >= 8 {
			return sensors
		}
	}

	if len(sensors) == 0 {
		inputs, _ := filepath.Glob("/sys/class/hwmon/hwmon*/temp*_input")
		for _, inp := range inputs {
			rawTemp := readTrimmedFile(inp)
			milli, err := strconv.ParseFloat(rawTemp, 64)
			if err != nil || milli <= 0 || milli > 150000 {
				continue
			}
			dir := filepath.Dir(inp)
			chip := readTrimmedFile(filepath.Join(dir, "name"))
			labelFile := strings.TrimSuffix(inp, "_input") + "_label"
			label := readTrimmedFile(labelFile)
			name := strings.TrimSpace(chip + " " + label)
			if name == "" {
				name = filepath.Base(inp)
			}
			if _, dup := seen[name]; dup {
				continue
			}
			seen[name] = struct{}{}
			sensors = append(sensors, ThermalSensor{
				Name:  name,
				TempC: round1(milli / 1000.0),
			})
			if len(sensors) >= 8 {
				break
			}
		}
	}
	return sensors
}

func collectNVIDIAGPU(ctx context.Context) GPUStats {
	path, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return GPUStats{Available: false, Note: "nvidia-smi not present"}
	}
	runCtx, cancel := context.WithTimeout(ctx, nvidiaSMITimeout)
	defer cancel()

	cmd := exec.CommandContext(
		runCtx,
		path,
		"--query-gpu=index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit,driver_version",
		"--format=csv,noheader,nounits",
	)
	out, err := cmd.Output()
	if err != nil {
		return GPUStats{Available: false, Note: "nvidia-smi unavailable"}
	}
	devices := parseNVIDIASMICSV(string(out))
	if len(devices) == 0 {
		return GPUStats{Available: false, Note: "no NVIDIA GPUs reported"}
	}
	return GPUStats{Available: true, Devices: devices}
}

// parseNVIDIASMICSV tolerates [N/A] / [Not Supported] fields per device so partial sensor support never breaks GPU telemetry.
func parseNVIDIASMICSV(raw string) []GPUDevice {
	r := csv.NewReader(strings.NewReader(raw))
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true
	records, err := r.ReadAll()
	if err != nil {
		return nil
	}
	var devices []GPUDevice
	for _, parts := range records {
		if len(parts) < 11 {
			continue
		}
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		idx, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		devices = append(devices, GPUDevice{
			Index:         idx,
			Name:          parts[1],
			UUID:          parts[2],
			UtilPct:       parseOptionalFloat(parts[3]),
			MemUtilPct:    parseOptionalFloat(parts[4]),
			MemUsedMiB:    parseOptionalFloat(parts[5]),
			MemTotalMiB:   parseOptionalFloat(parts[6]),
			TempC:         parseOptionalFloat(parts[7]),
			PowerDrawW:    parseOptionalFloat(parts[8]),
			PowerLimitW:   parseOptionalFloat(parts[9]),
			DriverVersion: parts[10],
		})
	}
	return devices
}

func parseOptionalFloat(s string) *float64 {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "[") {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	r := round1(v)
	return &r
}

func readTrimmedFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(bytes.TrimSpace(b))
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
