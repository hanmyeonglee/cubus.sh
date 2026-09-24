FROM nginx:1.31-alpine3.24

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html favicon.ico humans.txt llms.txt robots.txt site.webmanifest sitemap.xml /usr/share/nginx/html/
COPY .well-known/ /usr/share/nginx/html/.well-known/
COPY static/ /usr/share/nginx/html/static/
