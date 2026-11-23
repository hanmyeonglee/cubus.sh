FROM golang:1.27.3-alpine3.24 AS builder

WORKDIR /src
COPY go.mod ./
COPY *.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ops-agent .

# Pinned Debian slim image provides glibc + /sbin/ldconfig for NVIDIA Container
# Toolkit's injected nvidia-smi / libnvidia-ml.so.1 when utility capability is enabled.
# Runs as UID 0 (like db-broker) so mounted /var/run/docker.sock (0660 root:docker)
# is accessible; container is isolated on internal admin network with read_only + cap_drop ALL.
FROM debian:12.11-slim

COPY --from=builder /out/ops-agent /ops-agent

EXPOSE 9091

ENTRYPOINT ["/ops-agent"]
