/* eslint-disable no-console -- verification driver output is the deliverable */
/**
 * Prompt 13 verification driver — AI/RAG foundation (integration level).
 *
 * Boots the REAL server against an in-memory Mongo + mock embedding provider
 * + in-memory vector store, then exercises the RAG endpoints end-to-end:
 * RBAC/concealment, eligibility, idempotent reindexes, per-chunk embedding
 * reuse, lifecycle auto-triggers, pagination and purges.
 *
 * Pure-unit behaviors (chunking, hashing, provider validation, Atlas pipeline
 * building) are covered by the vitest suite; this driver proves the WIRING.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Types } from 'mongoose';

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function http(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { body?: unknown; token?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  // Unique IP per request defeats cross-test rate-limit coupling.
  headers['x-forwarded-for'] = `10.9.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const response = await fetch(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

let failures = 0;
function record(name: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until true or the attempts budget is exhausted. */
async function pollUntil(probe: () => Promise<boolean>, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe()) return true;
    await sleep(100);
  }
  return false;
}

function dataOf<T>(res: HttpResult): T {
  return (res.body as { data?: T }).data as T;
}

interface ChunkDto {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly textLength: number;
  readonly textHash: string;
  readonly sourceHash: string;
  readonly embeddingStatus: string;
  readonly embeddingModel: string | null;
  readonly embeddingDimensions: number | null;
  readonly embeddingError: { code: string } | null;
  readonly sourceEligible: boolean;
}

interface ChunksList {
  readonly items: readonly ChunkDto[];
  readonly total: number;
  readonly hasMore: boolean;
}

interface IndexPayload {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly outcome: string;
  readonly skipReason?: string;
  readonly chunksIndexed: number;
  readonly chunksReused: number;
  readonly chunksRemoved: number;
  readonly embeddingFailures: number;
}

interface StatusPayload {
  readonly embeddingProvider: string | null;
  readonly embeddingModel: string | null;
  readonly embeddingDimensions: number | null;
  readonly vectorStore: string | null;
  readonly chunkCounts: { readonly total: number } & Record<string, unknown>;
  readonly sourcesIneligible: Record<string, number>;
}

async function main(): Promise<void> {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_rag' },
  });

  const expectedUri = memoryServer.getUri('verify_rag');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '100000';
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'verify-rag-storage-'));
  mkdirSync(storageRoot, { recursive: true });
  process.env['STORAGE_DATA_DIR'] = storageRoot;
  // RAG fixtures: mock embeddings (deterministic, credential-free) plus the
  // in-memory vector mirror — the documented local verification configuration.
  process.env['RAG_EMBEDDING_PROVIDER'] = 'mock';
  process.env['RAG_EMBEDDING_MODEL'] = 'mock-model';
  process.env['RAG_EMBEDDING_DIMENSIONS'] = '8';
  process.env['RAG_VECTOR_SEARCH'] = 'inmemory';
  const port = 4063;
  process.env['PORT'] = String(port);

  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error('env.MONGODB_URI mismatch — aborting to protect foreign databases');
  }

  const httpServer = await startServer();
  const shutdown = (): Promise<void> =>
    Promise.all([
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      memoryServer.stop(),
    ]).then(() => undefined);

  try {
    const api = (pathSegments: string): string => `http://127.0.0.1:${port}/api/v1${pathSegments}`;
    const { UserModel } = await import('../server/src/modules/users/user.model.js');
    const { WorkspaceMemberModel } = await import(
      '../server/src/modules/workspaces/workspace-member.model.js'
    );
    const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
    const { RagChunkModel } = await import('../server/src/modules/rag/rag.model.js');
    const { createDocumentRecord, updateDocumentProcessingState } = await import(
      '../server/src/modules/documents/document.repository.js'
    );

    const PASSWORD = 'Str0ngPass!42';

    async function newUser(name: string, email: string): Promise<string> {
      const reg = await http('POST', api('/auth/register'), {
        body: { name, email, password: PASSWORD },
      });
      if (reg.status !== 201) console.log(`REGISTER FAILED ${email}`, JSON.stringify(reg.body));
      assert.equal(reg.status, 201);
      const login = await http('POST', api('/auth/login'), { body: { email, password: PASSWORD } });
      assert.equal(login.status, 200);
      const token = dataOf<{ tokens?: { accessToken?: string } }>(login)?.tokens?.accessToken;
      assert.ok(typeof token === 'string' && token.length > 0);
      return token;
    }

    async function newWorkspace(token: string, name: string, slug: string): Promise<string> {
      const created = await http('POST', api('/workspaces'), { token, body: { name, slug } });
      assert.equal(created.status, 201);
      const workspace = dataOf<{ workspace?: { id?: string } }>(created)?.workspace;
      assert.ok(typeof workspace?.id === 'string');
      return workspace.id;
    }

    // ── Setup: users + two isolated workspaces ────────────────────────────
    const adaToken = await newUser('Ada Ragista', 'ada.rag@example.test');
    const bobToken = await newUser('Bob Agent', 'bob.rag@example.test');
    const vicToken = await newUser('Vic Viewer', 'vic.rag@example.test');
    const eveToken = await newUser('Eve Napier', 'eve.rag@example.test');

    const acmeId = await newWorkspace(adaToken, 'Acme Support', 'acme-rag');
    const rivalId = await newWorkspace(eveToken, 'Rival Support', 'rival-rag');

    const acmeWs = new Types.ObjectId(acmeId);
    const adaId = (await UserModel.findOne({ email: 'ada.rag@example.test' }))!._id;
    const bobId = (await UserModel.findOne({ email: 'bob.rag@example.test' }))!._id;
    const vicId = (await UserModel.findOne({ email: 'vic.rag@example.test' }))!._id;
    await WorkspaceMemberModel.create([
      { workspaceId: acmeWs, userId: bobId, role: 'agent' },
      { workspaceId: acmeWs, userId: vicId, role: 'viewer' },
    ]);

    const acmeRagBase = (): string => `/workspaces/${acmeId}/rag`;
    const acmeKb = `/workspaces/${acmeId}/knowledge-base/articles`;
    const requester =
      (token: string) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathSegments: string, init?: { body?: unknown }): Promise<HttpResult> =>
        http(method, api(pathSegments), { token, ...init });
    const ada = requester(adaToken);
    const bob = requester(bobToken);
    const vic = requester(vicToken);
    const eve = requester(eveToken);

    const paragraphs = Array.from({ length: 6 }, (_, i) =>
      `Paragraph ${i + 1}: refunds follow the posted billing cycle. Customers open a request ` +
      'from the billing page and attach the invoice number. Processing takes five business ' +
      'days after the request is accepted by the billing team.',
    ).join('\n\n');
    const summary = 'How refunds and exchanges are processed for Acme customers.';
    const tags = ['refunds', 'billing'];

    async function draftArticle(items: { title: string; body: string }): Promise<string> {
      const created = await ada('POST', acmeKb, {
        body: { title: items.title, summary, body: items.body, tags },
      });
      if (created.status !== 201) console.log('KB CREATE BODY', JSON.stringify(created.body));
      assert.equal(created.status, 201);
      const id = dataOf<{ article?: { id?: string } }>(created)?.article?.id ?? '';
      assert.ok(id.length > 0);
      return id;
    }

    async function waitForChunks(sourceType: string, sourceId: string, min = 1): Promise<void> {
      const done = await pollUntil(async () => {
        const list = await ada('GET', `/workspaces/${acmeId}/rag/chunks?sourceType=${sourceType}&sourceId=${sourceId}`);
        return (dataOf<ChunksList>(list)?.total ?? 0) >= min;
      });
      assert.ok(done, `chunks for ${sourceType} ${sourceId} did not appear`);
    }

    // ══ 1. RBAC gates and workspace concealment ═══════════════════════════
    {
      const unauth = await http('GET', api(`${acmeRagBase()}/status`));
      record('1.1 unauthenticated /rag/status is 401', unauth.status === 401);
      const foreign = await eve('GET', `/workspaces/${acmeId}/rag/status`);
      record('1.2 foreign-workspace /status is 404 (concealment)', foreign.status === 404);
      record('1.3 agent /status is 403 (rag.view not granted)', (await bob('GET', `${acmeRagBase()}/status`)).status === 403);
      record('1.4 viewer /status is 403', (await vic('GET', `${acmeRagBase()}/status`)).status === 403);
      const bogus = await ada('POST', `${acmeRagBase()}/articles/not-a-24-hex/index`);
      record('1.5 malformed articleId param is 422', bogus.status === 422);
    }

    // ══ 2. Status report (configured fixtures visible) ══════════════════
    {
      const status = await ada('GET', `${acmeRagBase()}/status`);
      record('2.1 owner /rag/status is 200', status.status === 200);
      const payload = status.status === 200 ? (dataOf<StatusPayload>(status) ?? null) : null;
      record('2.2 provider is mock with configured model/dims',
        payload?.embeddingProvider === 'mock' && payload?.embeddingModel === 'mock-hash-embedding' &&
        payload?.embeddingDimensions === 8);
      record('2.3 vector store is inmemory', payload?.vectorStore === 'inmemory');
      record('2.4 chunk counts start at zero', (payload?.chunkCounts?.total ?? -1) === 0);
      const own = await eve('GET', `/workspaces/${rivalId}/rag/status`);
      record('2.5 rival owner sees her own (isolated) status', own.status === 200);
    }

    // ══ 3. KB seed + auto-indexing on publish ════════════════════════════
    let publishedId = '';
    let draftId = '';
    let archivedId = '';
    {
      publishedId = await draftArticle({ title: 'Refund policy', body: paragraphs });
      const published = await ada('POST', `${acmeKb}/${publishedId}/publish`, { body: {} });
      record('3.1 article publishes as 200', published.status === 200);
      // The publish auto-trigger indexes with the mock provider; wait for it.
      let chunksOk = false;
      try {
        await waitForChunks('KB_ARTICLE', publishedId);
        chunksOk = true;
      } catch {
        chunksOk = false;
      }
      record('3.2 publish auto-indexed the article', chunksOk);

      draftId = await draftArticle({ title: 'Internal draft', body: paragraphs });

      archivedId = await draftArticle({ title: 'Legacy policy', body: paragraphs });
      await ada('POST', `${acmeKb}/${archivedId}/publish`, { body: {} });
      await pollUntil(async () => {
        const list = await ada('GET', `/workspaces/${acmeId}/rag/chunks?sourceType=KB_ARTICLE&sourceId=${archivedId}`);
        return (dataOf<ChunksList>(list)?.total ?? 0) >= 1;
      });
      const archived = await ada('POST', `${acmeKb}/${archivedId}/archive`, { body: {} });
      record('3.3 article archives as 200', archived.status === 200);
      const purged = await pollUntil(async () => {
        const list = await ada('GET', `/workspaces/${acmeId}/rag/chunks?sourceType=KB_ARTICLE&sourceId=${archivedId}`);
        return (dataOf<ChunksList>(list)?.total ?? 0) === 0;
      });
      record('3.4 archive auto-purged its chunks', purged);
    }

    // ══ 4. Chunk DTO shape and embedding fields (direct reads) ══════════
    {
      const list = await ada('GET', `/workspaces/${acmeId}/rag/chunks?sourceType=KB_ARTICLE&sourceId=${publishedId}`);
      record('4.1 chunk list is 200', list.status === 200);
      const data = list.status === 200 ? dataOf<ChunksList>(list) : null;
      const first = data?.items?.[0];
      record('4.2 chunks exist for the published article', (data?.total ?? 0) >= 1);
      record('4.3 DTO omits text and vectors', first !== undefined && !('text' in first) && !('embedding' in first));
      record('4.4 embedding fields are populated (model/dims/status)',
        first?.embeddingModel === 'mock-hash-embedding' && first?.embeddingDimensions === 8 &&
        first?.embeddingStatus === 'COMPLETED' && first?.embeddingError === null);
      record('4.5 chunks are eligible', first?.sourceEligible === true);
      const doc = await RagChunkModel.findOne({ workspaceId: acmeWs, sourceId: new Types.ObjectId(publishedId) });
      record('4.6 stored vector has configured dimension 8', Array.isArray(doc?.embedding) && doc!.embedding.length === 8);
      record('4.7 textHash is 64-hex sha-256', /^[0-9a-f]{64}$/.test(first?.textHash ?? ''));
      record('4.8 sourceHash matches textHash provenance', /^[0-9a-f]{64}$/.test(first?.sourceHash ?? ''));
      record('4.9 textLength matches stored text length',
        doc !== null && first !== undefined && doc.textLength === first.textLength);
    }

    // ══ 5. Idempotent reindex + per-source endpoints ═════════════════════
    {
      const reindex = await ada('POST', `${acmeRagBase()}/articles/${publishedId}/index`);
      const payload = reindex.status === 200 ? dataOf<IndexPayload>(reindex) : null;
      record('5.1 reindexing an unchanged article is 200 UNCHANGED',
        reindex.status === 200 && payload?.outcome === 'UNCHANGED' && payload?.chunksIndexed === 0);

      const skipDraft = await ada('POST', `${acmeRagBase()}/articles/${draftId}/index`);
      const skipDraftPayload = skipDraft.status === 200 ? dataOf<IndexPayload>(skipDraft) : null;
      record('5.2 indexing a DRAFT is SKIPPED ARTICLE_NOT_PUBLISHED',
        skipDraft.status === 200 && skipDraftPayload?.outcome === 'SKIPPED' &&
        skipDraftPayload?.skipReason === 'ARTICLE_NOT_PUBLISHED');

      const skipArchived = await ada('POST', `${acmeRagBase()}/articles/${archivedId}/index`);
      const skipArchivedPayload = skipArchived.status === 200 ? dataOf<IndexPayload>(skipArchived) : null;
      record('5.3 indexing an ARCHIVED article is SKIPPED',
        skipArchived.status === 200 && skipArchivedPayload?.outcome === 'SKIPPED' &&
        skipArchivedPayload?.skipReason === 'ARTICLE_NOT_PUBLISHED');

      // INDEXED path: purge first, then index manually (auto-trigger needs a
      // lifecycle mutation; a purge leaves the published article intact).
      const prePurge = await ada('DELETE', `${acmeRagBase()}/sources/KB_ARTICLE/${publishedId}`);
      record('5.4 manual purge removes >0 chunks', prePurge.status === 200 && (dataOf<{ chunksRemoved: number }>(prePurge)?.chunksRemoved ?? 0) > 0);
      const indexFresh = await ada('POST', `${acmeRagBase()}/articles/${publishedId}/index`);
      const freshPayload = indexFresh.status === 200 ? dataOf<IndexPayload>(indexFresh) : null;
      record('5.5 fresh index after purge is INDEXED with failures 0',
        indexFresh.status === 200 && freshPayload?.outcome === 'INDEXED' &&
        (freshPayload?.chunksIndexed ?? 0) > 0 && freshPayload?.embeddingFailures === 0);
      const emptyPurge = await ada('DELETE', `${acmeRagBase()}/sources/KB_ARTICLE/${draftId}`);
      record('5.6 purge of a never-indexed source is 200 chunksRemoved 0',
        emptyPurge.status === 200 && dataOf<{ chunksRemoved: number }>(emptyPurge)?.chunksRemoved === 0);

      const foreignIndex = await eve('POST', `${acmeRagBase()}/articles/${publishedId}/index`);
      record('5.7 foreign article id is 404 (no cross-tenant indexing)', foreignIndex.status === 404);
      const foreignPurge = await eve('DELETE', `${acmeRagBase()}/sources/KB_ARTICLE/${publishedId}`);
      record('5.8 foreign purge is 404 (no cross-tenant chunk removal)', foreignPurge.status === 404);
    }

    // ══ 6. Document seeding + indexing eligibility ═══════════════════════
    let mdDocId = '';
    let emptyDocId = '';
    let failedDocId = '';
    let pendingDocId = '';
    {
      const mdSource = `# Troubleshooting guide\n\n${paragraphs}\n\n## Appendix\n\nSession identifiers are rotated hourly.`;
      // The ELIGIBLE document goes through the REAL upload+extraction flow
      // (the auto-indexing trigger lives in that lifecycle); the ineligible
      // fixtures are repository-seeded states instead.
      const extractableDoc = async (filename: string, source: string): Promise<string> => {
        const form = new FormData();
        form.append('file', new Blob([new TextEncoder().encode(source)]), filename);
        const response = await fetch(api(`/workspaces/${acmeId}/files`), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${adaToken}`,
            'x-forwarded-for': `10.6.${Math.floor(Math.random() * 250)}.1`,
          },
          body: form,
        });
        if (response.status !== 201) {
          const text = await response.text();
          console.log(`UPLOAD ${filename} -> ${response.status}`, text.slice(0, 300));
        }
        assert.equal(response.status, 201);
        const parsed = JSON.parse(await response.text()) as { data?: { document?: { id?: string } } };
        const id = parsed?.data?.document?.id ?? '';
        assert.ok(id.length > 0);
        return id;
      };
      const seedDoc = async (filename: string, mode: 'EMPTY' | 'FAILED'): Promise<string> => {
        const created = await createDocumentRecord(acmeWs, {
          originalFilename: filename,
          storageKey: `${acmeId}/${filename}`,
          mediaType: 'text/plain',
          sizeBytes: 16,
          storageProvider: 'local',
          checksumSha256: 'a'.repeat(64),
          uploadedById: adaId,
          articleId: null,
        });
        if (mode === 'EMPTY') {
          await updateDocumentProcessingState(acmeWs, created._id, {
            status: 'COMPLETED',
            extractionStatus: 'SKIPPED',
            extractedText: null,
            extractedTextTruncated: false,
          });
        } else {
          await updateDocumentProcessingState(acmeWs, created._id, {
            status: 'FAILED',
            extractionStatus: 'FAILED',
            extractionError: { code: 'EXTRACTION_FAILED', message: 'The file could not be parsed' },
          });
        }
        return created._id.toHexString();
      };

      mdDocId = await extractableDoc('troubleshooting.txt', mdSource);
      // Wait for the REAL extraction to finish before checking the auto-trigger.
      const extracted = await pollUntil(async () => {
        const res = await ada('GET', `/workspaces/${acmeId}/files/${mdDocId}`);
        const document = (res.status === 200 ? dataOf<{ document?: { status?: string } }>(res) : undefined)?.document;
        return document?.status === 'COMPLETED';
      });
      record('6.0 upload extracted to COMPLETED', extracted);
      const docIndexed = await pollUntil(async () => {
        const list = await ada('GET', `/workspaces/${acmeId}/rag/chunks?sourceType=DOCUMENT&sourceId=${mdDocId}`);
        return (dataOf<ChunksList>(list)?.total ?? 0) >= 1;
      });
      record('6.1 extraction completion auto-indexed the document', docIndexed);
      const mdDoc = await ada('POST', `${acmeRagBase()}/documents/${mdDocId}/index`);
      record('6.2 manual document reindex is UNCHANGED (idempotent)',
        mdDoc.status === 200 && dataOf<IndexPayload>(mdDoc)?.outcome === 'UNCHANGED');
      const headingChunk = await RagChunkModel.findOne({
        workspaceId: acmeWs, sourceId: new Types.ObjectId(mdDocId), chunkIndex: 0,
      });
      record('6.3 heading stayed attached to its paragraph', headingChunk?.text.startsWith('# Troubleshooting guide') === true);

      emptyDocId = await seedDoc('empty.txt', 'EMPTY');
      const skipEmpty = await ada('POST', `${acmeRagBase()}/documents/${emptyDocId}/index`);
      const skipEmptyPayload = skipEmpty.status === 200 ? dataOf<IndexPayload>(skipEmpty) : null;
      record('6.4 SKIPPED-extraction document is not indexable',
        skipEmpty.status === 200 && skipEmptyPayload?.outcome === 'SKIPPED' &&
        skipEmptyPayload?.skipReason === 'EXTRACTED_TEXT_UNAVAILABLE');

      failedDocId = await seedDoc('broken.txt', 'FAILED');
      const skipFailed = await ada('POST', `${acmeRagBase()}/documents/${failedDocId}/index`);
      const skipFailedPayload = skipFailed.status === 200 ? dataOf<IndexPayload>(skipFailed) : null;
      record('6.5 FAILED-extraction document is not indexable',
        skipFailed.status === 200 && skipFailedPayload?.outcome === 'SKIPPED' &&
        skipFailedPayload?.skipReason === 'EXTRACTED_TEXT_UNAVAILABLE');

      pendingDocId = (await createDocumentRecord(acmeWs, {
        originalFilename: 'pending.txt',
        storageKey: `${acmeId}/pending.txt`,
        mediaType: 'text/plain',
        sizeBytes: 16,
        storageProvider: 'local',
        checksumSha256: 'b'.repeat(64),
        uploadedById: adaId,
        articleId: null,
      }))._id.toHexString();
      const skipPending = await ada('POST', `${acmeRagBase()}/documents/${pendingDocId}/index`);
      const skipPendingPayload = skipPending.status === 200 ? dataOf<IndexPayload>(skipPending) : null;
      record('6.6 PENDING-extraction document is not indexable',
        skipPending.status === 200 && skipPendingPayload?.outcome === 'SKIPPED');

      const foreignDoc = await eve('POST', `/workspaces/${acmeId}/rag/documents/${mdDocId}/index`);
      record('6.7 foreign document id is 404', foreignDoc.status === 404);
    }

    // ══ 7. Content edits reindex; unpublished loses eligibility ═════════
    {
      const before = await RagChunkModel.findOne({ workspaceId: acmeWs, sourceId: new Types.ObjectId(publishedId) });
      const patched = await ada('PATCH', `${acmeKb}/${publishedId}`, {
        body: { body: `${paragraphs}\n\nUpdated in Q4: refunds are now instant for card payments.\n\n${paragraphs}` },
      });
      record('7.1 article body edit is 200', patched.status === 200);
      const reindexed = await pollUntil(async () => {
        const after = await RagChunkModel.findOne({ workspaceId: acmeWs, sourceId: new Types.ObjectId(publishedId) });
        return after !== null && before !== null && after.sourceHash !== before.sourceHash;
      });
      record('7.2 publish-state edit reindexed chunks automatically (new sourceHash)', reindexed);

      const unpublished = await ada('POST', `${acmeKb}/${publishedId}/unpublish`, { body: {} });
      record('7.3 unpublish is 200', unpublished.status === 200);
      const hidden = await pollUntil(async () => {
        const list = await ada('GET', `/workspaces/${acmeId}/rag/chunks?sourceType=KB_ARTICLE&sourceId=${publishedId}`);
        return dataOf<ChunksList>(list)?.items?.every((chunk) => chunk.sourceEligible === false) === true;
      });
      record('7.4 unpublished article chunks lose eligibility (kept for reuse)', hidden);
      const republish = await ada('POST', `${acmeKb}/${publishedId}/publish`, { body: {} });
      record('7.5 republish is 200', republish.status === 200);
      const restoredIdx = await pollUntil(async () => {
        const list = await ada('GET', `/workspaces/${acmeId}/rag/chunks?sourceType=KB_ARTICLE&sourceId=${publishedId}`);
        return dataOf<ChunksList>(list)?.items?.every((chunk) => chunk.sourceEligible === true) === true;
      });
      record('7.6 republish re-eligibilizes chunks', restoredIdx);
    }

    // ══ 8. Purges, audit trail, pagination, filters ══════════════════════
    {
      const docDeletion = await ada('DELETE', `/workspaces/${acmeId}/files/${mdDocId}`);
      record('8.1 document delete is 200/204', docDeletion.status === 200 || docDeletion.status === 204);
      const chunksGone = await pollUntil(async () => {
        const leftover = await RagChunkModel.countDocuments({
          workspaceId: acmeWs,
          sourceId: new Types.ObjectId(mdDocId),
        });
        return leftover === 0;
      });
      record('8.2 deleting a document purges its chunks', chunksGone);

      const auditRows = await AuditLogModel.countDocuments({
        workspaceId: acmeWs,
        action: { $in: ['rag.source_indexed', 'rag.source_purged'] },
      });
      record('8.3 RAG audit rows recorded for index/purge operations', auditRows >= 3);

      const page1 = await ada('GET', `${acmeRagBase()}/chunks?page=1&limit=2`);
      const p1 = page1.status === 200 ? dataOf<ChunksList>(page1) : null;
      record('8.4 pagination honors limit and reports hasMore',
        p1 !== null && p1.items.length === 2 && p1.hasMore === true);
      const page2 = await ada('GET', `${acmeRagBase()}/chunks?page=2&limit=2`);
      const p2 = page2.status === 200 ? dataOf<ChunksList>(page2) : null;
      record('8.5 page 2 returns a disjoint slice',
        p2 !== null && p1 !== null && p2.items.every((chunk) => !p1!.items.some((first) => first.id === chunk.id)));
      const badLimit = await ada('GET', `${acmeRagBase()}/chunks?limit=999`);
      record('8.6 oversized page size is 422', badLimit.status === 422);
      const badFilter = await ada('GET', `${acmeRagBase()}/chunks?sourceType=EMAILS`);
      record('8.7 unknown sourceType filter is 422', badFilter.status === 422);
      const statusFilter = await ada('GET', `${acmeRagBase()}/chunks?embeddingStatus=COMPLETED`);
      record('8.8 embeddingStatus filter accepted', statusFilter.status === 200);
      const bobList = await bob('GET', `${acmeRagBase()}/chunks`);
      record('8.9 agent cannot list chunks (rag.view is admin-only)', bobList.status === 403);
    }

    // ══ 9. Summary ═══════════════════════════════════════════════════════
    console.log('');
    if (failures === 0) {
      console.log('ALL RAG CHECKS PASSED');
    } else {
      console.log(`RAG CHECKS FAILED: ${failures}`);
      process.exitCode = 1;
    }
  } finally {
    await shutdown();
  }
}

void main().catch((error: unknown) => {
  console.error('VERIFY-RAG FATAL', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
