# syntax=docker/dockerfile:1
FROM golang:1.27.3-alpine3.24 AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/db-broker .

FROM scratch

COPY --from=builder /out/db-broker /db-broker

EXPOSE 8080
ENTRYPOINT ["/db-broker"]
