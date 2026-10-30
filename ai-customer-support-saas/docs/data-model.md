# Data model

The MongoDB layer for the SaaS: foundation and feature collections, their
indexes, and the rules future modules must follow. Layered on the connection
management in `server/src/database/database.ts`.

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
| `kb_categories`    | `modules/knowledge-base`                      | Yes           | **Yes** (`archivedAt` + live-only scope) | Workspace-scoped article tree; unique `{ workspaceId, slug }`; hierarchy max depth 5 |
| `kb_articles`      | `modules/knowledge-base`                      | Yes           | Lifecycle `status` (DRAFT/PUBLISHED/ARCHIVED — no hidden hook) | Markdown body stored verbatim; unique `{ workspaceId, slug }`; `currentRevisionNumber` server-allocated |
| `kb_article_revisions` | `modules/knowledge-base`                  | Yes           | Never (append-only, immutable) | Full content snapshots (title/summary/body/category/tags); unique `{ workspaceId, articleId, revisionNumber }` |
| `file_assets`      | `modules/documents`                           | Yes           | **Yes** (`deletedAt` tombstone after byte purge) | Uploaded-file METADATA only — bytes live behind the `StorageService` seam; processing `status` + `extractionStatus` + bounded `extractedText`; optional `articleId` attach-point |
| `audit_logs`       | `modules/audit-logs`                          | Yes (platform scope reserved) | Never | Append-only; updates/deletes rejected at model layer |
| `rag_chunks`       | `modules/rag`                                 | Yes           | No (purged on source lifecycle) | One document per indexed chunk (Prompt 13); sources = PUBLISHED kb_articles + COMPLETED-extraction file_assets only; tenant scope applies INSIDE retrieval queries |
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
                                ├──< KbCategory (Prompt 11, self-referencing tree, depth ≤ 5)
                                ├──< KbArticle (Prompt 11)
                                │     └──< KbRevision (Prompt 11, append-only snapshots)
                                ├──< AuditLog
                                ├──< FileAsset (Prompt 12; bytes in the
                                │     StorageService seam, optional `articleId`
                                │     → KbArticle, same-workspace validated)
                                └──< (Document — Prompt 12, future phases,
                                      each with a required workspaceId)
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
| kb_categories      | `{ workspaceId, slug: 1 }` unique        | Per-tenant category name/slug uniqueness (the duplicate-409 law) |
| kb_categories      | `{ workspaceId, parentId, displayOrder: 1, name: 1 }` | Tree reads: sibling order under a parent, ancestor-chain walk |
| kb_articles        | `{ workspaceId, slug }` unique           | Per-tenant article URL uniqueness (the duplicate-409 law) |
| kb_articles        | `{ workspaceId, categoryId, status, updatedAt: -1 }` | Category drill-down with lifecycle filter |
| kb_articles        | `{ workspaceId, status, publishedAt: -1 }` | PUBLISHED retrieval — the public-read and future AI-ingestion predicate |
| kb_articles        | `{ workspaceId, status, title: 1 }`      | Management list: title sort/filter on the status slice |
| kb_articles        | `{ workspaceId, tags: 1 }`               | Multi-tag filtering |
| kb_articles        | `{ workspaceId, createdById, updatedAt: -1 }` | Author-filtered lists |
| kb_articles        | `{ workspaceId, createdAt: -1 }` / `{ workspaceId, updatedAt: -1 }` | Date-range filters and newest/updated sort fallbacks |
| kb_article_revisions | `{ workspaceId, articleId, revisionNumber: 1 }` unique | The append-only revision LAW (one snapshot per number per article; server-allocated `$inc` arbiter) |
| file_assets        | `{ workspaceId, createdAt: -1 }`                    | Workspace-scoped file listing (the default list/page read) |
| file_assets        | `{ workspaceId, status, createdAt: -1 }`            | Processing-lifecycle filters (status + pagination share the shape) |
| file_assets        | `{ workspaceId, extractionStatus, createdAt: -1 }`  | Failed/extractable work queues |
| file_assets        | `{ workspaceId, articleId, createdAt: -1 }`         | "Files attached to KB article X" |
| file_assets        | `{ workspaceId, uploadedById, createdAt: -1 }`      | Uploader-filtered lists ("my uploads") |
| file_assets        | `{ workspaceId, checksumSha256 }`                   | Dedupe/forensics lookups (no uniqueness enforced — see above) |
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

# Knowledge Base collections (Prompt 11)

Three workspace-scoped collections form the future AI/RAG and self-service
content layer — no embeddings, chunking or vector search yet (Prompt 13–15).

- **Categories (`kb_categories`)** — a self-referencing tree
  (`parentId` → `kb_categories._id`, `default: null`). Hierarchy is capped
  at depth 5 (`MAX_KB_CATEGORY_DEPTH`): a proposed parent is validated by
  walking its ancestor chain INSIDE the workspace BEFORE any write; cycles
  and depth overflow are 409s, unknown parents 404s (tenant concealment).
  Uniqueness of `{ workspaceId, slug }` (slug derived from the normalized
  name, ws-level case-insensitive duplicate check) is DB-enforced by the
  unique index. Soft delete only: an archive is REFUSED (409, live child/
  article counts in `details`) while live child categories or live articles
  remain attached — a category can never disappear in a way that silently
  orphans content; restore brings it back intact.
- **Articles (`kb_articles`)** — status machine `DRAFT → PUBLISHED →
  ARCHIVED` (enforced by `KB_ARTICLE_TRANSITIONS`: publish only from DRAFT,
  unpublish from PUBLISHED, archive from DRAFT/PUBLISHED, restore from
  ARCHIVED; illegal moves are 409s). Articles carry ARCHIVED as a FIRST-CLASS
  status and intentionally get NO hidden live-only hook: every article query
  composes its status filter explicitly, because a silent default scope is
  exactly how draft material leaks into the wrong audience (public reads use
  the hardcoded `{ status: 'PUBLISHED' }` predicate). Unique
  `{ workspaceId, slug }` (client slugs 409 outright; auto-derived slugs
  retry a deterministic `-2…-25` suffix series, bounded before 409).
  `publishedAt` is stamped on publish and cleared on unpublish/restore;
  `archivedAt` on archive and cleared on restore. Body is plain MARKDOWN
  stored verbatim (no HTML sanitization burden, single content format) with
  the KB_SUMMARY_MAX/KB_BODY_MAX bounds; whitespace-only bodies are rejected
  at validation. No scheduled publishing (no scheduler infrastructure
  exists). No derived/enriched fields (embeddings, tokens, chunk refs) —
  future retrieval reads title/summary/body/tags as stored.
	- **Revisions (`kb_article_revisions`)** — full snapshot per content change:
  title, summary, body, categoryId, tags, editorId, changeSummary,
  `createdAt`-only timestamps plus `restoredFromRevisionNumber`. Revision
  numbers are SERVER-ALLOCATED via an atomic `$inc` on the article doc
  (starting at 1 on create, pinned under a versioned-condition update so a
  lost race can never clobber the transient state); containment is the
  unique `{ workspaceId, articleId, revisionNumber }` index. The revision
  model throws on update/delete (pre-hooks + a non-enumerable `bulkWrite`
  guard, mirroring audit_logs) — history is append-only, and "restore"
  always CREATES a new numbered revision pointing at the source
  (`restoredFromRevisionNumber`) rather than rewriting anything.
- **No transactions** — the allocate → insert-snapshot → article-update
  sequence is NOT atomic in this standalone-mongod deployment and is ordered
  revision-first by design: an insert failure aborts the request loudly and
  leaves the counter ahead (the next edit allocates in sequence); an
  article-update failure after a successful insert leaves a snapshot that
  outpaces the article's stored content (the article stays the read model;
  the failure is error-logged as `KB_ARTICLE_UPDATE_FAILED` /
  `KB_RESTORE_FAILED` and the next content edit closes the gap). Lifecycle
  transitions never write revisions (statuses are not content).
- **Search limitations (documented)** — workspace-internal filtering uses a
  case-insensitive regex scan over `{ title, summary, tags }` composed into
  the tenant-scoped filter chain (client regex metacharacters are escaped);
  no text index backs the in-product title-substring UX, so a KB above a few
  thousand articles should move search to a text/Atlas index before volume.
  The published-only retrieval contract is a documented seam: future AI/RAG
  ingestion reuses the same predicate instead of new fields.
- **Audit actions** — `kb.category.created/updated/archived/restored`,
  `kb.article.created/updated/published/unpublished/archived/restored`,
  `kb.article.revision_restored`. Metadata carries ids, slugs, field NAMES
  and revision numbers only — never title/summary/body/tag text.

## File-assets collection (Prompt 12)

One uploaded file per document row. The dividing line of the whole module:
**MongoDB stores metadata and processing state; file BYTES never enter the
database** — they live behind the `StorageService` seam (local disk in dev,
S3 in prod, key `workspaces/{workspaceId}/files/{uuid}.{ext}` composed
server-side).

- **Lifecycle** — `status`: `PENDING → PROCESSING → COMPLETED` with
  `FAILED` as a side exit (storage or extraction failure). `extractionStatus`
  is the INDEPENDENT sub-state (`PENDING/COMPLETED/SKIPPED/FAILED`) —
  extraction failure does not erase the stored bytes. Extraction errors are
  stored as SAFE data (`{code, message}`: stable codes, user-displayable
  messages — never provider stack traces or file content). Server logs keep
  the real error.
- **No job runner yet** — processing is claimed atomically
  (`findOneAndUpdate` from an expected source status) and runs in-process
  after the response. No transactions: claim → store-state → extract is NOT
  atomic; a crash mid-extraction strands `PROCESSING`, which
  `POST /files/:fileId/reprocess` re-arms until the BullMQ phase brings
  automatic recovery. `PENDING`/`PROCESSING`/`FAILED`/`COMPLETED` are all
  reprocessable; the claim's finite transition prevents concurrent
  double-processing.
- **Media registry, not a denylist** — the closed `DOCUMENT_MEDIA_TYPES`
  registry is the entire upload surface (txt, md, csv, json, pdf, docx).
  Binary families must carry their magic bytes (content sniffing), text
  families reject NUL-laden payloads (mislabeled binaries), and the stored
  `mediaType` is the SNIFFED/validated value — client-declared types are
  never authoritative, and no route accepts a client-set media type, size,
  provider or workspace (mass assignment cannot poison the metadata).
- **Derived text bounded** — `extractedText` caps at
  `DOCUMENT_EXTRACTED_TEXT_MAX` (100k chars, far below the 16 MiB BSON
  ceiling); longer extractions store the prefix plus
  `extractedTextTruncated: true` until the chunking phase (Prompts 13–15)
  moves ingestion onto the storage seam. No embeddings/derived fields —
  future RAG ingestion reuses the stored text + metadata as-is.
- **Byte/pair consistency (documented honestly)** — upload writes bytes
  FIRST (`putObject`) and metadata SECOND; a failed metadata write
  best-effort-deletes the object. If metadata fails AND cleanup fails, a
  workspace-namespaced orphan object remains in a private bucket (no
  retrieval path exists without a workspace membership; no metadata points
  at nothing). Deletion is the inverse: DELETE removes bytes and stamps
  `deletedAt` (tombstone row retained for audit; missing bytes delete
  idempotently).
- **No dedupe-enforced uniqueness (deliberate)** — NO uniqueness on
  `checksumSha256`: re-uploading the same file is legal today (dedupe is a
  future policy decision); the checksum index
  (`{ workspaceId, checksumSha256 }`) is for lookup/forensics.
- **Audit** — `document.uploaded/reprocessed/deleted` carry ids, media
  types, sizes and checksum fingerprints ONLY — original filenames are
  user-controlled strings and never enter the audit trail.

## RAG chunk collection (added in the AI/RAG phase)

- **`rag_chunks`** (`modules/rag`) — one document per indexed chunk:
  `workspaceId`, `sourceType` (`KB_ARTICLE | DOCUMENT`), `sourceId`,
  `chunkIndex`, `text`, `textLength`, `textHash` (sha-256), `sourceHash`,
  `embedding` (in-memory store), `embeddingStatus` + `embeddingModel`,
  `createdAt`/`updatedAt`. Chunks derive ONLY from eligible sources
  (published articles, fully-extracted documents); every write embeds its
  source's content hash so reindexing is idempotent and obsolete chunks are
  purged on source update/delete/unpublish. Indexes:
  `{ workspaceId, sourceType, sourceId, chunkIndex }` (unique — the dedupe
  key), `{ workspaceId, textHash }` (dedupe forensics),
  `{ workspaceId, embeddingStatus, sourceType }` (failed-embedding repair
  queue), `{ workspaceId, sourceType, sourceEligible }` (eligibility
  counts), `{ workspaceId, sourceId, sourceHash }` (reindex short-circuit).
  Tenant + eligibility filters are applied INSIDE retrieval, never client-side. Agent audits reuse the same
  append-only `audit_logs` collection (`agent.question_answered` —
  outcome/reason/counts only; no question or answer text).
- **Verification** — `npm run verify:agent` (48/48) boots the REAL app
  against the documented local fixtures (in-memory Mongo + mock embedding
  + in-memory vector store) and injects the deterministic mock chat via
  the factory test seam; retrieval work is mocked-only, live OpenAI and
  Atlas Vector Search remain UNVERIFIED until credentials exist.

## Soft-delete decisions

| Model      | Decision | Rationale |
| ---------- | -------- | --------- |
| Customer   | `deletedAt` + live-only query scope + `WITH_DELETED` opt-in | User-triggered deletion of end-user data; preserves history, reversible; email is released for reuse via the partial index |
| Ticket     | `deletedAt` + live-only query scope + `WITH_ARCHIVE` opt-in | Archive ≠ closure: a closed ticket is a finished LIVE ticket (still listed); archiving hides it from ordinary views while keeping the record for history/reports; no hard delete |
| User       | No       | Account lifecycle is `status: invited/active/suspended`; real deletion is a compliance operation (future) |
| Workspace  | No       | Lifecycle is `status: active/archived`; archiving is the reversible path |
| WorkspaceMember | No  | Removing a membership is intentional and re-addable; audit trail records it |
| AuditLog   | Never    | Immutable by design; updates and deletes throw at the model layer |
| KbCategory | `archivedAt` + live-only query scope + `WITH_ARCHIVE` opt-in | Archiving is the reversible path; guarded against orphaning live children/articles (409 with counts) |
| KbArticle  | No soft-deleted stamp — ARCHIVED is a first-class `status` | The status IS the lifecycle for the public/AI retrieval predicate; no hidden hook (query composition stays explicit) |
| KbRevision | Never    | Append-only history; mutation throws at the model layer |
| FileAsset  | `deletedAt` + live-only query scope + `withPurged` opt-in | DELETE purges BYTES (the real data) and tombstones the row for audit; the metadata row is retained, not hard-deleted |

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
