/* eslint-disable no-console -- verification driver output is the deliverable */
/**
 * Prompt 14 verification driver — AI support agent (integration level).
 *
 * Boots the REAL server against the documented local verification fixtures
 * (in-memory Mongo + mock embeddings + in-memory vector store) and injects
 * the DETERMINISTIC MOCK chat provider through the factory's test seam. It
 * then exercises the agent endpoint end-to-end: RBAC/concealment/validation,
 * grounded answering with citation validation, abstention reasons, provider
 * and retrieval failure paths, conversation-history isolation, and the
 * content-free audit trail.
 *
 * Determinism strategy: the mock embeddings are hash-based, so only passages
 * whose text matches a probe QUESTION exactly score high. Seeding therefore
 * creates one KB article per probe question (article body === probe string,
 * single-paragraph bodies → exactly one chunk each) PLUS one article per
 * probe question, and pins RAG_MAX_RETRIEVE_LIMIT=1 with
 * AI_AGENT_CONTEXT_MAX_PASSAGES=1 so retrieval is a deterministic self-match.
 *
 * Pure policy behaviors (evidence gate, context assembly, output contract,
 * citation spoof rejection) are asserted directly against the pure modules,
 * mirroring how the other drivers cover pure logic without HTTP.
 *
 * NOT covered here: live OpenAI behavior (requires credentials) — documented
 * as unverified; the OpenAI adapter's fetch seam is exercised only in code
 * review and its response parser is covered by the pure checks of the
 * contract its output must satisfy.
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
  headers['x-forwarded-for'] = `10.11.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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

function errorCodeOf(res: HttpResult): string | undefined {
  const error = res.body['error'] as { code?: string } | undefined;
  return error?.code;
}

interface AgentAnswerPayload {
  readonly status: 'ANSWERED' | 'ABSTAINED';
  readonly answer?: string;
  readonly abstentionReason?: string;
  readonly citations?: readonly {
    readonly sourceType: 'KB_ARTICLE' | 'DOCUMENT';
    readonly sourceId: string;
    readonly title: string | null;
    readonly chunkId: string;
  }[];
  readonly topScore: number | null;
  readonly passagesRetrieved: number;
  readonly model: string | null;
  readonly tokenUsage: { inputTokens: number | null; outputTokens: number | null } | null;
}

interface ChunksList {
  readonly items: readonly { readonly id: string; readonly sourceId: string }[];
  readonly total: number;
}

async function main(): Promise<void> {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_agent' },
  });

  const expectedUri = memoryServer.getUri('verify_agent');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '100000';
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'verify-agent-storage-'));
  mkdirSync(storageRoot, { recursive: true });
  process.env['STORAGE_DATA_DIR'] = storageRoot;
  // RAG fixtures: the documented local verification configuration. The
  // similarity floor is disabled HERE because the mock vectors are hash-based
  // (similarity is synthetic); the LOW_RELEVANCE branch is exercised as a
  // pure-policy check in section 4 against a crafted floor.
  process.env['RAG_EMBEDDING_PROVIDER'] = 'mock';
  process.env['RAG_EMBEDDING_MODEL'] = 'mock-model';
  process.env['RAG_EMBEDDING_DIMENSIONS'] = '8';
  process.env['RAG_VECTOR_SEARCH'] = 'inmemory';
  process.env['AI_AGENT_MIN_CONTEXT_SCORE'] = '0';
  // Determinism pin: one retrieved passage per ask = the exact probe-body
  // self-match (cosine 1.0), independent of filler chunk ordering.
  process.env['RAG_MAX_RETRIEVE_LIMIT'] = '1';
  process.env['AI_AGENT_CONTEXT_MAX_PASSAGES'] = '1';
  const port = 4068;
  process.env['PORT'] = String(port);

  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error('env.MONGODB_URI mismatch — aborting to protect foreign databases');
  }

  const httpServer = await startServer();
  const mongooseModule = await import('mongoose');
  // Two-step shutdown (server → in-memory Mongo), then an explicit
  // mongoose.disconnect: once the in-memory server is gone the underlying
  // driver topology sits in a reconnect loop that KEEPS the Node event loop
  // alive indefinitely, so the process would hang after the checks pass.
  const shutdown = (): Promise<void> =>
    new Promise<void>((resolve) => httpServer.close(() => resolve()))
      .then(() => memoryServer.stop())
      .then(() => mongooseModule.disconnect());

  try {
    const api = (pathSegments: string): string => `http://127.0.0.1:${port}/api/v1${pathSegments}`;
    const { UserModel } = await import('../server/src/modules/users/user.model.js');
    const { WorkspaceMemberModel } = await import(
      '../server/src/modules/workspaces/workspace-member.model.js'
    );
    const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
    const { RagChunkModel } = await import('../server/src/modules/rag/rag.model.js');
    const { createConversation } = await import(
      '../server/src/modules/conversations/conversation.repository.js'
    );
    const { createMessageRecord } = await import(
      '../server/src/modules/conversations/message.repository.js'
    );
    const { listMessages } = await import('../server/src/modules/conversations/message.repository.js');

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
    const adaToken = await newUser('Ada Agentia', 'ada.agent@example.test');
    const bobToken = await newUser('Bob Askee', 'bob.agent@example.test');
    const vicToken = await newUser('Vic Viewer', 'vic.agent@example.test');
    const eveToken = await newUser('Eve Napier', 'eve.agent@example.test');

    const acmeId = await newWorkspace(adaToken, 'Acme Support', 'acme-agent');
    const rivalId = await newWorkspace(eveToken, 'Rival Support', 'rival-agent');

    const acmeWs = new Types.ObjectId(acmeId);
    const aclmWs = new Types.ObjectId(rivalId);
    const adaId = (await UserModel.findOne({ email: 'ada.agent@example.test' }))!._id;
    const bobId = (await UserModel.findOne({ email: 'bob.agent@example.test' }))!._id;
    const vicId = (await UserModel.findOne({ email: 'vic.agent@example.test' }))!._id;
    await WorkspaceMemberModel.create([
      { workspaceId: acmeWs, userId: bobId, role: 'agent' },
      { workspaceId: acmeWs, userId: vicId, role: 'viewer' },
    ]);

    const acmeAgentBase = (): string => `/workspaces/${acmeId}/agent`;
    const acmeKb = `/workspaces/${acmeId}/knowledge-base/articles`;
    const requester =
      (token: string) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathSegments: string, init?: { body?: unknown }): Promise<HttpResult> =>
        http(method, api(pathSegments), { token, ...init });
    const ada = requester(adaToken);
    const bob = requester(bobToken);
    const vic = requester(vicToken);
    const eve = requester(eveToken);

    const ask = (token: string, body: unknown): Promise<HttpResult> =>
      http('POST', api(`${acmeAgentBase()}/ask`), { token, body });
    const askAs = (question: string): Promise<HttpResult> => ask(adaToken, { question });

    // Probe questions: seeded as single-paragraph KB bodies so each probe
    // has exactly one eagerly-indexed chunk (see the deterministic asks
    // below — the driver asks the EXACT stored chunk text).
    const refundProbeQuestion = 'How do refunds work and how long do they take?';
    const probeQuestions: readonly string[] = [
      refundProbeQuestion,
      'What is your name?', // 2.7 unconfigured-provider evidence gate
      'How long does a refund take?', // 3.10 agent-role ask
      'FORCE_ABSTAIN even though passages exist', // 4.4 model-declined
      'FORCE_SPOOF_CITATIONS refunds please', // 4.5 citation spoof
      'FORCE_UNPARSEABLE refunds question', // 5.1/5.2 malformed provider output
      'FORCE_FAIL refunds question', // 5.4 provider outage
      'What is the status of the customer refund request?', // 6.2 history-grounded
      'How do refunds work?', // 4.1 rival + 5.5/5.6 retrieval restore
    ];

    // ══ 1. Knowledge seeding through the REAL KB lifecycle ═══════════════
    let refundArticleId = '';
    const articleIds: string[] = [];
    {
      let publishFailures = 0;
      const titles: readonly string[] = probeQuestions.map((question, index) =>
        index === 0 ? 'Refund Processing Policy' : `Probe Note ${index} — ${question.slice(0, 24)}`,
      );
      for (let i = 0; i < probeQuestions.length; i += 1) {
        const created = await ada('POST', acmeKb, {
          body: {
            title: titles[i] ?? `Probe ${i}`,
            summary: i === 0 ? 'How refunds are issued for Acme customers.' : 'Probe seed for the agent driver.',
            body: probeQuestions[i] ?? '',
            tags: i === 0 ? ['refunds', 'billing'] : ['probe'],
          },
        });
        assert.equal(created.status, 201, `probe article ${i} create`);
        const articleId = dataOf<{ article?: { id?: string } }>(created)?.article?.id ?? '';
        assert.ok(articleId.length > 0);
        articleIds.push(articleId);
        if (i === 0) refundArticleId = articleId;
        const published = await ada('POST', `${acmeKb}/${articleId}/publish`, { body: {} });
        if (published.status !== 200) publishFailures += 1;
      }
      record('1.1 every probe seed article publishes (200)', publishFailures === 0);

      // Publishing auto-indexes progressively; wait until every probe has a
      // retrievable KB_ARTICLE chunk before the agent sections run.
      const seeded = await pollUntil(async () => {
        const count = await RagChunkModel.countDocuments({
          workspaceId: acmeWs,
          sourceType: 'KB_ARTICLE',
        }).exec();
        return count >= probeQuestions.length;
      });
      record('1.2 publish auto-indexed every probe article into retrievable chunks', seeded);

      const refundList = await ada(
        'GET',
        `/workspaces/${acmeId}/rag/chunks?sourceType=KB_ARTICLE&sourceId=${refundArticleId}`,
      );
      const refundChunks = dataOf<ChunksList>(refundList);
      record('1.3 refund-probe chunk listing is scoped to its sourceId',
        (refundChunks?.total ?? 0) >= 1 &&
        (refundChunks?.items?.every((chunk) => chunk.sourceId === refundArticleId) ?? false));
    }

    // Deterministic asks: the hash mock's similarity is exact-match only, so
    // EVERY agent ask below uses the EXACT stored chunk text (the very
    // string the indexing pipeline embedded) — cosine vs that chunk is 1.0
    // and every other chunk scores below it regardless of filler content.
    const chunkTextBySource = new Map<string, string>();
    const kbChunksForAsks = (await RagChunkModel.find({ workspaceId: acmeWs, sourceType: 'KB_ARTICLE' })
      .select('sourceId text')
      .lean()
      .exec()) as readonly { sourceId: Types.ObjectId; text: string }[];
    for (const chunk of kbChunksForAsks) {
      chunkTextBySource.set(chunk.sourceId.toHexString(), chunk.text);
    }
    const askTexts: readonly string[] = articleIds.map((articleId) => {
      const text = chunkTextBySource.get(articleId) ?? '';
      assert.ok(text.length > 0 && text.length <= 2_000, `ask seed text for ${articleId}`);
      return text;
    });

    // ══ 2. RBAC, concealment, validation, unconfigured provider ══════════
    {
      const unauth = await http('POST', api(`${acmeAgentBase()}/ask`), {
        body: { question: 'Hello?' },
      });
      record('2.1 unauthenticated /agent/ask is 401', unauth.status === 401);

      const foreign = await eve('POST', `${acmeAgentBase()}/ask`, { body: { question: 'Hello?' } });
      record('2.2 foreign-workspace ask is 404 (concealment)', foreign.status === 404);

      record('2.3 viewer ask is 403 (agent.ask not granted)', (await vic('POST', `${acmeAgentBase()}/ask`, {
        body: { question: 'Hello?' },
      })).status === 403);

      const empty = await askAs('   ');
      record('2.4 whitespace-only question is 422', empty.status === 422);

      const oversized = await askAs('x'.repeat(2_001));
      record('2.5 question over 2000 chars is 422', oversized.status === 422);

      const badConversation = await ask(adaToken, {
        question: 'Hello?',
        conversationId: 'not-a-24-hex',
      });
      record('2.6 malformed conversationId is 422', badConversation.status === 422);

      // BEFORE the mock provider is installed: AI_PROVIDER=none → clean 503.
      // Evidence gate is satisfied by the 'What is your name?' seed article,
      // so this exercises the CONFIG branch, not the abstention branch.
      const unconfigured = await askAs(askTexts[1] ?? '');
      if (unconfigured.status !== 503) {
        console.log('  (unconfigured ask detail)', unconfigured.status, errorCodeOf(unconfigured));
      }
      record('2.7 ask with no provider configured is 503', unconfigured.status === 503);
      record('2.8 unconfigured ask surfaces AGENT_AI_NOT_CONFIGURED',
        errorCodeOf(unconfigured) === 'AGENT_AI_NOT_CONFIGURED');

      record('2.9 unconfigured error body has no stack/provider internals',
        JSON.stringify(unconfigured.body).toLowerCase().includes('stack') === false);
    }

    // Install the deterministic mock (test seam only — never configuration).
    const { setChatProviderForTests } = await import('../server/src/modules/ai/chat/chat.factory.js');
    const { MockChatProvider } = await import('../server/src/modules/ai/chat/mock-chat.provider.js');
    setChatProviderForTests(new MockChatProvider());

    // ══ 3. Grounded answering with validated citations ═══════════════════
    {
      const answered = await askAs(askTexts[0] ?? '');
      record('3.1 grounded ask over indexed knowledge is 200', answered.status === 200);
      const payload = answered.status === 200 ? dataOf<AgentAnswerPayload>(answered) : null;
      record('3.2 result status is ANSWERED', payload?.status === 'ANSWERED');
      record('3.3 answer is a non-empty string under the cap',
        typeof payload?.answer === 'string' && payload.answer.length > 0 && payload.answer.length <= 2_000);
      const citations = payload?.citations ?? [];
      record('3.4 at least one citation is present', citations.length >= 1);
      record('3.5 every citation points at the retrieved KB article',
        citations.every((citation) => citation.sourceType === 'KB_ARTICLE' && citation.sourceId === refundArticleId));
      record('3.6 citations carry the verified article title',
        citations.every((citation) => citation.title === 'Refund Processing Policy'));

      const chunkIds = new Set(
        (await RagChunkModel.find({ workspaceId: acmeWs, sourceType: 'KB_ARTICLE' }).lean().exec())
          .map((chunk) => (chunk as { _id: Types.ObjectId })._id.toHexString()),
      );
      record('3.7 every cited chunkId exists as a real indexed chunk of this workspace',
        citations.every((citation) => chunkIds.has(citation.chunkId)));

      record('3.8 model identifier reflects the configured provider', payload?.model === 'mock-chat');
      record('3.9 tokenUsage is honest (mock supplies none → null)',
        JSON.stringify(payload?.tokenUsage ?? null) === '{"inputTokens":null,"outputTokens":null}');
      record('3.10 agent-role member can ask (agent.ask granted)', (await ask(bobToken, {
        question: askTexts[2] ?? '',
      })).status === 200);
    }

    // ══ 4. Abstention paths (measured evidence, never invention) ═════════
    {
      const emptyWorkspace = await eve('POST', `/workspaces/${rivalId}/agent/ask`, {
        body: { question: askTexts[8] ?? '' },
      });
      record('4.1 ask with NO indexed knowledge abstains', emptyWorkspace.status === 200);
      record('4.2 empty-knowledge abstention reason is NO_KNOWLEDGE',
        dataOf<AgentAnswerPayload>(emptyWorkspace)?.status === 'ABSTAINED' &&
        dataOf<AgentAnswerPayload>(emptyWorkspace)?.abstentionReason === 'NO_KNOWLEDGE');
      record('4.3 abstained payload invents no answer',
        typeof dataOf<AgentAnswerPayload>(emptyWorkspace)?.answer !== 'string');

      const declined = await askAs(askTexts[3] ?? '');
      record('4.4 model-declined output abstains as MODEL_DECLINED',
        declined.status === 200 &&
        dataOf<AgentAnswerPayload>(declined)?.status === 'ABSTAINED' &&
        dataOf<AgentAnswerPayload>(declined)?.abstentionReason === 'MODEL_DECLINED');

      const spoofed = await askAs(askTexts[4] ?? '');
      record('4.5 spoofed citation [88] (not in retrieval) is dropped → UNCITED_ANSWER',
        spoofed.status === 200 &&
        dataOf<AgentAnswerPayload>(spoofed)?.status === 'ABSTAINED' &&
        dataOf<AgentAnswerPayload>(spoofed)?.abstentionReason === 'UNCITED_ANSWER');

      // Pure-policy checks: the LOW_RELEVANCE / INSUFFICIENT_EVIDENCE branches
      // and the citation/context bounds without provider involvement.
      const grounding = await import('../server/src/modules/agent/agent-grounding.js');
      const strictPolicy = {
        minPassages: 2,
        minScore: 0.5,
        contextMaxPassages: 2,
        contextMaxChars: 1_000,
        answerMaxChars: 80,
      };
      const low = grounding.evaluateEvidence(
        [{ chunkId: 'a', sourceType: 'KB_ARTICLE', sourceId: 's', text: 't', score: 0.2 }],
        { ...strictPolicy, minPassages: 1 },
      );
      record('4.6 evidence gate rejects sub-floor similarity as LOW_RELEVANCE',
        !low.sufficient && low.reason === 'LOW_RELEVANCE');
      const insufficient = grounding.evaluateEvidence(
        [{ chunkId: 'a', sourceType: 'DOCUMENT', sourceId: 's', text: 't', score: 0.9 }],
        strictPolicy,
      );
      record('4.7 evidence gate rejects thin evidence as INSUFFICIENT_EVIDENCE',
        !insufficient.sufficient && insufficient.reason === 'INSUFFICIENT_EVIDENCE');

      const passages: grounding.GroundingPassage[] = Array.from({ length: 5 }, (_, i) => ({
        chunkId: `chunk-${i}`,
        sourceType: 'KB_ARTICLE' as const,
        sourceId: 's',
        text: 'x'.repeat(700),
        score: 0.9 - i * 0.01,
      }));
      const context = grounding.assembleContext(passages, strictPolicy);
      record('4.8 context assembly caps passages at the configured maximum',
        context.length === strictPolicy.contextMaxPassages);
      record('4.9 context ranking is best-score-first',
        context[0]?.passage.chunkId === 'chunk-0');

      const parsed = grounding.parseModelAnswer(
        '```json\n{"answerable":true,"answer":"ok","citations":[1]}\n```',
      );
      record('4.10 output contract parses fenced JSON', parsed.answerable === true && parsed.citations[0] === 1);
      let parseRejected = false;
      try {
        grounding.parseModelAnswer('this is {"not": the structured protocol');
      } catch {
        parseRejected = true;
      }
      record('4.11 non-conforming model output is a hard failure (no guess)', parseRejected);

      const uncitedValidation = grounding.validateModelAnswer(
        { answerable: true, answer: 'looks plausible', citations: [7] },
        [{ passageIndex: 1, passage: passages[0] as grounding.GroundingPassage }],
        { ...strictPolicy, answerMaxChars: 5_000 },
      );
      record('4.12 citation validation drops phantom references → abstain',
        uncitedValidation.verdict === 'ABSTAINED');

      const truncatedValidation = grounding.validateModelAnswer(
        { answerable: true, answer: 'y'.repeat(300), citations: [1] },
        [{ passageIndex: 1, passage: passages[0] as grounding.GroundingPassage }],
        strictPolicy,
      );
      record('4.13 over-cap answers are truncated with a marker',
        truncatedValidation.verdict === 'ANSWERED' &&
        truncatedValidation.answer.length === strictPolicy.answerMaxChars + 1 &&
        truncatedValidation.answer.endsWith('…'));

      const mixedCitations = grounding.validateModelAnswer(
        { answerable: true, answer: 'grounded claim', citations: [3, 1, 3] },
        [
          { passageIndex: 1, passage: passages[0] as grounding.GroundingPassage },
          { passageIndex: 2, passage: passages[1] as grounding.GroundingPassage },
        ],
        { ...strictPolicy, answerMaxChars: 5_000 },
      );
      record('4.14 valid citations survive, deduped, in context order',
        mixedCitations.verdict === 'ANSWERED' &&
        (mixedCitations as { citationIndexes?: unknown[] }).citationIndexes?.length === 1);
    }

    // ══ 5. Provider and retrieval failure surfaces ═══════════════════════
    {
      const unparseable = await askAs(askTexts[5] ?? '');
      record('5.1 malformed provider output is a structured 503', unparseable.status === 503);
      record('5.2 unparseable error code is AGENT_AI_INVALID_RESPONSE',
        errorCodeOf(unparseable) === 'AGENT_AI_INVALID_RESPONSE');
      record('5.3 provider failure body stays safe (no stack/internal text)',
        JSON.stringify(unparseable.body).toLowerCase().includes('stack') === false);

      const failed = await askAs(askTexts[6] ?? '');
      record('5.4 provider outage is a structured 503 with a distinct code',
        failed.status === 503 && errorCodeOf(failed) === 'AGENT_AI_PROVIDER_FAILED');

      // Retrieval infrastructure failure must surface the RAG code verbatim.
      const { setEmbeddingProviderForTests } = await import(
        '../server/src/modules/rag/embeddings/embedding.factory.js'
      );
      const { MockEmbeddingProvider } = await import(
        '../server/src/modules/rag/embeddings/mock-embedding.provider.js'
      );
      setEmbeddingProviderForTests(null);
      const retrievalDown = await askAs(askTexts[8] ?? '');
      record('5.5 retrieval unavailable → safe 503 passthrough',
        retrievalDown.status === 503 && errorCodeOf(retrievalDown) === 'RAG_EMBEDDING_NOT_CONFIGURED');
      setEmbeddingProviderForTests(new MockEmbeddingProvider(8));
      const restored = await askAs(askTexts[8] ?? '');
      record('5.6 restored retrieval answers again', restored.status === 200);
    }

    // ══ 6. Conversation grounding + history isolation ════════════════════
    {
      // Seed a conversation for acme with mixed visibility notes.
      const ticketId = new Types.ObjectId();
      const customerId = new Types.ObjectId();
      const conversation = await createConversation(acmeWs, {
        ticketId,
        customerId,
        subject: null,
      });
      await createMessageRecord(acmeWs, {
        workspaceId: acmeWs,
        conversationId: conversation._id,
        ticketId,
        senderId: bobId as unknown as Types.ObjectId,
        senderType: 'CUSTOMER',
        body: 'I still have not received my refund for order 42.',
        visibility: 'PUBLIC',
      });
      await createMessageRecord(acmeWs, {
        workspaceId: acmeWs,
        conversationId: conversation._id,
        ticketId,
        senderId: bobId as unknown as Types.ObjectId,
        senderType: 'AGENT',
        body: 'INTERNAL note: customer seems high-risk, verify payment method privately.',
        visibility: 'INTERNAL',
      });
      await createMessageRecord(acmeWs, {
        workspaceId: acmeWs,
        conversationId: conversation._id,
        ticketId,
        senderId: bobId as unknown as Types.ObjectId,
        senderType: 'AGENT',
        body: 'We acknowledged the request and notified the billing team.',
        visibility: 'PUBLIC',
      });

      const publicOnly = await listMessages({
        workspaceId: acmeWs,
        conversationId: conversation._id,
        page: 1,
        limit: 10,
        publicOnly: true, // the same read path the agent service uses
      });
      record('6.1 only PUBLIC messages are readable for grounding history (internal notes excluded in-query)',
        publicOnly.total === 2 && publicOnly.items.every((m) => m.body.includes('INTERNAL') === false));

      const withHistory = await ask(adaToken, {
        question: askTexts[7] ?? '',
        conversationId: conversation._id.toHexString(),
      });
      record('6.2 ask grounded on conversation history is accepted (200)',
        withHistory.status === 200 && dataOf<AgentAnswerPayload>(withHistory)?.status === 'ANSWERED');

      // Cross-workspace conversation reference must read as not-found.
      const foreignConversation = await createConversation(aclmWs, {
        ticketId: new Types.ObjectId(),
        customerId: new Types.ObjectId(),
        subject: null,
      });
      const crossTenant = await ask(adaToken, {
        question: 'leak attempt across tenants',
        conversationId: foreignConversation._id.toHexString(),
      });
      record('6.3 foreign conversationId (other workspace) is 404', crossTenant.status === 404);
    }

    // ══ 7. Content-free audit trail ══════════════════════════════════════
    {
      const auditRows = await AuditLogModel.countDocuments({
        workspaceId: acmeWs,
        action: 'agent.question_answered',
      });
      record('7.1 agent asks append audit rows', auditRows >= 4);

      const sample = await AuditLogModel.find({ workspaceId: acmeWs, action: 'agent.question_answered' })
        .lean()
        .limit(1)
        .exec();
      const metadata = (sample[0]?.['metadata'] ?? {}) as Record<string, unknown>;
      const contentKeys = ['question', 'answer', 'prompt', 'passages', 'chunkText'];
      record('7.2 audit metadata is content-free (no question/answer/prompt data)',
        contentKeys.every((key) => !(key in metadata)));
      record('7.3 audit rows capture request context without storing request bodies',
        typeof sample[0]?.['ip'] === 'string' &&
        contentKeys.every((key) => !(key in metadata)));
    }

    // ══ 8. Summary ═══════════════════════════════════════════════════════
    console.log('');
    console.log(`Prompt 14 — agent driver: ${failures === 0 ? 'ALL AGENT CHECKS PASSED' : `${failures} FAILURES`}`);
    if (failures > 0) {
      console.log('AGENT CHECKS FAILED');
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    console.error('AGENT CHECKS FAILED (exception)', error);
    process.exitCode = 1;
    failures = failures + 1;
  } finally {
    await shutdown();
  }
  if (failures !== 0) process.exit(1);
  await sleep(50);
}

main().catch((error: unknown) => {
  console.error('AGENT CHECKS FAILED (fatal)', error);
  process.exit(1);
});
