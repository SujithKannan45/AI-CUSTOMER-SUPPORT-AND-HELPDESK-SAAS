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

## Knowledge base (Prompt 11, implemented)

Workspace-scoped categories + articles + append-only revision history,
mounted from `routes/api.routes.ts` (management gate: `requireAuth →
validate(params) → requireWorkspaceContext → requirePermission('kb.manage'`
or `'kb.view')):

```
POST   …/knowledge-base/categories                        kb.manage
GET    …/knowledge-base/categories                        kb.view
GET    …/knowledge-base/categories/:categoryId            kb.view
PATCH  …/knowledge-base/categories/:categoryId            kb.manage
POST   …/knowledge-base/categories/:categoryId/archive    kb.manage
POST   …/knowledge-base/categories/:categoryId/restore    kb.manage
POST   …/knowledge-base/articles                          kb.manage
GET    …/knowledge-base/articles                          kb.view  (filter/sort/paginate)
GET    …/knowledge-base/articles/:articleId               kb.view  (full detail incl. body)
PATCH  …/knowledge-base/articles/:articleId               kb.manage
POST   …/knowledge-base/articles/:articleId/publish       kb.manage
POST   …/knowledge-base/articles/:articleId/unpublish     kb.manage
POST   …/knowledge-base/articles/:articleId/archive       kb.manage
POST   …/knowledge-base/articles/:articleId/restore       kb.manage
GET    …/knowledge-base/articles/:articleId/revisions     kb.view  (history)
GET    …/knowledge-base/articles/:articleId/revisions/:n  kb.view  (snapshot)
POST   …/knowledge-base/articles/:articleId/revisions/:n/restore  kb.manage

# PUBLIC (anonymous) — /api/v1/public/knowledge-base
GET    /:workspaceSlug/categories        workspace-slug resolution; 404 otherwise
GET    /:workspaceSlug/articles          ONLY status=PUBLISHED, public DTO
GET    /:workspaceSlug/articles/:articleSlug  ONLY published slugs resolve
```

- **Permissions** — the existing registry grew by exactly two entries:
  `kb.view` (owner/admin/agent/viewer — Viewer keeps read access and gets no
  management power) and `kb.manage` (owner/admin only; agents do NOT manage
  KB content by default — least privilege, extendable per workspace later).
  No competing registry; denials still audit `workspace.permission_denied`.
- **Category lifecycle** — soft archive/restore only; archive is REFUSED
  (409 + counts in `details`) while live child categories or live articles
  remain attached. Hierarchy is validated server-side: same-workspace live
  parents only, depth cap 5, cycle/self-parent detection via an
  ancestor-chain walk — all before any write. Renames re-derive the slug;
  duplicates are caught by the case-insensitive service check and finally
  by the DB unique index.
- **Article lifecycle & revisions** — `DRAFT ⇄ PUBLISHED → ARCHIVED →
  (restore) DRAFT` with per-transition 409s; archived articles refuse
  edits/publishes (409). Content edits (title/summary/body/category/tags)
  always allocate the next revision with an ATOMIC `$inc` and insert a full
  snapshot BEFORE the article update (revise-first ordering); slugs and
  lifecycle changes write NO revisions. Restoring an old revision creates a
  NEW numbered snapshot (`restoredFromRevisionNumber`) — history is never
  rewritten, and the revision model itself rejects updates/deletes (also
  via `bulkWrite`). Query mounts: revision list reads are workspace-scoped,
  so cross-tenant revision access is a uniform 404.
- **Public reads** — a separate anonymous surface (`/api/v1/public/`).
  No auth, no membership: safety comes from the workspace-slug lookup (404
  concealment) and the hardcoded PUBLISHED-only predicate, mapped through
  explicit public DTOs (id/title/slug/summary/tags/publishedAt + body and
  categoryId on detail) — no status flags, author/editor ids, revision
  pointers or draft/archived timestamps ever cross the public boundary.
  Draft/archived content is unreachable both in lists and by slug. Anonymous
  requests pass a dedicated 120 req/min IP rate limiter (tighter than the
  global API backstop). No customer-portal auth exists yet — the public
  surface is deliberately identity-free rather than inventing tokens.
- **Search/filter** — server-side composition of allowlisted filters
  (search/category/status/tags/author/createdFrom/createdTo/updatedFrom/
  updatedTo) and a bounded allowlist of sort fields (title/createdAt/
  updatedAt/publishedAt), capped pagination, escaped regex input; no raw
  client query objects ever reach Mongo.
- **Consistency (documented honestly)** — no multi-document transactions:
  the allocate → snapshot-insert → article-update sequence is ordered
  revision-first, each failure aborts loudly with specific error codes
  (`KB_ARTICLE_UPDATE_FAILED`, `KB_RESTORE_FAILED`), and audit appends stay
  fire-and-forget per project convention. See the data-model doc for the
  full failure-mode narrative.
- **Audit actions** — `kb.category.created/updated/archived/restored`,
  `kb.article.created/updated/published/unpublished/archived/restored`,
  `kb.article.revision_restored` (ids/slugs/field names/revision numbers
  only — article bodies and titles never enter audit metadata).
- **AI/RAG readiness (Prompts 13–15)** — the retrieval contract is already
  fixed: published-only workspace predicate + stored markdown
  title/summary/body/tags, with no embeddings/chunks stored on the model.
  Future file ingestion (Prompt 12) adds a `documents` collection that can
  reference `kb_articles` without schema changes.
- **Verification** — KB behavior runs through the `npm run verify:kb`
  end-to-end driver (in-memory mongod + the real Express app + real HTTP:
  142 checks over authz, lifecycle, revisions, tenant isolation, public
  reads, search and audit), alongside the existing
  auth/workspace/RBAC/customer/ticket/conversation regression drivers.

## Documents & file management (Prompt 12, implemented)

Workspace-scoped file assets with a storage-driver seam, upload validation,
server-side text extraction and a processing lifecycle. Mounted from
`routes/api.routes.ts` under `/api/v1/workspaces/:workspaceId/files` (gate:
`requireAuth → limiter/multipart → validate → requireWorkspaceContext →
requirePermission`):

```
POST   /files                      document.manage  (dedicated 30/min/IP limiter)
GET    /files                      document.view    (filter/sort/paginate)
GET    /files/:fileId              document.view
GET    /files/:fileId/download     document.view    (streamed, Content-Disposition)
POST   /files/:fileId/reprocess    document.manage  (re-arms extraction)
DELETE /files/:fileId              document.manage  (byte purge + audited tombstone)
```

- **Permissions** — two registry entries: `document.view` (owner/admin/agent;
  deliberately NOT granted to viewer — file corpora and extraction output are
  internal working material) and `document.manage` (owner/admin/agent — agents
  attach evidence documents as part of working the desk). No competing
  registry; denials keep the `workspace.permission_denied` audit convention.
- **Upload validation is not trust-based** — client content types are INPUTS:
  a closed media registry (`DOCUMENT_MEDIA_TYPES`) allowlists exactly
  txt/md/csv/json/pdf/docx, binary families must carry their magic bytes
  (declared-but-unmatched = 415 `MEDIA_MISMATCH`), text families containing
  NUL bytes are rejected (`BINARY_MASQUERADING_AS_TEXT`), declared type vs
  extension mismatch = 422. Filenames are sanitized metadata; the storage key
  is composed SERVER-side (`workspaces/{ws}/files/{uuid}.{ext}`), so no client
  value ever reaches a filesystem path. Multer errors translate to 413/422
  (including multer/busboy truncated-multipart bodies → 422, not 500);
  unknown multipart text fields are 422 (mass-assignment protection).
- **Least privilege in the lifecycle** — files are PENDING → PROCESSING →
  COMPLETED/FAILED with a separate extraction sub-status and a SAFE
  `{code,message}` error (`message` never carries provider traces or content).
- **Storage seam** — `StorageService` (`modules/documents/storage/`):
  `putObject/getObject/deleteObject` for server-mediated flows plus presigned
  upload/download reserved for a later direct-upload phase. Drivers: local
  disk (development, `STORAGE_DATA_DIR`, key-shape re-validated, traversal
  fails loudly; production use requires explicit
  `STORAGE_ALLOW_LOCAL_PRODUCTION=true`) and S3 (AWS SDK, boot-guarded
  credentials). The `local` driver hard-rejects presign calls
  (501) rather than faking signed URLs.
- **Extraction pipeline** — per-format extractors (plain text, JSON verbatim,
  `pdf-parse`, `mammoth`) under `modules/documents/extraction/`, re-readable
  by the Prompt 13–15 ingestion without the HTTP layer. Derived text is
  bounded (`DOCUMENT_EXTRACTED_TEXT_MAX`, `extractedTextTruncated` flag) and
  is the ONLY file content stored in MongoDB — bytes never enter the DB.
- **Processing consistency (documented honestly)** — no job runner yet:
  extraction runs in-process after the upload response, the PROCESSING claim
  is an atomic expected-state transition (no double-processing), but the
  claim/store/extract sequence is not atomic; a crash mid-extraction strands
  PROCESSING (`POST /files/:fileId/reprocess` is the operator repair path
  until the BullMQ phase owns retries/backoff). FAILED is terminal for this
  prompt; reprocess also re-arms COMPLETED.
- **Delete law** — DELETE purges stored bytes and stamps `deletedAt`
  (tombstoned row stays for audit; default query scope hides purged rows,
  `DOCUMENT_WITH_PURGED` opt-in for internals). Missing bytes on deletion are
  idempotent-gone. Upload rows never point at missing bytes: `putObject`
  happens BEFORE metadata and a failed metadata write best-effort-cleans up
  the object (a leaked orphan retains no private value — workspace-namespaced key, private bucket).
- **KB attach-point** — optional `articleId` is validated against the SAME
  workspace server-side (foreign ids read as 404, no cross-tenant existence
  oracle); files never accept or re-assign workspace/owner ids from the
  client.
- **Audit actions** — `document.uploaded / reprocessed / deleted` (ids,
  sizes, media types, checksum fingerprints only — never filenames, so
  user-controlled strings stay out of the compliance trail).
- **Verification** — `npm run verify:files` end-to-end driver (real app,
  real HTTP, both storage integration + extraction paths): 72 checks over
  authz/RBAC, upload validation, size caps, sniffing, pagination/boundaries,
  reprocess/delete, cross-tenant isolation and audit.

## Knowledge retrieval — RAG foundation (Prompt 13, implemented)

Grounding data lives in a dedicated `rag_chunks` collection (`modules/rag/`)
with one document per chunk: workspaceId, sourceType (`KB_ARTICLE | DOCUMENT`),
sourceId, chunk text + index + sha-256 hash, embedding status/metadata, and
timestamps. Every lookup is workspace-scoped INSIDE the query; chunks derive
ONLY from published KB articles and fully-extracted documents (spec: never
failed, incomplete, archived or ineligible sources).

- **Chunking** — `chunkSourceText` (pure module): normalization →
  paragraph/heading-shaped blocks → size-capped chunks with overlap → stable
  hashes; oversized sources are REJECTED, never silently truncated. The
  same hashes are the reindex dedupe keys (idempotent reprocessing).
- **Embeddings** — `EmbeddingProvider` interface; `openai` adapter
  (OpenAI-compatible, batched, validated, timeout-guarded) and a
  deterministic sha-256/xorshift `mock` provider (tests/dev ONLY —
  production boot refuses it). Defaults conservatively to `none`.
- **Vector stores** — `VectorStore` interface. `atlas` adapter for MongoDB
  Atlas Vector Search (requires a MANUALLY created Atlas Search vector
  index on `rag_chunks`, name via `RAG_ATLAS_VECTOR_INDEX`); `inmemory`
  store (tests/dev ONLY, boot-refused in production) which embeds vectors
  in Mongo documents and does an o(N) filtered scan. Defaults to `none`.
- **Indexing lifecycle** — `rag-indexing.service` + `rag.triggers`: publish
  / publish-unpublish / reprocess / replace / delete lifecycle hooks auto-
  index or purge chunks; `sourceTextSha256` short-circuits unchanged
  sources. In-process (no queue): a failed hook never corrupts the source
  flow, and BullMQ remains a prepared future integration (see below).
- **Retrieval** — `retrievePassages` (internal service, no HTTP surface):
  validated inputs, configured provider, store-level tenant + eligibility
  filtering, bounded results, safe coded failures.
- **Verification** — `npm run verify:rag` (48/48 and full retrieval-
  pipeline integration); pure drivers cover chunking/grounding without a
  database. NOTE for local drivers: after `memoryServer.stop()` the Mongo
  driver's auto-reconnect loop would keep the Node event loop alive
  forever — the drivers explicitly `mongoose.disconnect()` to exit cleanly.

## AI support agent (Prompt 14, implemented)

`POST /api/v1/workspaces/:workspaceId/agent/ask` (staff `agent.ask`
permission: owner/admin/agent — viewer excluded because each call may spend
provider credits; separate 10/min/IP limiter). Request lifecycle:

1. requireAuth → schema validation (question ≤ 2000 chars, optional
   24-hex conversationId) → workspace context → RBAC.
2. Optional conversation HISTORY (workspace-owned else 404): PUBLIC
   messages only in a bounded tail window (`AI_AGENT_HISTORY_*`). Internal
   notes are excluded IN THE QUERY and never enter agent context.
3. Prompt 13 retrieval for the question, scoped to the authorized
   workspace inside the store query (retrieval failures surface as coded
   503s — RAG_* codes passthrough, never stack traces).
4. Evidence gate (pure module `agent-grounding.ts`): answerability uses
   only MEASURED signals — passage count (`AI_AGENT_MIN_PASSAGES`),
   similarity floor (`AI_AGENT_MIN_CONTEXT_SCORE`) — model self-confidence
   is inadmissible. Insufficient evidence → 200 ABSTAINED with reason
   (`NO_KNOWLEDGE`, `LOW_RELEVANCE`, `INSUFFICIENT_EVIDENCE`) and NO
   provider call.
5. Bounded context assembly → provider generation under a strict
   untrusted-data system prompt (passages/history are DATA; instructions
   embedded in them are ignored; no invented facts).
6. Output contract: the model MUST return strict JSON
   `{answerable, answer, citations}`. Citation validation drops phantom
   references (spoofed/garbage numbers); a substantive answer with no
   valid surviving citation abstains (`UNCITED_ANSWER`); answers are
   truncated to `AI_AGENT_ANSWER_MAX_CHARS` with an ellipsis marker.
7. Citation metadata (source type, article title / document filename,
   chunk id) is resolved through the SAME workspace-scoped repositories —
   never from model text. No storage paths, signed URLs or infrastructure
   details in citations.

Structured payload: `status`, `answer | abstentionReason`, validated
`citations[]`, `topScore`, `passagesRetrieved`, `model`, honest
`tokenUsage` (nulls when the provider returns none). The answer is NOT
persisted — the contract is the Prompt 15 integration point, not a message
write.

Config (see `.env.example`): `AI_PROVIDER` (`openai` adapter implemented;
`gemini`/`bedrock` reserved), `AI_CHAT_BASE_URL`, `AI_CHAT_MODEL`,
`AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, and the `AI_AGENT_*` policy/bounds.
With `AI_PROVIDER=none` the endpoint answers safe 503
`AGENT_AI_NOT_CONFIGURED`; missing embeddings/keys surface `RAG_*` codes.
`npm run verify:agent` runs a 48-check end-to-end driver (RBAC, concealment,
validation, grounded answers with citation validation, abstention reasons,
provider/retrieval failures, conversation isolation, content-free audit
rows) against the mock provider via the chat factory's test seam.

Audit: `agent.question_answered` rows append outcome/abstention codes,
retrieval counts and ip/user-agent — never question/answer/prompt content.

## AI human handoff & escalation (Prompt 15, implemented)

An **escalation** is a workspace-scoped handoff record in
`modules/escalations/` (model → repository → service → controller → routes,
same layering as every other module). Mounted at
`/api/v1/workspaces/:workspaceId/escalations` under the SAME tenant context
middleware; RBAC: `escalation.view` (owner/admin/agent/viewer — the queue is
readable) and `escalation.manage` (owner/admin/agent — mutate), with
service-level ownership caps on top: assignment requires the
`ticket.assign` grant (same rule as tickets), only the current assignee may
ACCEPT an ASSIGNED record (privileged staff reassign instead), resolution is
the acceptee's or an administrator's, cancellation is the initiator's or an
administrator's.

**Lifecycle** (typed transition map in `escalation.types.ts`; invalid moves
are 409 `INVALID_ESCALATION_TRANSITION` with the allowed targets):
`PENDING → ASSIGNED (assign) | ACCEPTED (self-claim) | CANCELLED` ·
`ASSIGNED → ASSIGNED (triage reassignment, different assignee — same
assignee is an idempotent no-op) | ACCEPTED | CANCELLED` ·
`ACCEPTED → RESOLVED | ASSIGNED (reassignment resets acceptance) |
CANCELLED` · terminal `RESOLVED`/`CANCELLED`. Concurrency: optimistic
document-version guard in the repository — a stale writer gets 409
`ESCALATION_CONCURRENT_CHANGE`; repeated identical terminal actions are
idempotent (200).

**Active-escalation invariant:** exactly ONE active record
(`PENDING`/`ASSIGNED`/`ACCEPTED`) per conversation, enforced by a partial
unique index (`{ workspaceId, conversationId }` for active statuses) + a
race-safe create that re-reads after the duplicate-key error and REUSES the
existing record (200 with `created: false`) — duplicate triggers and racing
creations can never yield two active handoffs. After a terminal state a NEW
escalation may be created later.

**Automatic triggers** (pure rules in `escalation.rules.ts`; the agent never
creates records itself — `agent.service.ts` reports the MEASURED outcome of
every conversation-scoped ask through `noteAgentInteraction`, fire-safe so a
evaluation failure cannot corrupt the ask):

- **Explicit human request** (§3B) — keyword stems
  (`ESCALATION_HUMAN_REQUEST_KEYWORDS`) matched with word-boundary prefixes,
  case-insensitive. Generic, config-defined vocabulary — no company policy
  hardcoded. ✓1.6 ✓1.7 ✓1.8
- **Sensitive topics** (§3C) — `ESCALATION_SENSITIVE_TOPICS` format
  `key|kw1,kw2;key2|…` (billing/refund/account_access/security/legal/complaint
  defaults; all placeholder sets); trigger records the matched `topicKey`.
  Human-request detection dominates topic detection ✓1.6.
- **Insufficient knowledge** (§3A) — the ask ABSTAINED
  (`AI_INSUFFICIENT_KNOWLEDGE`, reasonCode = the Prompt 14 abstention code).
  Toggle: `ESCALATION_ON_ABSTENTION`. ✓6.6 ✓6.7
- **Repeated AI failure** (§3D) — after N consecutive unsuccessful asks in
  ONE conversation inside the lookback window (`ESCALATION_REPEATED_FAILURE
_THRESHOLD` 2–50, `ESCALATION_FAILURE_WINDOW_HOURS`), read from the audit
  trail (`agent.question_failed` + non-ANSWERED outcomes), conversation- and
  workspace-scoped → `AI_REPEATED_FAILURE` with
  `CONSECUTIVE_UNSUCCESSFUL_AI`. The repeated reason overrides single-shot
  reasons. ✓6.9b–✓6.14
- **Technical failure** (§3E) — provider/retrieval failures map to
  `TECHNICAL_FAILURE` with the actual failure code; toggled per environment
  (`ESCALATION_ON_TECHNICAL_FAILURE`). Misconfiguration classes
  (`*_NOT_CONFIGURED`, invalid config codes) are NEVER handoff triggers — a
  broken deployment cannot spawn work ✓1.1 ✓1.4. With the rule off, one
  failure is a documented safe fallback: the caller gets its 503 and no
  escalation exists ✓6.9.
- **Manual staff escalation** (§3F) — POST with the conversation id (client
  never supplies ticket/priority/initiator; ticket linkage + priority are
  server-derived) ✓3.1–✓3.3.

**Agent pause gate** (§5 step 6): while an ACTIVE escalation exists for a
conversation, `agent/ask` short-circuits BEFORE retrieval/provider with 409
`AGENT_HANDOFF_ACTIVE` (escalationId + status in details only) — the AI
cannot answer after human ownership ✓6.15 ✓6.16; a resolved/cancelled handoff
un-pauses ✓6.17 ✓6.18.

**Ticket integration:** creation transitions the associated ticket through
the EXISTING ticket lifecycle (`OPEN → IN_PROGRESS` by default) and records
`escalation.ticket_transitioned` (or `..._skipped` with a reason code when
no legal move exists); resolution drives the ticket toward RESOLVED where
the lifecycle allows ✓3.4 ✓3.15. No duplicate ticket model — the escalation
REFERENCES it.

**Assignment routing** (§6): assignees must be ACTIVE desk members of the
SAME workspace (same eligibility rule as ticket assignment — owner/admin/
agent; viewer ineligible; cross-workspace ids are rejected as ineligible
422 with no membership oracle ✓3.7). No invented availability/workload
metaphysics: no auto-balancing — the queue is PENDING; staff assign,
self-claim or reassign.

**Real-time events** (§9): publish-never-notify — `escalation.events.ts` is
a typed seam publishing content-free, id-only payloads (`workspaceId`,
`escalationId`, `conversationId`, `ticketId`, status/priority/assignee
codes) between repository write and audit append; delivery failure never
fails the REST operation ✓4.2 and audit + document carry the durable state.
A Socket.IO transport can be attached at the seam later; no guarantees
beyond at-most-once fan-out are claimed.

**Audit** (§10): `escalation.created/assigned/reassigned/accepted/resolved/
cancelled/ticket_transitioned/ticket_transition_skipped` — actor, ids,
trigger/reason/topic codes; notes/reasons and any conversation content are
never stored in audit metadata ✓8.1–✓8.3.

`npm run verify:escalations` runs the 75-check end-to-end driver (trigger
rules, RBAC/concealment/validation, manual lifecycle, reassignment,
cancellation, agent-triggered handoffs, pause gate, duplicate/create races,
assignment race + version-guard conflict, content-free audit/events) against
in-memory Mongo + the mock provider seam — no live OpenAI, S3 or Atlas.
Limitations (documented, not hidden): single-assignee model (no teams — none
exist in the data); no durable event queue (BullMQ remains a Prompt 12
outstanding dependency); Socket.IO transport shipped as a seam, not yet
attached to the live socket server events; AUTO ESCALATION priority is the
configured default, no per-trigger tuning beyond topic keys.

## Notifications & email (Prompt 16, implemented)

A workspace-scoped **in-app inbox** plus **transactional email** in
`modules/notifications/` (model → repository → preferences → mapping →
dispatcher → delivery service → controller → routes, same layering as every
other module). Mounted at `/api/v1/workspaces/:workspaceId/notifications`
under the SAME tenant context middleware.

**Request surface** (self-scoped — NO permission gate, because the resources
are the caller's own inbox/preferences; membership is the boundary):

| Method/Path | Purpose |
| --- | --- |
| `GET /notifications` | paginated inbox (`page`, `limit`, `unread`, `type`, `entityType`, `entityId`) |
| `GET /notifications/unread-count` | badge count |
| `POST /notifications/:notificationId/read` | mark one read (idempotent) |
| `POST /notifications/read-all` | mark every unread item of the caller |
| `GET /notifications/preferences` | effective preferences (defaults when never stored) |
| `PATCH /notifications/preferences` | partial update (audited) |

**Event integration.** Business modules publish typed, fire-safe events AFTER
persistence, through module-local buses (`tickets/ticket.events.ts`,
`conversations/conversation.events.ts`, and Prompt 15's
`escalations/escalation.events.ts`). The dispatcher subscribes once per
process (`registerNotificationDispatcher()`, called from `createApp`) and
schedules tracked in-process work, so a notification failure can never fail
the ticket/escalation/message operation it observes. Each event carries a
STABLE `eventKey` derived from persisted facts, which is what makes a
replayed event idempotent rather than a duplicate.

**Mapping is centralized** in `notification.mapping.ts` — the single place
that answers "who hears about what, and what does it say":

- ticket assignment/reassignment → the new assignee; status/priority changes →
  assignee + creator; unassigned ticket creation → members holding
  `ticket.assign` (deterministic order, capped by
  `NOTIFICATION_MAX_RECIPIENTS`);
- PUBLIC staff reply → ticket assignee + creator; INTERNAL notes → nobody
  (the event is published, the mapping ignores it);
- escalation created (manual) → members holding `escalation.manage`;
  AI-initiated handoffs → `ai.handoff`, technical failures → `ai.failure`;
  assignment → the assignee; acceptance → the previous assignee; resolution/
  cancellation → the involved staff;
- the ACTING user is always excluded — nobody is notified about their own
  action — and titles/bodies are composed only from machine facts (ticket
  number, status, priority, trigger code). Conversation bodies, internal
  notes, AI prompts, retrieved passages and resolution/cancel notes are never
  read by the mapping, so they cannot leak into a preview or an email.

**Preferences** (`notification_preferences`, one row per workspace+user):
channel switches (`inAppEnabled`, `emailEnabled`) and category switches
(`ticketAssignment`, `ticketUpdates`, `publicReplies`, `escalations`,
`aiHandoff`), all defaulting ON. Every notification type maps to exactly one
category (a `Record<NotificationType, …>` compile-time law). Category
switches gate BOTH channels; channel switches are independent. Reads resolve
defaults without writing; the first PATCH is an atomic upsert, so no duplicate
rows and no read-then-write race. Updates are audited as
`notification.preferences_updated` with FIELD NAMES only.

**Email provider abstraction** (`email/`): `EmailProvider` interface with
`log` (dev/test outbox — logs metadata only, refuses to run in production),
`smtp` (nodemailer; timeouts from `EMAIL_TIMEOUT_MS`) and `ses` (the SES SMTP
endpoint through the same transport — there is no SES API adapter).
Recipient and sender addresses are validated before contacting the provider;
provider failures are normalized to stable machine codes and classified
permanent vs transient (auth/envelope/5xx vs timeout/connection/4xx). No
credential is ever logged or returned. Auth emails (verify/reset) use the SAME
configured provider — the dev outbox in development, SMTP/SES in production —
so a real deployment no longer has a provider it cannot send through.

**Templates** (`email/email.templates.ts`): one branded responsive layout with
a per-type registry (subject prefix + label) — the seven required templates
(new-ticket, assignment, status update, public reply, escalation,
escalation assignment, escalation resolution) plus the AI variants, always
with a plain-text alternative. Every dynamic value is HTML-escaped (ticket
subjects and workspace names are user-controlled), subjects have CR/LF
stripped (header injection), and NO links are emitted because the client app
has no ticket/escalation routes yet — a link builder belongs here once those
exist.

**Delivery lifecycle & honest retry story.** The ledger row is written BEFORE
any provider call, then attempted inline once. `SENT` means the provider
ACCEPTED the message — there is no delivery webhook, so inbox delivery is
never claimed. Transient failures leave `RETRY_PENDING` with exponential
backoff (`NOTIFICATION_EMAIL_RETRY_BASE_MS`, capped at 1h) and advance only
when one of these explicit entry points runs:

- `sweepEmailDeliveries(workspaceId, limit)` — the documented cron/worker
  hook (workspace-scoped on purpose: no unscoped collection scan exists).
- `attemptEmailDelivery(workspaceId, deliveryId)` — one atomic claim
  (`PENDING`/`RETRY_PENDING → PROCESSING`, `attempts += 1`), so two sweepers
  cannot send the same row twice.

There is NO queue and NO worker in this deployment (Redis/BullMQ was never
installed — Prompt 12 dependency), so nothing here spawns timers or unowned
loops; a `PROCESSING` row from a crashed attempt stays `PROCESSING` (no lease
reaper yet). Exactly-once delivery is not claimed anywhere; one email per
event per recipient IS enforced by the unique ledger index.

**Real-time status.** `notification.publisher.ts` is the publication seam: it
is invoked only AFTER the notification persisted, is fire-safe, and receives
exactly the recipient id the future socket layer must authorize against. The
Socket.IO server itself does not exist yet (`sockets/README.md` — prepared,
not implemented), so no live real-time notification delivery is claimed; the
frontend badge/list can already be built on the REST endpoints.

**Security & isolation:** every notification read/mutation filters on
`{ workspaceId (validated param), recipientId = req.auth.userId }`; a
foreign or unknown id is 404 (no existence oracle), other users' inboxes are
unreachable by construction, and no endpoint accepts a recipient/user id.
Emails contain no internal note, message body, AI prompt, credential or
storage path; the ledger stores content-safe title/body but never rendered
HTML, and email bodies are never logged.

`npm run verify:notifications` runs the 61-check end-to-end driver (channel
policy, template escaping, ticket/conversation/escalation mapping, inbox
isolation and read lifecycle, preferences + audit, provider failure/retry/
exhaustion/invalid-recipient, duplicate-event idempotency, publisher failure)
against in-memory Mongo and mock provider objects — no live SMTP, Redis or
Atlas.

## Search, filtering & pagination (Prompt 17, implemented)

One shared primitive module (`core/query/search-query.ts`) owns literal
regex escaping (`escapeRegexLiteral` / `literalSearchOr`), the bounded
search-term schema (≤100 chars) and the page/limit factory. Every searcher
composes through it, so a user term can never execute as a regex — the
escape exists in exactly one place. Module repositories keep constructing
queries; controllers stay one-line HTTP adapters.

**Module search extensions** (existing endpoints, additive query params,
all `.strict()` — unknown keys are 422):

| Entity | Searchable fields | New filters/sort (Prompt 17) |
| --- | --- | --- |
| Tickets | number, subject, **description** | (status/priority/agent/customer/tags/created+updated ranges/sort already existed) |
| Customers | name, email, **phone** | (status/tags/date range/sort already existed) |
| KB articles | title, summary, **body** | management listing unchanged; unified search passes `excludeArchived` |
| Escalations | reasonCode, topicKey | `ticketId`, `conversationId`, `customerId`, `createdFrom/To`, `sort=createdAt\|updatedAt\|priority`, `order` |
| Notifications | title, body | `createdFrom/To` (recipient scope is structural) |
| Messages | body (one conversation only) | `search` on `GET …/conversations/:id/messages` |

**Unified endpoint** — `GET /api/v1/workspaces/:workspaceId/search`
(`requireAuth → 60/min limiter → validate(params) →
requireWorkspaceContext → validate(query)`):

```
?q=<1..100 chars literal term>   required
?types=ticket,customer,knowledge_base_article,escalation,conversation,notification
?limit=1..25 (default 10, PER TYPE)
```

- It is a bounded **preview**, not a paginated authority: no cursor, no
  totals, no deep paging. The module endpoints remain the paginated read
  paths.
- RBAC is applied per entity BEFORE querying (`ticket.view`,
  `customer.view`, `kb.view`, `escalation.view`, `conversation.view`). A type
  the role cannot read is reported in `skippedTypes`, never queried — so its
  results cannot hint at record existence. No current role lacks any of
  those read scopes (viewer holds all five), so `skippedTypes` is empty in
  practice today; the mechanism is what matters when a narrower role or
  permission is added.
- Notifications are self-scoped by construction (`recipientId = req.auth`,
  no permission gate) — exactly the Prompt 16 inbox law.
- Results carry `type`, `id`, a short `title`, optional `snippet` and string
  `metadata` only. Customer email/phone, ticket descriptions, message bodies,
  internal notes and file content never enter unified results — the fan-out
  maps each module's existing DTO-level fields and stops there.
- Messages are deliberately NOT in unified search: message search is
  conversation-scoped (`…/conversations/:id/messages?search=`), where the
  existing conversation authorization proves access and the visibility
  predicate excludes INTERNAL notes IN THE QUERY for roles without staff
  visibility.

**Pagination strategy (unchanged contract, tightened inputs).** The project
established page/limit before Prompt 17; replacing it with cursors would
have rewritten every list endpoint and its clients for no measured gain, so
the strategy is standardised instead: `page ≥ 1`, `limit` default 20, hard
caps 50 (tickets/customers/KB/conversations/messages/workspaces) and 100
(escalations/notifications), invalid values 422, deterministic sort with an
`_id` tiebreak everywhere (no duplicates/skips across sequential pages),
empty past-the-end pages return `hasMore: false` with `total` intact, and
`total` is only computed where the existing contract returns it (one
`countDocuments` per list — documented cost, not hidden). Unified search
returns counts per type instead of a `total`.

**Security summary.** Every query is composed inside
`tenantFilter()`/`assertTenantScope()`; foreign ids in reference filters
(`ticketId`, `customerId`, …) are ordinary filters, so they return zero rows
with no existence oracle; the workspace always comes from the validated
middleware context; notification search composes on top of `recipientId`;
operator-shaped params (`search[$ne]`) are rejected by the strict string
schemas (422); malformed cursors are moot (no cursor API). Audit is
unchanged: search is read-only and writes no audit rows.

**Capability honesty.** This is ordinary MongoDB querying: case-insensitive
literal substring matching over allowlisted fields, with no relevance
ranking, fuzzy matching, Atlas Search, Elasticsearch, Redis or new
infrastructure. Substring scans read the tenant's slice (bounded by tenant
size and page limit); there is no text index. Prompt 13's RAG/vector
retrieval is untouched — this prompt is application search only.

**Verification** — `npm run verify:search` (77 checks: module search,
regex-literal safety, filters, pagination, tenant isolation, notification
recipient isolation, internal-note privacy, unified search RBAC fan-out).

## Analytics & reporting (Prompt 18, implemented)

Read-only workspace analytics (`modules/analytics/`) computed on request from
the records the existing modules already persist. No new collection, no
pre-aggregation/rollup store, no AI/RAG change, no queue. Endpoints share one
gate chain — `requireAuth → 60/min limiter → validate(params) →
requireWorkspaceContext → requirePermission('analytics.view') →
validate(query)` — so the workspace comes from `req.workspace` and the actor
from `req.auth`; no client-supplied id can widen scope. `analytics.view`
already existed and is granted to owner/admin only, so agents and viewers get
403 while strangers get 404 concealment.

| Endpoint (`/api/v1/workspaces/:workspaceId/analytics`) | Purpose |
| --- | --- |
| `GET /overview` | KPI snapshot: tickets, customers, conversations, escalations, KB, AI |
| `GET /tickets` | Status/priority/assignment breakdowns, created/resolved trends, resolution durations |
| `GET /performance` | Backlog, unassigned work, first staff reply, escalation ratio, message volume |
| `GET /ai` | Audit-trail-derived AI outcomes, citations, abstentions, handoffs, trend |
| `GET /reports/tickets.csv` | Bounded ticket CSV (machine fields only) |

**Window semantics.** `from` is inclusive, `to` is exclusive, on every endpoint
and aggregation, so adjacent windows never double-count. Presets are
`today` (current UTC day start → now), `7d`, `30d` (default), `90d`; `custom`
requires both bounds and cannot be combined with a preset. Bounds are ISO-8601
datetimes with an offset, strictly ordered, and capped at 366 days; violations
are 422. Unknown query keys and operator-shaped params are rejected by strict
schemas. All computation is UTC, including `$dateTrunc` buckets (week starts
Monday, month starts on the 1st); series are zero-filled across the window.

**Metric definitions (every value traces to a persisted field).**

| Metric | Source / definition |
| --- | --- |
| `tickets.total`, `byStatus`, `byPriority`, `assignment`, `topAssignees` | live tickets (`deletedAt: null`); snapshot counts, not windowed; assignees are top 10 agent ids by count, id tiebreak, ids only |
| `tickets.createdInPeriod` / `resolvedInPeriod` | `createdAt ∈ [from,to)` / `resolvedAt ≠ null ∈ [from,to)` — never `updatedAt` |
| `customers.*` | live customers; `status` is the real vocabulary `active`/`blocked` |
| `conversations.*` | conversations whose parent ticket is live and same-workspace (bounded `$lookup`); there is no conversation status, so `closed` = parent RESOLVED/CLOSED |
| `escalations.*` | real escalation statuses; `active` = PENDING/ASSIGNED/ACCEPTED |
| `knowledgeBase.*` | article `status` groups; ARCHIVED is a first-class status, not a soft delete |
| `ai.requests/answered/abstained/failed` | `audit_logs` rows with `resourceType: 'agent_response'`; failed = `agent.question_failed`; one row per ask, so a provider retry is never an extra answer |
| `ai.citationBackedAnswers` | ANSWERED asks with `metadata.citationsCount > 0` |
| `ai.aiEscalations` / `humanHandoffs` | escalations created in window with `initiatedBy.actorType: 'AI_AGENT'`; manual STAFF escalations excluded from the AI count (they are counted separately as escalation events) |
| `performance.backlog.*` | live OPEN/IN_PROGRESS/WAITING_FOR_CUSTOMER tickets, their priority mix and the `agentId: null` subset |
| `performance.resolutionTime` | `resolvedAt − createdAt` for real stamps inside the window; unresolved, null-stamp and negative durations excluded; median is MongoDB 7 `$percentile` (approximate) |
| `performance.firstStaffReply` | conversation `createdAt` → FIRST `PUBLIC` `AGENT` message; INTERNAL notes are excluded in the lookup, only first replies landing in the window count, negative durations excluded |
| `performance.escalationFrequency` | escalations created / tickets created (4 dp), `null` when no tickets — a ratio, not a percentage |
| `performance.conversationVolume` | conversations created in window and message counts by visibility in window |
| `performance.customerFirstResponse` | `{ available: false, reason }` — no customer-sender messages exist before customer-portal auth, so this is reported unavailable instead of fabricated |
| CSV report | live tickets CREATED in the window, capped at 5,000 rows: number, status, priority, created_at, resolved_at, resolution_minutes, assigned |

**Honest limitations (also returned/encoded in code comments):**

- **UTC only.** `workspace.settings.timezone` is a free-form ≤64-char string,
  not a validated IANA zone, so it is deliberately not used for bucketing.
- **No cross-collection snapshot.** This deployment has no multi-document
  transactions: one response is a set of independent aggregation reads, so two
  metrics can reflect instants milliseconds apart.
- **Aggregations bypass Mongoose pre-query hooks**, so every pipeline composes
  `deletedAt: null` (and parent-ticket liveness) explicitly rather than
  inheriting it.
- **AI metrics are usage of the audit trail, not live provider telemetry.**
  `aiProviderConfigured` reports `AI_PROVIDER !== 'none'` (configuration),
  not proof of provider calls; prompts/answers are never read or returned.
- No scheduled/emailed reports, no precomputed rollups, no export beyond the
  bounded ticket CSV, and no timezone selection.

**Export safety.** `Content-Type: text/csv`, `Content-Disposition:
attachment`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; the
filename is sanitized. Every cell passes `csvCell`, which quotes delimiters
and prefixes `= + - @ TAB CR` with `'` (formula-injection defence). The report
is machine fields only — no subject, description, customer identity or
resolution note can reach the file.

**Performance & indexes.** Counts are `$group`/`$facet` over the workspace
slice; the only `$lookup`s verify the parent ticket and are project-bounded
(no `$unwind` fan-out, so nothing is double-counted). Response size is fixed
by shape and the export cap. Three indexes were added for the new range shapes
(see `docs/data-model.md`): tickets `{ workspaceId, resolvedAt }`, messages
`{ workspaceId, createdAt: -1 }`, audit_logs
`{ workspaceId, resourceType, createdAt: -1 }`.

**Verification** — `npm run verify:analytics` (77 checks: RBAC/concealment,
overview counts, archived exclusion, presets/custom windows and rejects,
trends and bucket alignment, resolution-duration exclusions, first-reply
INTERNAL exclusion, unavailable customer response, audit-derived AI metrics,
tenant isolation, empty-workspace zeros, CSV headers/fields/escaping/bounds).

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

## Real-time (prepared, NOT implemented — verified in Prompt 23)

**Status: no transport exists.** Re-checked while building the inbox:
`socket.io` is not in `server/package.json`, `server.ts` starts an HTTP server
but never constructs a Socket.IO instance, and `server/src/sockets/` contains
only `README.md` with the *planned* structure. The typed seams that do exist
are server-local event buses that publish AFTER persistence:
`notification.publisher.ts`, `escalation.events.ts` and
`conversation.events.ts` (the last one emits IDs, sender type and visibility —
never a message body). No subscriber forwards them to a socket.

Consequence for the client (Prompt 23): the support inbox uses REST only, opens
no socket connection, and does not poll. It surfaces the limitation in the UI
(`client/src/features/inbox/realtime-status.ts`) with manual refresh, so no
screen claims live updates.

When implemented, the agreed design is unchanged: Socket.IO attaches to the
existing HTTP server (no second port); handshake JWT auth → `socket.data = {
userId, workspaceId, role }`; rooms are `workspace:{id}` / `conversation:{id}`;
a socket may only join rooms inside its own workspace; typed
`ClientToServerEvents`/`ServerToClientEvents` are shared with the client.
Outstanding backend work before the client can subscribe:

1. install `socket.io` and attach it to the existing `http.Server`;
2. JWT handshake middleware that rejects anonymous connections;
3. room authorization derived from the verified membership — never from a
   client-supplied workspace/conversation id;
4. bridge `conversationEventBus` → `conversation:{id}` rooms with body-free
   payloads (message bodies stay in the REST read path);
5. a shared event-type module the client can import.

## Development seed (implemented)

`npm run seed:dev` seeds two tenants, four accounts and five customers into a
**localhost-only** database (the script refuses any other host). The
implementation lives in `scripts/dev-seed.ts`; `scripts/seed-dev-data.ts` is
the CLI wrapper and `scripts/verify-seed.ts` (`npm run verify:seed`) is its
regression driver.

Two defects shipped in the original seed and were fixed in Prompt 23:

| Defect | Root cause | Fix |
| --- | --- | --- |
| `dev-password-123` did not authenticate | The seed stored a hard-coded bcrypt string that was not a hash of the documented password, so `verifyPassword()` could never match it. | The seed now hashes `DEV_PASSWORD` at run time with the auth module's own `hashPassword()` (bcrypt cost 12 — the same call registration uses). Existing rows whose hash does not verify are re-hashed. The plaintext is never persisted and auth code is untouched. |
| `GET /workspaces` threw `Cannot read properties of undefined (reading 'toHexString')` | The seed upserted workspaces with `$setOnInsert: { name, slug, status }` and never set `ownerId`. `findOneAndUpdate` does not run `required` validators, so the required `ownerId` field was simply absent, and the workspace DTO mapping dereferenced it. | The owner account is upserted **first**, then the workspace is created with `ownerId`, then memberships. A guarded `updateOne` backfills `ownerId` on legacy documents only when it is missing/null, so a valid owner is never overwritten. |

`verify:seed` runs the real seed twice against an isolated in-memory mongod,
simulates both defects (unset `ownerId`, replace the hash), proves the re-seed
repairs them, and then over real HTTP checks that the documented account logs
in, a wrong password is rejected, `GET /workspaces` returns the owned workspace
with a valid `ownerId`, the second tenant sees only its own workspace, and a
foreign workspace id is concealed with 404. Result: 23/23 checks.

## Background jobs (prepared)

BullMQ + Redis for: document ingestion (chunk → embed → index), notification
fan-out, analytics rollups, stale-ticket sweeps. Queues outlive deploys and
give retries/backoff for AI-provider calls. Details: `server/src/jobs/README.md`.

Until then, notification email retries are NOT a background job: failed rows
sit in `email_deliveries` as `RETRY_PENDING` and only advance when
`sweepEmailDeliveries(workspaceId)` is invoked (a cron entry point can call it
today).

## AI seam

Feature code depends only on `RagService` / `EmbeddingService` /
`StorageService` interfaces (in `modules/*/interfaces`). Provider SDKs
(OpenAI, Gemini, Bedrock…) are implementation details behind a registry —
swappable per environment and fakeable in tests. The AI phase adds
`AiProvider` implementations plus an ingestion worker; no feature module
imports an SDK directly.

## Storage seam

`StorageService` interface (realized in `modules/documents/storage/` —
server-mediated put/get/delete for the Prompt 12 upload/download flows,
presigned upload/download reserved for a later direct-upload phase).
Production driver: S3 (+ CloudFront for delivery, SSE for encryption,
lifecycle rules for retention). Development driver: local disk — same
interface, zero feature-code changes; local production is an explicit,
boot-guarded decision (`STORAGE_ALLOW_LOCAL_PRODUCTION`).

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

Full detail lives in [`docs/frontend.md`](frontend.md); the invariants:

- **Feature-first modules**: `features/<domain>/` owns a domain's types,
  service, store and components. Cross-feature imports are not allowed; shared
  code goes to `components/`, `hooks/`, `services/`, `utils/`.
- **Design system** in `components/ui` — semantic tokens only (`bg-surface`,
  `text-muted`, `border-border`), light/dark via `data-theme` on `<html>`.
  Features compose these components instead of writing Tailwind clusters.
- **State**: Zustand for UI state (sidebar, theme), session and active
  workspace; everything else is local. Server data flows through typed
  services, never through components building URLs.
- **Routing**: React Router 7 data router. Public: `/login`, `/reset-password`.
  `/workspaces/select` requires a session only; the application shell is
  wrapped by `RequireAuth` (silent refresh-cookie bootstrap → `/auth/me`) then
  `RequireWorkspace` (loads `GET /workspaces`, redirects accounts with no active
  membership to the picker), with lazy page chunks.
- **Auth & tenancy UI**: a real sign-in form (server-authorized credentials,
  trimmed email, untouched password, safe error copy), forgot/reset-password
  flows against the existing endpoints, honest sign-out (`remoteRevoked`),
  workspace selection/creation only after server confirmation, and a workspace
  switcher that never treats its selection as authorization.
- **API client**: single `fetch` owner with bearer injection, request timeout,
  envelope unwrapping, one single-flight refresh-and-retry on 401, and a
  refresh-block after failure (no loops). Access tokens stay in memory; the
  refresh token stays in its HttpOnly cookie.
- **Dashboard analytics**: the page-scoped `useDashboardAnalytics` hook reads
  `/analytics/overview`, `/tickets` and `/performance` for the active
  workspace. A request sequence plus a synchronous scope guard ensures a
  previous workspace/range can neither render nor overwrite after a switch;
  the frontend never computes a business metric the backend defines.
- **Analytics permissions**: the client renders 403 as a non-retryable access
  state. It does not attempt to infer or grant `analytics.view`; the server
  remains the authorization boundary.
- **Error containment**: `ErrorBoundary` at the app root; shared
  `LoadingState`/`ErrorState`/`EmptyState` keep async surfaces consistent, and
  toasts cover mutation feedback.
- **Testing**: Vitest + Testing Library (jsdom) for component contracts and
  the API client's refresh/error behaviour.

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
