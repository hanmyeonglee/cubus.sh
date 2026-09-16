FROM nginx:1.31-alpine3.24

COPY sites/main/ /usr/share/nginx/html/
