FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.31-alpine
# Default matches docker-compose's backend service, so local/CI usage needs no config.
# Render (or any other host) overrides this at runtime to point at wherever the backend actually is.
ENV BACKEND_URL=http://backend:4000
# Exposes the container's DNS server as NGINX_LOCAL_RESOLVERS for nginx.conf.template's `resolver`.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
