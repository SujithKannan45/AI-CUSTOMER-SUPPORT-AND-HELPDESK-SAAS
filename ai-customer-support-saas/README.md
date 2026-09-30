# AI Customer Support & Helpdesk SaaS

A multi-tenant, AI-powered customer support platform: businesses get workspaces
with support agents, customers, tickets, real-time conversations, a knowledge
base, and an AI agent that answers from their own documents — with human
handoff when confidence is low.

This repository currently contains **Phase 1 — the production architecture and
repository foundation**: a secured, versioned REST API and a professional
React application shell. Feature phases build on top of it (see
[Future phases](#future-phases)).

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, React Router 7, Tailwind CSS 4, Framer Motion, Zustand |
| Backend | Node.js 22, Express 5, TypeScript (strict), Zod validation |
| Database | MongoDB 7 via Mongoose 8 |
| Real-time | Architecture prepared for Socket.IO (same-port HTTP server, typed events) |
| AI | Provider-agnostic interfaces (`RagService`, `EmbeddingService`) — no SDK coupled |
| Storage | `StorageService` contract — S3 adapter plugs in without touching feature code |
| DevOps | Docker multi-stage builds, Docker Compose, nginx, pino structured logs (CloudWatch-ready) |

## Repository structure

```
ai-customer-support-saas/
├── client/                 # React SPA
│   └── src/
│       ├── app/            # App root, router, cross-app components
│       ├── components/     # ui/ (design-system) + feedback/ (states, boundaries)
│       ├── features/       # Feature modules (auth, tickets, …) — populated per phase
│       ├── hooks/          # Reusable React hooks
│       ├── layouts/        # App shell (sidebar, header, responsive drawer)
│       ├── pages/          # Route-level pages
│       ├── services/       # Typed API clients (one per backend module)
│       ├── store/          # Zustand global state (UI state only)
│       ├── styles/         # Tailwind v4 theme tokens
│       ├── types/          # Shared API contracts
│       └── utils/          # Pure helpers
├── server/                 # REST API
│   └── src/
│       ├── config/         # Validated env config (Zod) — no process.env elsewhere
│       ├── core/           # errors/ http/ lifecycle/ logger/ middlewares/ utils/
│       ├── database/       # Mongo connection lifecycle
│       ├── modules/        # Feature modules (health implemented; seams for ai/documents)
│       ├── routes/         # Versioned API assembly point (/api/v1)
│       ├── sockets/        # Prepared for Socket.IO (contracts documented)
│       ├── jobs/           # Prepared for BullMQ background workers
│       ├── app.ts          # Express app factory
│       └── server.ts       # HTTP listener + graceful shutdown
├── docker/                 # Dockerfiles + nginx
├── docs/                   # architecture.md
├── scripts/                # dev-db.ts (Docker-less Mongo), verify-shutdown.ts
├── docker-compose.yml      # Local MongoDB (Redis commented for the jobs phase)
└── package.json            # npm workspaces root
```

### Deviations from the suggested structure (and why)

- **`client/` + `server/`** instead of `frontend/`/`backend/`: shorter, and
  conventional for MERN.
- **`core/` inside `server/src`** holds cross-cutting infrastructure (logging,
  errors, middleware), so feature modules never depend on each other — only on
  `core` and their own files.
- **Contracts-first seams**: `modules/ai/interfaces` and
  `modules/documents/storage` exist now as TypeScript interfaces so the AI,
  RAG, and S3 phases can be implemented behind stable ports (swap providers,
  fake them in tests) without refactoring feature code.
- **`docs/architecture.md`** captures system-design decisions (multi-tenancy
  strategy, RBAC model, real-time topology) rather than leaving them tribal.

## Prerequisites

- Node.js ≥ 22 (`.nvmrc` provided)
- Docker (for local MongoDB) — or any MongoDB 7 instance
- An AWS account only when the storage/deploy phases land

## Getting started

```bash
# 1. Install all workspaces
npm install

# 2. Environment
cp .env.example server/.env        # API config
cp .env.example client/.env        # optional — defaults work in dev

# 3. Database
npm run db:up                      # starts MongoDB via Docker Compose

# 4. Run both apps (or `npm run dev:server` / `npm run dev:client`)
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:8000/api/v1
- Health checks:
  - `GET /health` → liveness (`{ "status": "ok" }`)
  - `GET /health/ready` → readiness (503 when the database is unreachable)
  - The dashboard's status card exercises `/health/ready` end-to-end.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API + SPA concurrently |
| `npm run dev:server` / `npm run dev:client` | One app each |
| `npm run build` | Compile server (`tsc`) and bundle client (Vite) |
| `npm run typecheck` | Strict TS across both workspaces |
| `npm run lint` | ESLint (typed rules, zero warnings allowed) |
| `npm run verify` | typecheck + lint + build |
| `npm run db:up` / `npm run db:down` | Start/stop local MongoDB |
| `npm run db:memory` | Fallback in-memory Mongo when Docker is unavailable |

## Security posture (foundation)

- Secrets only via environment variables, validated at boot (fail-fast).
- Helmet security headers; CSP enabled in production.
- Strict CORS allow-list (no wildcard with credentials).
- Global + sensitive-route rate limiting (draft-8 headers).
- Centralized error pipeline: unknown errors become opaque 500s; validation
  errors return field-level details.
- Request correlation ids on every log line and error response.
- Non-root container user, read-only-friendly runtime.
- Authentication, RBAC, and tenant-isolation middleware have designated
  insertion points in `app.ts` (see `docs/architecture.md`).

## Future phases

1. **Auth & tenancy** — users, workspaces, JWT access/refresh rotation, RBAC,
   tenant-scoped repositories.
2. **Core support desk** — customers, tickets, conversations, notifications.
3. **Real-time** — Socket.IO on the existing HTTP server; typed event
   contracts; workspace rooms.
4. **Knowledge base & documents** — S3 storage adapter, upload pipeline,
   background ingestion workers (BullMQ + Redis).
5. **AI & RAG** — embedding + RAG service implementations behind the existing
   interfaces; confidence-based human handoff.
6. **Analytics & audit** — usage dashboards, immutable audit log.
7. **Production** — ECS/Fargate or EC2 via Terraform, CI/CD, CloudWatch
   dashboards and alarms.
