FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.31-alpine
# Defaults match docker-compose's backend service name/port, so local/CI usage needs no config.
# Render (or any other host) overrides these at runtime to point at wherever the backend actually is.
ENV BACKEND_HOST=backend BACKEND_PORT=4000
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
