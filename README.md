# cubus.sh

The main page of [cubus.sh](https://cubus.sh), served from `sites/main/`.

## Deploy

1. Copy `.env.example` to `.env` and set `TUNNEL_TOKEN` to the token for a remotely managed Cloudflare Tunnel.
2. In Cloudflare, route the public hostname `cubus.sh` to `http://nginx-proxy:80`.
3. Run `docker compose up --build -d`.

The Compose stack runs the main static site, `nginx-proxy`, and `cloudflared`. It does not publish ports on the host; Cloudflare Tunnel connects to the proxy over the private Docker network. Keep `.env` out of Git.
