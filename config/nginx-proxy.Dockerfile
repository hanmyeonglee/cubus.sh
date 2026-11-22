# syntax=docker/dockerfile:1
# Rebuild nginxproxy/nginx-proxy:1.11.6-alpine onto patched nginx:1.31.9-alpine3.24
# for nginx2root / nginx2shell (CVE-2026-123007, CVE-2026-123633, CVE-2026-123634,
# CVE-2026-121810, CVE-2026-113425). Switch back to an official nginxproxy/nginx-proxy
# tag once upstream publishes a release with nginx >= 1.31.9.
FROM nginxproxy/nginx-proxy:1.11.6-alpine AS upstream

FROM nginx:1.31.9-alpine3.24

ENV NGINX_PROXY_VERSION=1.11.6 \
    DOCKER_GEN_VERSION=0.17.2 \
    DOCKER_HOST=unix:///tmp/docker.sock

RUN apk add --no-cache --virtual .run-deps bash openssl

RUN printf '\ninclude /etc/nginx/toplevel.conf.d/*.conf;\n' >> /etc/nginx/nginx.conf \
    && sed -i 's/worker_connections.*;$/worker_connections   10240;/' /etc/nginx/nginx.conf \
    && sed -i -e '/^\}$/{s//\}\nworker_rlimit_nofile 20480;/;:a' -e '$!N;$!ba' -e '}' /etc/nginx/nginx.conf \
    && mkdir -p /etc/nginx/toplevel.conf.d /etc/nginx/dhparam /etc/nginx/certs /usr/share/nginx/html/errors

COPY --from=upstream /usr/local/bin/forego /usr/local/bin/forego
COPY --from=upstream /usr/local/bin/docker-gen /usr/local/bin/docker-gen
COPY --from=upstream /etc/nginx/network_internal.conf /etc/nginx/network_internal.conf
COPY --from=upstream /app /app

WORKDIR /app/

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["forego", "start", "-r"]
