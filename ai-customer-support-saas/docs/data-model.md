# Data model

The MongoDB layer for the SaaS: five foundation collections, their indexes,
and the rules future modules must follow. Layered on the connection management
in `server/src/database/database.ts`.

## Collections overview

| Collection         | Module                                        | Tenant-scoped | Soft delete | Notes                                          |
| ------------------ | --------------------------------------------- | ------------- | ----------- | ---------------------------------------------- |
| `users`            | `modules/users`                               | No (global)   | No          | One identity per human; per-workspace roles live in `workspace_members` |
| `workspaces`       | `modules/workspaces`                          | IS the tenant | No          | The tenant boundary; `status` covers archive lifecycle |
| `workspace_members`| `modules/workspaces`                          | Yes           | No          | RBAC rows; one per (workspace, user); max one `owner` |
| `customers`        | `modules/customers`                           | Yes           | **Yes**     | End users of a workspace; never members        |
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
                                ├──< AuditLog
                                └──< (Ticket, Conversation, KnowledgeArticle,
                                      Document, … — future phases, each with
                                      a required workspaceId)
```

- `User 1─N WorkspaceMember N─1 Workspace`: one human, many workspaces, a
  role in each. This replaced the earlier `User.memberships[]` embedding
  plan — a collection scales better (unbounded arrays are forbidden) and can
  be indexed/enforced independently.
- Customers reference only their workspace; conversations/tickets/CSAT will
  reference the customer by `_id` — never embedded.

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
  or status is an append, not a migration.
- No migration framework yet; when a breaking field change is needed it will
  be a documented script under `scripts/`, not an ad-hoc change.
