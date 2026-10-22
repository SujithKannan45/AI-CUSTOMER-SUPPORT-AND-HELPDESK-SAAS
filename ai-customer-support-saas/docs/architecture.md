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

`WorkspaceMember` collection — one row per (workspace, user) holding the
per-workspace role. Roles (centralized in
`modules/workspaces/workspace.types.ts`): `owner`, `admin`, `agent`,
`viewer` (Prompt 6 added viewer; enums are tuples, so widening is app safe).
Customer "end users" are a separate collection (`customers`), never members.

Authorization has three composable layers, all in one decision pipeline:

```
requireAuth (JWT → req.auth)
  → validate(schema, 'params')
  → requireWorkspaceContext()      — loads workspace + membership,
                                     both must be active; failures 404
                                     (no existence oracle)
  → requirePermission(permission)  — 403 + audit decision (modules/rbac)
```

1. **Permission registry** (`modules/rbac/rbac.permissions.ts`) — the ONLY
   place mapping roles to permissions (`workspace.view`,
   `workspace.settings.update`, `workspace.security.manage`, `ticket.*`,
   `customer.*` …). Grant = explicit entry; absence = denial (least
   privilege: new permissions default to denied for every role). Rationale
   for each grant lives in the file. Controllers/services never compare
   role names.
2. **Membership policy** (`modules/rbac/rbac-policy.ts`) — pure evaluators
   that make membership escalation structurally impossible for future
   member-administration endpoints: no self role changes, owner rows are
   immutable through ordinary flows, admins can only administer + assign
   strictly-lower roles, ordinary operations never mint or destroy owners
   (single-owner invariant is additionally DB-enforced by the partial
   unique index). Reserved audit actions export alongside it.
3. **Resource-assignment helpers** (`modules/rbac/resource-access.ts`) —
   the assignment CAP for ticket/customer/conversation modules: agents may
   modify only resources assigned to them (per-module `allowCreator` /
   `allowUnassignedAgents` knobs always default FALSE); viewer/permission-
   less roles are never granted via assignment; cross-workspace resources
   are rejected (`assertSameWorkspace`).

- `requireWorkspaceContext()` (Prompt 5) — the tenant gate that attaches
  typed `req.workspace` = { workspace, membership, role }. The RBAC
  middleware derives the effective role ONLY from that DB-validated
  membership row — never from body, query or headers (client-supplied role
  values are stripped/ignored). The `ownerId` user is treated as owner as
  defense-in-depth for corrupted membership rows (logged anomaly).
- Authorization failures: 401 unauthenticated, 404 concealment for
  strangers/inactive memberships, 403 for insufficient permission; denials
  of permission-guarded operations append `workspace.permission_denied` to
  the immutable AuditLog (actor/workspace/metadata only — never secrets).
- The database enforces invariants the app must not be able to break: one
  membership per (workspace, user) and at most one `owner` per workspace
  (partial unique index).

Prompt 6 endpoints secured: `GET /workspaces/:id` (workspace.view),
`PATCH /workspaces/:id` (workspace.settings.update — owner + admin).
Membership administration endpoints are intentionally absent (later phase)
but their policy layer, validators and audit hooks are ready.

## Ticket management (Prompt 8, implemented)

Every endpoint is workspace-scoped
(`Base path: /api/v1/workspaces/:workspaceId/tickets`, gate:
`requireAuth → validate(params) → requireWorkspaceContext →
requirePermission`):

```
POST   /                     ticket.create
GET    /                     ticket.read
GET    /:ticketId            ticket.read
PATCH  /:ticketId            ticket.update  + agent assignment CAP
PATCH  /:ticketId/status     ticket.update  + lifecycle law
PATCH  /:ticketId/assignment ticket.assign  (owner/admin only)
PATCH  /:ticketId/priority   ticket.update  + agent assignment CAP
POST   /:ticketId/resolve    ticket.update + RESOLVED transition (+ optional note)
POST   /:ticketId/reopen     ticket.update + back-to-OPEN transition
POST   /:ticketId/archive    ticket.update (soft-delete stamp)
```

- **Lifecycle law** (`TICKET_STATUS_TRANSITIONS` in `ticket.types.ts`) —
  status changes are validated transitions only; illegal moves are 409
  `INVALID_STATUS_TRANSITION` with the allowed targets in `details`. Closed
  tickets may only return to OPEN. `resolvedAt`/`closedAt` are stamped on
  entry and cleared on exit — the one deliberate exception: RESOLVED →
  CLOSED retains `resolvedAt`. Resolve/reopen are idempotent-guided
  transitions and audit nothing when no net change occurred.
- **Agent cap** (`evaluateResourceModification`, `allowCreator: true`) —
  agents may modify only tickets ASSIGNED to them or CREATED by them;
  owner/admin pass as privileged triage roles; viewers have no update
  permission at all. Assignees are verified as ACTIVE members of the SAME
  workspace with an agent-or-above role (one uniform validation response —
  no cross-workspace membership oracle).
- **Tenant isolation** — the repository composes EVERY query from the
  server-side `workspaceId`; tickets are never looked up globally and then
  authorized. Foreign ticket ids read as 404 on any route. Server-side
  cross-reference checks (customers, assignees) reject foreign ids with a
  uniform not-found/validation contract.
- **Numbering** — atomic per-workspace counter + unique
  `{ workspaceId, number }` index; lost allocation races retry. Details in
  the data-model doc.
- **Audit actions** — `ticket.created`, `ticket.updated`,
  `ticket.status_changed`, `ticket.assigned`/`ticket.unassigned`,
  `ticket.priority_changed`, `ticket.resolved`, `ticket.reopened`,
  `ticket.archived`. Metadata carries state names/ids and field NAMES only —
  never subject/description/resolution-note/customer PII.

Data-model details (collections, indexes, soft-delete decisions): see
[docs/data-model.md](data-model.md).

## Conversations & messages (Prompt 9, implemented)

Every endpoint is workspace-scoped, mounted alongside the ticket routes in
`routes/api.routes.ts` (gate: `requireAuth → validate(params) →
requireWorkspaceContext → requirePermission`):

```
POST   …/tickets/:ticketId/conversations                  conversation.reply   (get-or-create the ONE primary conversation)
GET    …/tickets/:ticketId/conversations                  conversation.view    (paginated list for a ticket)
GET    …/conversations/:conversationId                    conversation.view
POST   …/conversations/:conversationId/messages           conversation.reply   (public reply / internal note)
GET    …/conversations/:conversationId/messages           conversation.view    (chronological thread page)
GET    …/conversations/:conversationId/messages/:messageId conversation.view   (authorized single message)
PATCH  …/conversations/:conversationId/messages/:messageId conversation.reply  (sender-only body edit)
```

- **One primary conversation per ticket** — `{ workspaceId, ticketId }`
  unique index; concurrent get-or-create races lose safely and return the
  existing conversation with `created: false`. No second ticket lifecycle:
  conversations carry NO status — when the ticket is archived, its
  conversation and messages read as 404 everywhere (a live-ticket check
  runs on every flow, not just creation).
- **Sender identity is server-derived** — `req.auth` + the validated
  membership compose the sender (`senderType: 'AGENT'` today). Payloads are
  structurally incapable of carrying `workspaceId`, `ticketId`,
  `customerId`, `senderId`, `senderType` or `visibility` after send (strict
  Zod schemas reject them). `visibility` is chosen at SEND time only and is
  immutable afterwards.
- **Internal notes are staff-only BY DERIVATION** — only roles holding
  `conversation.reply` (owner/admin/agent) reach message sending, so an
  internal note can only exist by a staff action. Read-side, roles without
  the permission get internal notes excluded IN THE QUERY (never returned
  and scrubbed) and a 403 on direct internal reads. No customer-portal
  authentication exists yet (documented dependency): customers cannot send
  or read anything in this phase — customer identity flows are reserved
  types, never fabricated from a client-supplied customerId.
- **Agent cap** — owners/admins may send on any ticket in their workspace
  (triage roles); agents may send only on tickets ASSIGNED to them or
  OPENED by them (`evaluateResourceModification` with `allowCreator: true`,
  identical to the ticket module's rule); viewers are structurally denied
  any write (get-or-create and sending require `reply`, a permission viewer
  does not hold).
- **Tenant isolation** — repositories compose every query from the
  server-side `workspaceId` AND its parent resource (message lookups are
  `{ workspaceId, conversationId, _id }` scoped); foreign conversation or
  message ids read as 404 with no cross-tenant existence oracle.
- **Consistency (documented honestly)** — no multi-document transactions in
  this deployment. Message insert is document-atomic; the conversation's
  last-message metadata update is advisory: on failure the message remains
  authoritative, the failure is logged, and the next authorized thread read
  self-heals the metadata from the newest message. Audit appends follow the
  project-wide fire-and-forget convention. Ticket status/assignment are
  deliberately untouched by messaging.
- **Edit policy** — the only history-changing operation supported is a
  body-only edit by the ORIGINAL sender (all edits audited as
  `message.edited`; no deletion endpoint exists). Attachments are stored as
  references for Prompt 12; no upload flow exists in this phase.
- **Audit actions** — `conversation.created`, `message.created`,
  `message.edited` (actor, workspace, resource ids, visibility name — never
  message content or customer PII).
- **Real-time readiness (Prompt 10)** — conversations are room-shaped
  documents (`conversation:{id}`) with inbox-ordering indexes already in
  place; message sends deliberately emit no events yet.

## Authentication (implemented)

Short-lived **access JWTs** + long-lived **opaque rotating refresh tokens**:

- **Access token** — HS256 JWT via `jose`, claims limited to `sub/type/iat/exp`
  (`modules/auth/auth.tokens.ts`). No email, roles or workspace data in the
  payload; identity state is re-checked per request (`requireAuth`) so
  suspension/revocation is instant. TTL `JWT_ACCESS_TTL` (15m).
- **Refresh token** — 32-byte opaque random string, stored ONLY as a SHA-256
  hash in the `refresh_tokens` collection (one doc per session/device, with
  ip/user-agent, `familyId` for the rotation chain). On refresh the token is
  **rotated** (predecessor revoked + successor linked); presenting an already-
  rotated token is treated as theft and revokes the whole family. TTL
  `JWT_REFRESH_TTL` (7d).
- **Delivery** — access token in the JSON body (`Authorization: Bearer` for
  the SPA); refresh token additionally in an **HttpOnly cookie** scoped to
  `Path=/api/v1/auth`, SameSite from `COOKIE_SAMESITE`, Secure in production
  (`COOKIE_SECURE=auto`). cookie-parser is wired in `app.ts`.
- **Middleware** — `requireAuth` (`modules/auth/require-auth.middleware.ts`)
  verifies the JWT, then re-checks the live account (status `active`,
  `tokenVersion` current) and attaches a typed `req.auth = { userId }` via
  module augmentation. Authorization/RBAC deliberately NOT here — later
  middleware composes on `req.auth`.
- **One-time tokens** (verify-email, password reset) — 32-byte random, hashed
  at rest in `auth_tokens` (scoped by email + purpose, single unique live token
  per pair, atomic consume, TTLs `AUTH_VERIFY_EMAIL_TTL` / `AUTH_PASSWORD_RESET_TTL`).
- **Emails** — provider-independent `EmailTransport` seam
  (`modules/auth/email/`); the dev `log` outbox keeps an in-memory ring buffer
  and is hard-blocked in production; SMTP/SES adapters land behind the same
  interface.
- **Anti-enumeration** — login failures use one uniform message (with a
  constant-time bcrypt compare even for unknown accounts); forgot-password and
  resend-verification always return the same response.
- **Audit** — auth events append to the existing `AuditLog` collection under a
  reserved all-zero platform scope (`auth-audit.ts`): `user.login`,
  `user.login_failed`, `user.logout`, `user.logout_all`, `user.registered`,
  `user.email_verified`, `user.password_reset`, … Never tokens/passwords.

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

## Lifecycle & shutdown

`server.ts` boots in order: validated config → database (fail-fast: an
unreachable DB terminates the process so orchestrators restart it) → HTTP
listener. SIGTERM/SIGINT/SIGBREAK run the **shutdown registry**
(`core/lifecycle/shutdown-registry.ts`) sequentially: HTTP close → Mongo
disconnect → (future: Socket.IO `io.close()`, BullMQ `worker.close()`).
Subsystems register one hook; `server.ts` never grows a teardown pile.

## Monitoring (prepared)

Structured JSON logs (pino) with request ids map 1:1 to CloudWatch Logs
Insights queries; `/health` and `/health/ready` map to ALB target-group
health checks (liveness vs readiness separation). ECS task + ALB 5xx + p95
latency alarms are a deploy-phase task on top of this foundation.
