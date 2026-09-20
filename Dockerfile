FROM nginx:1.31-alpine3.24

COPY config/main-nginx.conf /etc/nginx/conf.d/default.conf
COPY sites/main/ /usr/share/nginx/html/
