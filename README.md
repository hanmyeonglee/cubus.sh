# cubus.sh

The main page of [cubus.sh](https://cubus.sh), served from `sites/main/`.

## Deploy

1. Copy `.env.example` to `.env` and set `TUNNEL_TOKEN` to the token for a remotely managed Cloudflare Tunnel. Leave `TUNNEL_PROTOCOL=auto` unless UDP port 7844 is known to be available.
2. In Cloudflare, route `cubus.sh` and each site's public hostname to `http://nginx-proxy:80`.
3. After cloning, use `git clone --recurse-submodules`. For an existing checkout, run `git submodule sync --recursive && git submodule update --init --recursive` after pulling. Then start the stack from the repository root with `docker compose up --build -d`.

The root Compose stack runs the main static site, `simprobs`, `nginx-proxy`, and `cloudflared`. Each site keeps its own Dockerfile and source in its repository; the root Compose file registers the site service and builds from that submodule. Add one service entry to the root Compose file for each new site. Keep `.env` out of Git.

The `tunnel` Docker network uses `172.30.0.0/24` so nginx can trust `CF-Connecting-IP` only from that network. Check that this subnet does not overlap a host, VPN, or existing Docker network before the first deployment. Changing an existing deployment to this subnet requires the Compose network to be recreated.

The services use Docker's rotating `local` log driver. Each container retains at most five 10 MB log segments. Proxy access logs are emitted as JSON and include the virtual host, restored client IP, Cloudflare Ray ID, request time, and upstream response time.

## HTTP/3 and IPv6

Client-facing HTTP/3 and IPv6 terminate at Cloudflare, not at the nginx containers. Enable HTTP/3 under **Cloudflare > Speed > Settings > Protocol Optimization** and keep **IPv6 Compatibility** enabled. An `alt-svc` response header advertising `h3` confirms HTTP/3 availability; a first request may still use HTTP/2.

The Tunnel transport defaults to `auto`, which can use QUIC over UDP port 7844 and fall back to HTTP/2. Set `TUNNEL_PROTOCOL=quic` only when UDP port 7844 is allowed and a forced-QUIC failure is acceptable. Enabling HTTP/3 on `nginx-proxy` itself would not affect visitors because `cloudflared` reaches it over private HTTP.
