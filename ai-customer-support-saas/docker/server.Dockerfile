# ── Stage 1: build ────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Workspaces: copy manifests first for better layer caching.
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace server --include-workspace-root=false

COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build --workspace server && \
    npm ci --workspace server --omit=dev --include-workspace-root=false

# ── Stage 2: runtime ──────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Drop privileges — never run the container as root.
RUN addgroup -S app && adduser -S app -G app
USER app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/server/dist ./server/dist
COPY --from=build --chown=app:app /app/server/package.json ./server/

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/server.js"]
