# Architecture

Decisions that shape how every future phase plugs in. Written down so future
contributors (and interviewers) can trace *why*.

## Layered backend

```
Routes (declarative wiring)
  → Controller (HTTP shape only)
    → Service (business rules, throws AppError)
      → Repository (all Mongoose queries)
        → Model (schema, tenant index)
```

- Controllers translate HTTP ↔ service calls; no business rules.
- Services throw `AppError` subclasses; the single error middleware is the
  only place that maps errors to responses.
- Repositories may not leak Mongoose documents past the service layer.

## Multi-tenancy strategy (shared pool)

One database, shared collections, **`workspaceId` discriminator on every
tenant-owned document + compound indexes that lead with `workspaceId`**.

Why shared-pool over database-per-tenant at this stage: cheapest to operate,
one migration path, and Mongo's indexes keep isolation enforced at query time
via mandatory repository scopes. Every tenant-owned schema will:

- require a `workspaceId` (ObjectId ref `Workspace`),
- declare `{ workspaceId: 1, <naturalKey>: 1 }` unique compound indexes,
- be accessed through repositories that *always* filter by `workspaceId`,
- (later) be covered by a tenant-isolation regression test.

Database-per-tenant remains an escape hatch for enterprise isolation demands;
the repository layer is where that switch would happen.

## RBAC model

`User.memberships[] = { workspaceId, role }` — one identity, per-workspace
roles. Roles planned: `owner`, `admin`, `agent`, `viewer`; customer "end
users" are a separate collection, not a role.

- `requireAuth` (JWT verify → req.user) then `requireRole(...roles)` and
  `requireWorkspaceAccess(paramName)` guard chains per route.
- Authorization checks live in middleware + services, never in controllers.

## API conventions

- Versioned prefix `/api/v1` (assembly point: `routes/api.routes.ts`).
- Success: `{ success: true, data }`; error: `{ success: false, error: { code, message, details? } }`.
- Errors use stable machine codes (`VALIDATION_ERROR`, `DUPLICATE_KEY`, …).
- Every response carries `X-Request-Id` for log correlation.

## Validation

Zod schemas per module (`<feature>.validation.ts`) applied declaratively via
`validate(schema, source)` at the route. Handlers receive parsed, typed data;
Zod errors render as 422 with field errors through the central error pipeline.

## Real-time (prepared)

Socket.IO attaches to the existing HTTP server (no second port). Handshake JWT
auth → `socket.data = { userId, workspaceId, role }`; rooms are
`workspace:{id}` / `conversation:{id}`; a socket can only join rooms inside
its workspace. Typed `ClientToServerEvents`/`ServerToClientEvents` shared with
the client. Details: `server/src/sockets/README.md`.

## Background jobs (prepared)

BullMQ + Redis for: document ingestion (chunk → embed → index), notification
fan-out, analytics rollups, stale-ticket sweeps. Queues outlive deploys and
give retries/backoff for AI-provider calls. Details: `server/src/jobs/README.md`.

## AI seam

Feature code depends only on `RagService` / `EmbeddingService` /
`StorageService` interfaces (in `modules/*/interfaces`). Provider SDKs
(OpenAI, Gemini, Bedrock…) are implementation details behind a registry —
swappable per environment and fakeable in tests. The AI phase adds
`AiProvider` implementations plus an ingestion worker; no feature module
imports an SDK directly.

## Storage seam

`StorageService` interface with presigned upload/download + delete. Production
driver: S3 (+ CloudFront for delivery, SSE for encryption, lifecycle rules for
retention). Development driver: local disk — same interface, zero feature-code
changes.

## Security architecture

- **Config**: Zod-validated env, fail-fast boot, no `process.env` outside config.
- **HTTP**: Helmet (CSP in production), strict CORS allow-list, body limits,
  draft-8 rate-limit headers, trust-proxy=1 for correct client IPs behind ALB.
- **Errors**: internal messages never leak (opaque 500s in production);
  operational errors logged at warn, 5xx at error with stack.
- **Tenancy**: isolation enforced in the data layer (mandatory workspace
  scoping), not by frontend filtering.
- **Audit**: every tenant mutation will append to an immutable `AuditLog`
  collection via a service-level helper in the audit phase.
- **Container**: non-root user, minimal alpine base, pinned tags, healthchecks.

## Client architecture

- Feature-first: `features/<domain>/` will hold each domain's pages,
  components, hooks, and `services/<domain>.service.ts` API client.
- Components: `components/ui` (design system: Button, Input, Badge, Card…)
  and `components/feedback` (states, boundary) — the only place allowed to
  know Tailwind class combinations; features compose them.
- State: Zustand only for genuinely global UI state; server data will flow
  through typed services + React Query when the data phases begin.
- Routing: React Router 7 data router; feature routes are code-split; the
  auth guard wraps protected subtrees once auth lands.
- Error containment: `ErrorBoundary` at the app root; states (`LoadingState`,
  `ErrorState`, `EmptyState`) keep async surfaces consistent.
- Design tokens in `styles/global.css` (@theme): brand, ink, success/warning/
  danger palettes drive utilities like `bg-brand-600`, `text-ink-500`.

## Monitoring (prepared)

Structured JSON logs (pino) with request ids map 1:1 to CloudWatch Logs
Insights queries; `/health` and `/health/ready` map to ALB target-group
health checks (liveness vs readiness separation). ECS task + ALB 5xx + p95
latency alarms are a deploy-phase task on top of this foundation.
