# ── Stage 1: build the SPA ────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json client/
RUN npm ci --workspace client --include-workspace-root=false

COPY client/ client/
RUN npm run build --workspace client

# ── Stage 2: nginx runtime ────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
