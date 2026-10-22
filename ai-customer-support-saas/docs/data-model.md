# Data model

The MongoDB layer for the SaaS: five foundation collections, their indexes,
and the rules future modules must follow. Layered on the connection management
in `server/src/database/database.ts`.

## Collections overview

| Collection         | Module                                        | Tenant-scoped | Soft delete | Notes                                          |
| ------------------ | --------------------------------------------- | ------------- | ----------- | ---------------------------------------------- |
| `users`            | `modules/users`                               | No (global)   | No          | One identity per human; per-workspace roles live in `workspace_members` |
| `workspaces`       | `modules/workspaces`                          | IS the tenant | No          | The tenant boundary; `status` covers archive lifecycle |
| `workspace_members`| `modules/workspaces`                          | Yes           | No          | RBAC rows; one per (workspace, user); max one `owner`; roles `owner/admin/agent/viewer` mapped to permissions in `modules/rbac` |
| `customers`        | `modules/customers`                           | Yes           | **Yes**     | End users of a workspace; never members        |
| `tickets`          | `modules/tickets`                             | Yes           | **Yes**     | Workspace-scoped desk item; `number` (`TKT-######`) unique per workspace; `priorityRank` is derived/computed state |
| `conversations`    | `modules/conversations`                       | Yes           | No          | ONE primary thread per ticket (`{ workspaceId, ticketId }` unique); NO status of its own — lifecycle is inherited from the ticket; last-message metadata is advisory and self-healing |
| `messages`         | `modules/conversations`                       | Yes           | Never       | Immutable after send (audited sender-only body edit); `ticketId` denormalized server-side; `visibility` `PUBLIC`/`INTERNAL`; attachments are Prompt 12 references only |
| `ticket_counters`  | `modules/tickets`                             | Yes (embeds workspaceId) | No | Internal allocation sequence — one `{ seq }` row per workspace, atomically incremented; never read by the API |
| `audit_logs`       | `modules/audit-logs`                          | Yes (platform scope reserved) | Never | Append-only; updates/deletes rejected at model layer |
| `refresh_tokens`   | `modules/auth`                                | No (per user) | Revocation  | One row per active session; SHA-256 **hash only**, rotation chain via `familyId` |
| `auth_tokens`      | `modules/auth`                                | No (per email) | Consumed/expiry | One-time verify-email / password-reset tokens, hashed at rest |

## Authentication collections (added in the auth phase)

- **Why not JWT-only refresh tokens?** Opaque random strings hashed in the DB
  beat stateless refresh JWTs: revocation is instant and per-session, and a
  database leak exposes only hashes.
- **Why a collection, not a `User.sessions[]` array?** Unbounded arrays are
  forbidden (same decision as memberships); a collection scales to many
  devices per user and indexes independently.
- **Platform audit scope** — auth events (login, logout, password reset…)
  happen before any workspace context exists; they are appended to
  `audit_logs` under the reserved all-zero `workspaceId`
  (`PLATFORM_SCOPE` in `modules/auth/auth-audit.ts`).

## Relationships

```
User ──< WorkspaceMember >── Workspace (tenant boundary)
                                │
                                ├──< Customer
                                ├──< Ticket (Prompt 8)
                                │     └──1 Conversation (Prompt 9)
                                │          └──< Message (Prompt 9)
                                ├──< AuditLog
                                └──< (KnowledgeArticle, Document, … —
                                      future phases, each with a
                                      required workspaceId)
```

- `User 1─N WorkspaceMember N─1 Workspace`: one human, many workspaces, a
  role in each. This replaced the earlier `User.memberships[]` embedding
  plan — a collection scales better (unbounded arrays are forbidden) and can
  be indexed/enforced independently.
- Customers reference only their workspace; conversations/tickets/CSAT will
  reference the customer by `_id` — never embedded.
- Tickets reference only ids (`customerId`, `agentId`, `createdById`) — no
  duplicated customer/user data; consumers resolve names through their own
  modules.
- Conversations reference one ticket, one customer (copied from the ticket
  SERVER-SIDE at creation — never a client field), and carry ids-only
  last-message pointers. Messages reference the conversation and carry a
  denormalized `ticketId` for cheap ticket-scoped queries. No message body
  or sender profile is ever duplicated into Conversation documents.

## Conversation & Message collections (Prompt 9)

- **One primary conversation per ticket** — enforced as a LAW by the unique
  `{ workspaceId, ticketId }` index. A lost get-or-create race loses against
  the index and re-reads the winner (`createConversationRaceSafe`), so even
  concurrent callers can never materialize two threads for one ticket.
  The alternative (multiple conversations per ticket) was rejected because
  the ticket module already defines status/history triage; per-ticket
  threading would duplicate that lifecycle.
- **No conversation status** — conversations open and close with their
  ticket; a second state machine would be a conflicting lifecycle. When a
  ticket is archived (soft-delete stamp), its conversation and messages read
  as 404 through every path (live-ticket re-check on every flow).
- **Advisory, self-healing metadata** — `lastMessageAt`/`lastMessageById`
  are pointers maintained after each send. Because this deployment does NOT
  support multi-document transactions (standalone mongod), message +
  metadata is not atomic: a failed metadata update is logged and the next
  authorized thread read recomputes the values from the newest message
  (`repairConversationMetadata`, idempotent under concurrency). The MESSAGE
  document is always the authoritative record; success responses are never
  suppressed by metadata or audit failures (documented fire-and-forget).
- **Visibility** — `PUBLIC` (customer-facing) and `INTERNAL` (staff-only
  notes). Internal access is DERIVED from the centralized permission
  registry (`conversation.reply`): staff can read internal notes; roles
  without that permission get internal notes excluded IN THE QUERY (they
  never reach the application to be scrubbed) and 403 on a direct read.
  Visibility is immutable — PATCH accepts `body` only, so no client can
  flip public↔internal.
- **Edit/deletion policy** — messages are never deleted; the ONLY supported
  edit is the original sender changing the body (audited as
  `message.edited`; nobody, administrators included, may rewrite someone
  else's message). `attachments` stores Prompt 12 REFERENCES only; no API
  accepts attachment data yet.
- **Customer identity dependency** — no customer-portal authentication
  exists yet, so `senderType: 'CUSTOMER'` is a reserved type. Sender
  identity is always derived from the authenticated principal; an arbitrary
  customerId in a request can never mint a sender. Customer senders arrive
  with the customer identity mechanism (a documented later-phase
  dependency), never by trusting client-supplied identity.

## Ticket collection (Prompt 8)

- **Numbers** (`TKT-000042`, workspace-scoped): allocated by the
  `ticket_counters` collection — Mongo `findOneAndUpdate` `$inc` is
  document-atomic and cannot split under concurrency; a lost create race
  against the unique `{ workspaceId, number }` index retries the whole
  allocation a bounded number of times (3) before surfacing a
  non-operational `TICKET_NUMBER_ALLOCATION_FAILED`.
- **Why not `count()` or timestamps for numbering?** Counting unreaded
  documents and clock-based ids both race under concurrent creation; the
  counter + unique index make uniqueness a LAW the database enforces, not
  an application habit the app can forget.
- **`priorityRank`** is the model's single piece of deliberately duplicated
  state: MongoDB cannot sort enum strings by intended urgency weight, so a
  pre-validate/pre-update hook pair derives `priorityRank` from `priority`
  on every write path (create AND scoped `findOneAndUpdate` updates). No
  route accepts `priorityRank` — but helpers keep the value glued.
- **No transactions**: Mongo transactions are unavailable in the current
  test/dev topology (standalone mongod), so the design never relies on them.
  Ticket writes are single-document atomic; audit appends follow the
  project-wide fire-and-forget pattern (a failed append is logged, never
  suppresses the user-visible operation). Ticket+counter consistency rests
  on the unique index and retry, not on a transaction.

## Indexes

All tenant-owned indexes lead with `workspaceId` (shared-pool tenancy).

| Collection         | Index                                              | Purpose / decision |
| ------------------ | -------------------------------------------------- | ------------------ |
| users              | `{ email: 1 }` unique                              | Login lookup; emails are platform-global identities |
| workspaces         | `{ slug: 1 }` unique                               | Tenant resolution by URL; slug is immutable |
| workspace_members  | `{ workspaceId: 1, userId: 1 }` unique             | The hot RBAC path: "is user X in workspace Y, as what?" |
| workspace_members  | `{ userId: 1, status: 1 }`                         | Reverse lookup: workspace switcher / session load |
| workspace_members  | `{ workspaceId: 1 }` unique, partial `role: 'owner'` | DB-enforced single-owner invariant |
| customers          | `{ workspaceId: 1, email: 1 }` unique, partial (`email` exists, `deletedAt: null`) | **Per-tenant** email uniqueness; anonymous (email-less) visitors and soft-deleted rows are exempt |
| customers          | `{ workspaceId: 1, status: 1 }`                    | List/filter by lifecycle |
| customers          | `{ workspaceId: 1, createdAt: -1 }`                | Newest signups, date-range analytics |
| customers          | `{ workspaceId: 1, updatedAt: -1 }`                | "Recently active" views |
| tickets            | `{ workspaceId: 1, number: 1 }` unique             | The numbering LAW — DB-enforced per-workspace uniqueness; also the fastest "ticket TKT-000042" opener |
| tickets            | `{ workspaceId: 1, status: 1, priorityRank: -1, createdAt: -1 }` | Default triage board read: status filter, urgency-weighted order |
| tickets            | `{ workspaceId: 1, customerId: 1, createdAt: -1 }` | "All tickets for this customer" detail page |
| tickets            | `{ workspaceId: 1, agentId: 1, updatedAt: -1 }`    | Agent work queue |
| tickets            | `{ workspaceId: 1, createdAt: -1 }` / `{ workspaceId: 1, updatedAt: -1 }` | Date-range filters and newest/updated sort fallbacks |
| conversations      | `{ workspaceId: 1, ticketId: 1 }` UNIQUE       | ONE primary conversation per ticket — the database-enforced design law; also the get-or-create race arbiter |
| conversations      | `{ workspaceId: 1, customerId: 1, updatedAt: -1 }` | The customer's conversation list (customerId copied from the ticket at creation) |
| conversations      | `{ workspaceId: 1, lastMessageAt: -1 }`        | Workspace inbox / recent-activity views (Prompt 10 reads this shape) |
| messages           | `{ workspaceId: 1, conversationId: 1, createdAt: 1 }` | Chronological thread reads (pagination sorts `{ createdAt: 1, _id: 1 }` for a stable per-millisecond order) |
| messages           | `{ workspaceId: 1, ticketId: 1, createdAt: -1 }` | "Everything sent about this ticket" (ticket-scoped search/export) — cheap because `ticketId` is denormalized server-side |
| audit_logs         | `{ workspaceId: 1, createdAt: -1 }`                | Workspace activity feed, retention scans |
| audit_logs         | `{ workspaceId: 1, resourceType: 1, resourceId: 1 }` | Per-resource history drill-down |
| audit_logs         | `{ workspaceId: 1, actorId: 1, createdAt: -1 }`    | "What did this actor do" |
| refresh_tokens     | `{ tokenHash: 1 }` unique (field `select: false`)  | Refresh-endpoint lookup by hash — raw tokens are never stored |
| refresh_tokens     | `{ familyId: 1 }`                                  | Rotation chains + family-wide revocation (reuse = theft) |
| refresh_tokens     | `{ userId: 1, expiresAt: -1 }`                     | Active-session lists, logout-all, TTL-friendly shape |
| auth_tokens        | `{ email: 1, purpose: 1 }` unique                  | One live token per (email, purpose); re-issue replaces the old one |

Deliberately **not** added: a text index on customer name/email (future
Atlas Search), an index on `workspaces.ownerId` (membership is the access
path), a TTL index on `audit_logs` (retention is a compliance decision for
the deploy phase).

## Tenant isolation

Enforced by construction, not by a global query interceptor (rejected:
opaque, hard to test, blocks legitimate platform-level queries):

1. `TenantScopedDocument` (in `database/tenant.ts`) — every tenant-owned
   document type must carry `workspaceId`; TypeScript rejects models that
   forget it.
2. `tenantFilter(workspaceId)` — repositories build every tenant query by
   spreading this helper; it normalizes string ids to ObjectId so indexes
   always hit.
3. `assertTenantScope(filter)` — repository-internal guard that throws a
   non-operational `TENANT_SCOPE_VIOLATION` (opaque 500) when a filter
   reaches the DB without a workspace scope.
4. Index shape — compound indexes lead with `workspaceId`, so an unscoped
   query is both a correctness bug and a full collection scan.

## Soft-delete decisions

| Model      | Decision | Rationale |
| ---------- | -------- | --------- |
| Customer   | `deletedAt` + live-only query scope + `WITH_DELETED` opt-in | User-triggered deletion of end-user data; preserves history, reversible; email is released for reuse via the partial index |
| Ticket     | `deletedAt` + live-only query scope + `WITH_ARCHIVE` opt-in | Archive ≠ closure: a closed ticket is a finished LIVE ticket (still listed); archiving hides it from ordinary views while keeping the record for history/reports; no hard delete |
| User       | No       | Account lifecycle is `status: invited/active/suspended`; real deletion is a compliance operation (future) |
| Workspace  | No       | Lifecycle is `status: active/archived`; archiving is the reversible path |
| WorkspaceMember | No  | Removing a membership is intentional and re-addable; audit trail records it |
| AuditLog   | Never    | Immutable by design; updates and deletes throw at the model layer |

## Schema evolution

- All schemas use `timestamps: true` (AuditLog: `createdAt` only) — no manual
  date maintenance.
- `settings` on Workspace and `metadata` on Customer/AuditLog are typed
  open-ended bags; new keys are additive and never break old documents
  (Mongoose treats absent paths as `undefined`).
- Enums are tuples (`WORKSPACE_ROLES`, …) in `*.types.ts` — widening a role
  or status is an append, not a migration (the `viewer` role from the RBAC
  phase was added exactly this way).
- Authorization semantics live OUTSIDE the schema: role values are storage,
  grants come from the centralized registry (`modules/rbac/rbac.permissions.ts`).
- No migration framework yet; when a breaking field change is needed it will
  be a documented script under `scripts/`, not an ad-hoc change.
