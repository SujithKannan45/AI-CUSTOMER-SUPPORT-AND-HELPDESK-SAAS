/* eslint-disable no-console -- verification driver output is the deliverable */
/**
 * Prompt 18 verification driver — analytics & reporting.
 *
 * Boots the REAL server against in-memory Mongo (same recipe as
 * verify-search.ts) and checks over real HTTP:
 *
 *   1. RBAC + concealment (owner/admin allowed, agent/viewer denied, strangers
 *      404, anonymous 401),
 *   2. overview counts for tickets/customers/conversations/escalations/KB/AI,
 *      including genuine zeros and archived-record exclusion,
 *   3. date-range presets + custom windows, boundary rejects and query
 *      injection,
 *   4. ticket trends (zero-filled UTC buckets), resolution durations
 *      (real stamps only, negative durations excluded, unresolved never
 *      counted), deterministic bucket ordering,
 *   5. performance: backlog, unassigned work, first STAFF reply (INTERNAL
 *      notes excluded), honest unavailability of customer first response,
 *      escalation frequency, message volume,
 *   6. AI analytics from the existing audit trail (answered/abstained/failed,
 *      citations, handoffs, trends, no content leakage),
 *   7. tenant isolation across two workspaces and an empty workspace,
 *   8. bounded CSV export: headers, content type, machine-only fields,
 *      formula-injection escaping (unit) and authorization.
 *
 * NOT covered (documented, not faked): live AI provider usage (no provider is
 * called here; the audit rows are seeded persisted records), query-plan
 * inspection (mongodb-memory-server does not expose stable plan output), and
 * cross-collection snapshot consistency (this deployment has no transactions).
 *
 * Seed timestamps are written through the collection driver on purpose
 * (tickets/conversations/messages/audit) so window boundaries are exact and
 * independent of the HTTP clock. Audit rows stay append-only: the one old row
 * is stamped at insert time, never updated through the model.
 */

import assert from 'node:assert/strict';
import { Types } from 'mongoose';

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Headers;
}

async function http(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { body?: unknown; token?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  // Unique IP per request defeats cross-test rate-limit coupling.
  headers['x-forwarded-for'] = `10.51.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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
  return { status: response.status, body, text, headers: response.headers };
}

let failures = 0;
function record(name: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

function dataOf<T>(res: HttpResult): T {
  return (res.body as { data?: T }).data as T;
}

interface Period {
  range: string;
  from: string;
  to: string;
  bucket: string;
  timezone: string;
}

interface Overview {
  period: Period;
  tickets: {
    total: number;
    open: number;
    inProgress: number;
    waitingForCustomer: number;
    resolved: number;
    closed: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    createdInPeriod: number;
    resolvedInPeriod: number;
    assignment: { assigned: number; unassigned: number };
    topAssignees: Array<{ userId: string; tickets: number }>;
  };
  customers: { total: number; newInPeriod: number; byStatus: Record<string, number> };
  conversations: { total: number; open: number; closed: number; createdInPeriod: number };
  escalations: {
    total: number;
    active: number;
    createdInPeriod: number;
    byStatus: Record<string, number>;
  };
  knowledgeBase: { total: number; published: number; draft: number; archived: number };
  ai: {
    requests: number;
    answered: number;
    abstained: number;
    failed: number;
    citationBackedAnswers: number;
    aiEscalations: number;
    humanHandoffs: number;
  };
}

interface Duration {
  count: number;
  averageMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

interface TicketAnalytics {
  period: Period;
  tickets: { total: number; createdInPeriod: number; resolvedInPeriod: number };
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  created: Array<{ bucket: string; count: number }>;
  resolved: Array<{ bucket: string; count: number }>;
  resolutionTime: Duration;
}

interface Performance {
  period: Period;
  backlog: {
    open: number;
    inProgress: number;
    waitingForCustomer: number;
    totalBacklog: number;
    unassigned: number;
    byPriority: Record<string, number>;
  };
  resolutionTime: Duration;
  firstStaffReply: { conversations: number; averageMs: number | null };
  customerFirstResponse: { available: boolean; reason: string };
  escalationFrequency: {
    escalationsCreated: number;
    ticketsCreated: number;
    perTicket: number | null;
  };
  conversationVolume: {
    conversationsCreated: number;
    messages: { total: number; public: number; internal: number };
  };
}

interface AiAnalytics {
  period: Period;
  aiProviderConfigured: boolean;
  metrics: {
    requests: number;
    answered: number;
    abstained: number;
    failed: number;
    citationBackedAnswers: number;
    abstentionReasons: Record<string, number>;
    aiEscalations: number;
    humanHandoffs: number;
    aiEscalationsByTrigger: Record<string, number>;
  };
  timeSeries: Array<{ bucket: string; answered: number; abstained: number; failed: number }>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const PORT = 4083;

async function main(): Promise<void> {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_analytics' },
  });

  const expectedUri = memoryServer.getUri('verify_analytics');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '100000';
  process.env['LOG_LEVEL'] = 'error';
  process.env['NOTIFICATION_EMAIL_ENABLED'] = 'false';
  process.env['EMAIL_PROVIDER'] = 'log';
  process.env['AI_PROVIDER'] = 'none';
  process.env['PORT'] = String(PORT);

  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error('env.MONGODB_URI mismatch — aborting to protect foreign databases');
  }

  const httpServer = await startServer();
  const mongooseModule = await import('mongoose');
  const shutdown = (): Promise<void> =>
    new Promise<void>((resolve) => httpServer.close(() => resolve()))
      .then(() => memoryServer.stop())
      .then(() => mongooseModule.disconnect());

  try {
    const api = (segments: string): string => `http://127.0.0.1:${PORT}/api/v1${segments}`;
    const { UserModel } = await import('../server/src/modules/users/user.model.js');
    const { WorkspaceMemberModel } = await import(
      '../server/src/modules/workspaces/workspace-member.model.js'
    );
    const { TicketModel } = await import('../server/src/modules/tickets/ticket.model.js');
    const { ConversationModel, MessageModel } = await import(
      '../server/src/modules/conversations/conversation.model.js'
    );
    const { EscalationModel } = await import(
      '../server/src/modules/escalations/escalation.model.js'
    );
    const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
    const { csvCell } = await import('../server/src/modules/analytics/analytics.csv.js');

    const PASSWORD = 'Str0ngPass!42';

    async function newUser(name: string, email: string): Promise<string> {
      const reg = await http('POST', api('/auth/register'), {
        body: { name, email, password: PASSWORD },
      });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      const login = await http('POST', api('/auth/login'), {
        body: { email, password: PASSWORD },
      });
      assert.equal(login.status, 200);
      const token = dataOf<{ tokens?: { accessToken?: string } }>(login)?.tokens?.accessToken;
      assert.ok(typeof token === 'string' && token.length > 0);
      return token;
    }

    async function newWorkspace(token: string, name: string, slug: string): Promise<string> {
      const created = await http('POST', api('/workspaces'), { token, body: { name, slug } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = dataOf<{ workspace?: { id?: string } }>(created)?.workspace?.id ?? '';
      assert.ok(id.length > 0);
      return id;
    }

    const adaToken = await newUser('Ada Owner', 'ada.analytics@example.test');
    const bobToken = await newUser('Bob Agent', 'bob.analytics@example.test');
    const vicToken = await newUser('Vic Viewer', 'vic.analytics@example.test');
    const eveToken = await newUser('Eve Rival', 'eve.analytics@example.test');
    const samToken = await newUser('Sam Stranger', 'sam.analytics@example.test');

    const acmeId = await newWorkspace(adaToken, 'Acme Analytics', 'acme-analytics');
    const rivalId = await newWorkspace(eveToken, 'Rival Analytics', 'rival-analytics');
    const emptyId = await newWorkspace(samToken, 'Empty Analytics', 'empty-analytics');

    const acmeWs = new Types.ObjectId(acmeId);
    const rivalWs = new Types.ObjectId(rivalId);

    const userIds: Record<string, Types.ObjectId> = {};
    for (const [key, email] of Object.entries({
      ada: 'ada.analytics@example.test',
      bob: 'bob.analytics@example.test',
      vic: 'vic.analytics@example.test',
      eve: 'eve.analytics@example.test',
    })) {
      userIds[key] = (await UserModel.findOne({ email }))!._id as Types.ObjectId;
    }
    await WorkspaceMemberModel.create([
      { workspaceId: acmeWs, userId: userIds['bob'], role: 'agent' },
      { workspaceId: acmeWs, userId: userIds['vic'], role: 'viewer' },
    ]);

    const as =
      (token: string) =>
      (
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        segments: string,
        init?: { body?: unknown },
      ): Promise<HttpResult> =>
        http(method, api(segments), { token, ...init });
    const ada = as(adaToken);
    const bob = as(bobToken);
    const vic = as(vicToken);
    const eve = as(eveToken);
    const sam = as(samToken);

    const acme = (segments: string): string => `/workspaces/${acmeId}${segments}`;
    const rival = (segments: string): string => `/workspaces/${rivalId}${segments}`;
    const empty = (segments: string): string => `/workspaces/${emptyId}${segments}`;

    const now = Date.now();
    const at = (msAgo: number): Date => new Date(now - msAgo);

    // ── Seed customers ───────────────────────────────────────────────────────
    const customerIds: string[] = [];
    for (const [name, email, status] of [
      ['Nora Active', 'nora.analytics@example.test', 'active'],
      ['Ned Blocked', 'ned.analytics@example.test', 'blocked'],
      ['Nina Active', 'nina.analytics@example.test', 'active'],
    ] as const) {
      const res = await ada('POST', acme('/customers'), { body: { name, email, status } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      customerIds.push(dataOf<{ customer?: { id?: string } }>(res)?.customer?.id ?? '');
    }
    const customerOid = new Types.ObjectId(customerIds[0]);

    const rivalCustomerRes = await eve('POST', rival('/customers'), {
      body: { name: 'Rival Customer', email: 'rival.analytics@example.test' },
    });
    assert.equal(rivalCustomerRes.status, 201, JSON.stringify(rivalCustomerRes.body));
    const rivalCustomerId =
      dataOf<{ customer?: { id?: string } }>(rivalCustomerRes)?.customer?.id ?? '';

    // ── Seed tickets (HTTP create, then deterministic persisted timestamps) ──
    async function newTicket(
      subject: string,
      priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
      token: string = adaToken,
      wsPath: string = acme(''),
      customer: string = customerIds[0]!,
    ): Promise<{ id: string; oid: Types.ObjectId }> {
      const res = await http('POST', api(`${wsPath}/tickets`), {
        token,
        body: {
          customerId: customer,
          subject,
          description: `Analytics seed for ${subject}.`,
          priority,
        },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const ticket = dataOf<{ ticket?: { id?: string } }>(res)?.ticket;
      assert.ok(ticket?.id !== undefined && ticket.id.length > 0);
      return { id: ticket.id, oid: new Types.ObjectId(ticket.id) };
    }

    const t1 = await newTicket('Alpha open queue', 'HIGH');
    const t2 = await newTicket('Bravo in progress', 'MEDIUM');
    const t3 = await newTicket('Charlie waiting customer', 'LOW');
    const t4 = await newTicket('Delta resolved urgent', 'URGENT');
    const t5 = await newTicket('Echo closed old', 'MEDIUM');
    const t6 = await newTicket('Foxtrot negative duration', 'MEDIUM');
    const t7 = await newTicket('Golf resolved without stamp', 'LOW');
    const t8 = await newTicket('Hotel very old open', 'MEDIUM');
    const t9 = await newTicket('India archived ticket', 'HIGH');
    const rivalTicket = await newTicket(
      'Rival ticket',
      'LOW',
      eveToken,
      rival(''),
      rivalCustomerId,
    );
    assert.ok(rivalTicket.id.length > 0);

    // Archive T9 through the real endpoint (soft-delete stamp) so the exclusion
    // is produced by the product's own path, not a hand-written flag.
    const archived = await ada('POST', acme(`/tickets/${t9.id}/archive`));
    assert.equal(archived.status, 200, JSON.stringify(archived.body));

    // ── Conversations + messages (before status patches: tickets are live) ───
    async function newConversation(ticketId: string): Promise<string> {
      const res = await ada('POST', acme(`/tickets/${ticketId}/conversations`), {
        body: { subject: 'Analytics conversation' },
      });
      assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.body));
      const id = dataOf<{ conversation?: { id?: string } }>(res)?.conversation?.id ?? '';
      assert.ok(id.length > 0);
      return id;
    }

    async function newMessage(
      conversationId: string,
      body: string,
      visibility: 'PUBLIC' | 'INTERNAL',
    ): Promise<string> {
      const res = await ada('POST', acme(`/conversations/${conversationId}/messages`), {
        body: { body, visibility },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const id = dataOf<{ message?: { id?: string } }>(res)?.message?.id ?? '';
      assert.ok(id.length > 0);
      return id;
    }

    const t4Conversation = await newConversation(t4.id);
    const t7Conversation = await newConversation(t7.id);
    const t2Conversation = await newConversation(t2.id);

    const internalMessage = await newMessage(
      t4Conversation,
      'Internal diagnostic marker sent first',
      'INTERNAL',
    );
    const publicMessage = await newMessage(
      t4Conversation,
      'Public first reply marker sent second',
      'PUBLIC',
    );
    const t7Internal = await newMessage(t7Conversation, 'Only an internal note here', 'INTERNAL');

    const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
    await ConversationModel.collection.updateOne(
      { _id: oid(t4Conversation), workspaceId: acmeWs },
      { $set: { createdAt: at(10 * DAY) } },
    );
    await MessageModel.collection.updateOne(
      { _id: oid(internalMessage), workspaceId: acmeWs },
      { $set: { createdAt: at(9.5 * DAY) } },
    );
    await MessageModel.collection.updateOne(
      { _id: oid(publicMessage), workspaceId: acmeWs },
      { $set: { createdAt: at(9 * DAY) } },
    );
    await MessageModel.collection.updateOne(
      { _id: oid(t7Internal), workspaceId: acmeWs },
      { $set: { createdAt: at(3 * DAY) } },
    );

    // ── Deterministic ticket timestamps / statuses / assignees ───────────────
    const patchTicket = async (
      ticket: { oid: Types.ObjectId },
      set: Record<string, unknown>,
    ): Promise<void> => {
      const result = await TicketModel.collection.updateOne(
        { _id: ticket.oid, workspaceId: acmeWs },
        { $set: set },
      );
      assert.equal(result.matchedCount, 1);
    };

    await patchTicket(t1, { createdAt: at(2 * HOUR) });
    await patchTicket(t2, {
      createdAt: at(3 * DAY),
      status: 'IN_PROGRESS',
      agentId: userIds['bob'],
    });
    await patchTicket(t3, { createdAt: at(10 * DAY), status: 'WAITING_FOR_CUSTOMER' });
    await patchTicket(t4, {
      createdAt: at(10 * DAY),
      status: 'RESOLVED',
      resolvedAt: at(8 * DAY),
      agentId: userIds['bob'],
    });
    await patchTicket(t5, {
      createdAt: at(60 * DAY),
      status: 'CLOSED',
      resolvedAt: at(59 * DAY),
      agentId: userIds['ada'],
    });
    // Negative duration (resolvedAt before createdAt): counts as resolved in the
    // window but must be excluded from duration statistics.
    await patchTicket(t6, {
      createdAt: at(5 * DAY),
      status: 'RESOLVED',
      resolvedAt: at(6 * DAY),
      agentId: null,
    });
    // RESOLVED without a timestamp: never treated as resolved for durations.
    await patchTicket(t7, { createdAt: at(4 * DAY), status: 'RESOLVED', resolvedAt: null });
    await patchTicket(t8, { createdAt: at(200 * DAY) });

    // ── Escalations: one STAFF (manual) + one AI-triggered ───────────────────
    // Seeded directly for deterministic windows; both are ACTIVE/PENDING so the
    // active-handoff metric has a known value, and the actorType split is the
    // input the AI-handoff metric must respect.
    await EscalationModel.create([
      {
        workspaceId: acmeWs,
        conversationId: oid(t4Conversation),
        ticketId: t4.oid,
        customerId: customerOid,
        triggerType: 'MANUAL',
        reasonCode: 'MANUAL',
        priority: 'MEDIUM',
        status: 'PENDING',
        initiatedBy: { actorType: 'STAFF', actorId: userIds['bob'] },
      },
      {
        workspaceId: acmeWs,
        conversationId: oid(t7Conversation),
        ticketId: t7.oid,
        customerId: customerOid,
        triggerType: 'AI_INSUFFICIENT_KNOWLEDGE',
        reasonCode: 'NO_KNOWLEDGE',
        priority: 'HIGH',
        status: 'PENDING',
        initiatedBy: { actorType: 'AI_AGENT', actorId: userIds['ada'] },
      },
    ]);

    // ── Knowledge base: published / draft / archived ─────────────────────────
    async function newArticle(title: string): Promise<string> {
      const res = await ada('POST', acme('/knowledge-base/articles'), {
        body: { title, summary: 'Analytics summary', body: 'Analytics body text.' },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const id = dataOf<{ article?: { id?: string } }>(res)?.article?.id ?? '';
      assert.ok(id.length > 0);
      return id;
    }
    const publishedArticle = await newArticle('Published analytics article');
    const draftArticle = await newArticle('Draft analytics article');
    assert.ok(draftArticle.length > 0);
    const archivedArticle = await newArticle('Archived analytics article');
    const publish = await ada('POST', acme(`/knowledge-base/articles/${publishedArticle}/publish`), {
      body: {},
    });
    assert.equal(publish.status, 200, JSON.stringify(publish.body));
    const archiveArticle = await ada(
      'POST',
      acme(`/knowledge-base/articles/${archivedArticle}/archive`),
      { body: {} },
    );
    assert.equal(archiveArticle.status, 200, JSON.stringify(archiveArticle.body));

    // ── AI audit rows (existing content-free trail; one row is old) ──────────
    const auditBase = {
      workspaceId: acmeWs,
      actorId: userIds['ada'],
      resourceType: 'agent_response',
    };
    await AuditLogModel.create([
      {
        ...auditBase,
        action: 'agent.question_answered',
        resourceId: 'ask',
        metadata: {
          outcome: 'ANSWERED',
          abstentionReason: null,
          citationsCount: 2,
          passagesRetrieved: 3,
          model: 'test-model',
        },
      },
      {
        ...auditBase,
        action: 'agent.question_answered',
        resourceId: 'ask',
        metadata: {
          outcome: 'ABSTAINED',
          abstentionReason: 'NO_KNOWLEDGE',
          citationsCount: 0,
          passagesRetrieved: 0,
        },
      },
      {
        ...auditBase,
        action: 'agent.question_answered',
        resourceId: 'ask',
        metadata: {
          outcome: 'ABSTAINED',
          abstentionReason: 'LOW_RELEVANCE',
          citationsCount: 0,
          passagesRetrieved: 1,
        },
      },
      {
        ...auditBase,
        action: 'agent.question_failed',
        resourceId: 'ask',
        metadata: { outcome: 'FAILED', failureCode: 'AI_PROVIDER_ERROR' },
      },
      {
        ...auditBase,
        action: 'agent.question_answered',
        resourceId: 'old-ask',
        metadata: { outcome: 'ANSWERED', citationsCount: 1, passagesRetrieved: 1 },
      },
    ]);
    // Raw driver write (not the model): audit logs are append-only through
    // Mongoose, and this is test data placement, not a production mutation.
    await AuditLogModel.collection.updateOne(
      { workspaceId: acmeWs, resourceId: 'old-ask' },
      { $set: { createdAt: at(40 * DAY) } },
    );

    // ══ 1. Authorization ════════════════════════════════════════════════════
    {
      const anonymous = await http('GET', api(acme('/analytics/overview')));
      record('1.1 anonymous analytics → 401', anonymous.status === 401);

      const agent = await bob('GET', acme('/analytics/overview'));
      record('1.2 agent (no analytics.view) → 403', agent.status === 403);

      const viewer = await vic('GET', acme('/analytics/tickets'));
      record('1.3 viewer → 403', viewer.status === 403);

      const stranger = await sam('GET', acme('/analytics/overview'));
      record('1.4 non-member → 404 concealment', stranger.status === 404);

      const rivalOnAcme = await eve('GET', acme('/analytics/overview'));
      record('1.5 rival owner on another workspace path → 404', rivalOnAcme.status === 404);

      const malformed = await ada('GET', '/workspaces/not-an-object-id/analytics/overview');
      record('1.6 malformed workspace id → 422', malformed.status === 422);

      const unauthorizedExport = await vic('GET', acme('/analytics/reports/tickets.csv'));
      record('1.7 CSV export denied to viewer → 403', unauthorizedExport.status === 403);
    }

    // ══ 2. Overview (default 30d window) ═════════════════════════════════════
    {
      const res = await ada('GET', acme('/analytics/overview'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = dataOf<Overview>(res);

      record(
        '2.1 period is UTC with ordered ISO bounds (default 30d)',
        data.period.timezone === 'UTC' &&
          data.period.range === '30d' &&
          data.period.from.endsWith('Z') &&
          new Date(data.period.from).getTime() < new Date(data.period.to).getTime(),
      );
      record(
        '2.2 ticket total excludes the archived ticket (8 live of 9 created)',
        data.tickets.total === 8,
      );
      record(
        '2.3 ticket status counts (OPEN 2, IN_PROGRESS 1, WAITING 1, RESOLVED 3, CLOSED 1)',
        data.tickets.open === 2 &&
          data.tickets.inProgress === 1 &&
          data.tickets.waitingForCustomer === 1 &&
          data.tickets.resolved === 3 &&
          data.tickets.closed === 1 &&
          data.tickets.byStatus['OPEN'] === 2 &&
          data.tickets.byStatus['CLOSED'] === 1,
      );
      record(
        '2.4 priority counts (LOW 2, MEDIUM 4, HIGH 1, URGENT 1)',
        data.tickets.byPriority['LOW'] === 2 &&
          data.tickets.byPriority['MEDIUM'] === 4 &&
          data.tickets.byPriority['HIGH'] === 1 &&
          data.tickets.byPriority['URGENT'] === 1,
      );
      record(
        '2.5 created/resolved in window use createdAt/resolvedAt (6 / 2)',
        data.tickets.createdInPeriod === 6 && data.tickets.resolvedInPeriod === 2,
      );
      record(
        '2.6 assignment grouping (3 assigned / 5 unassigned)',
        data.tickets.assignment.assigned === 3 && data.tickets.assignment.unassigned === 5,
      );
      record(
        '2.7 top assignees bounded and deterministic (bob 2, ada 1)',
        data.tickets.topAssignees.length === 2 &&
          data.tickets.topAssignees[0]?.userId === userIds['bob']!.toHexString() &&
          data.tickets.topAssignees[0]?.tickets === 2 &&
          data.tickets.topAssignees[1]?.tickets === 1,
      );
      record(
        '2.8 customer metrics use real schema statuses (3 total, active 2, blocked 1)',
        data.customers.total === 3 &&
          data.customers.newInPeriod === 3 &&
          data.customers.byStatus['active'] === 2 &&
          data.customers.byStatus['blocked'] === 1,
      );
      record(
        '2.9 conversations derive open/closed from the live parent ticket (3 total, 1 open, 2 closed)',
        data.conversations.total === 3 &&
          data.conversations.open === 1 &&
          data.conversations.closed === 2 &&
          data.conversations.createdInPeriod === 3,
      );
      record(
        '2.10 escalation metrics (2 total, 2 active, both PENDING)',
        data.escalations.total === 2 &&
          data.escalations.active === 2 &&
          data.escalations.createdInPeriod === 2 &&
          data.escalations.byStatus['PENDING'] === 2 &&
          data.escalations.byStatus['CANCELLED'] === 0,
      );
      record(
        '2.11 KB metrics (3 total, 1 published, 1 draft, 1 archived)',
        data.knowledgeBase.total === 3 &&
          data.knowledgeBase.published === 1 &&
          data.knowledgeBase.draft === 1 &&
          data.knowledgeBase.archived === 1,
      );
      record(
        '2.12 AI summary from audit rows (4 requests: 1 answered, 2 abstained, 1 failed)',
        data.ai.requests === 4 &&
          data.ai.answered === 1 &&
          data.ai.abstained === 2 &&
          data.ai.failed === 1 &&
          data.ai.citationBackedAnswers === 1 &&
          data.ai.aiEscalations === 1 &&
          data.ai.humanHandoffs === 1,
      );
    }

    // ══ 3. Date ranges ══════════════════════════════════════════════════════
    {
      const ninety = dataOf<Overview>(await ada('GET', acme('/analytics/overview?range=90d')));
      record(
        '3.1 range=90d includes the 60-day-old ticket (created 7, resolved 3)',
        ninety.tickets.createdInPeriod === 7 && ninety.tickets.resolvedInPeriod === 3,
      );

      const seven = dataOf<Overview>(await ada('GET', acme('/analytics/overview?range=7d')));
      record(
        '3.2 range=7d narrows correctly (created 4, resolved 1)',
        seven.tickets.createdInPeriod === 4 && seven.tickets.resolvedInPeriod === 1,
      );

      const today = dataOf<Overview>(await ada('GET', acme('/analytics/overview?range=today')));
      record(
        '3.3 range=today starts at the UTC day boundary with a positive span',
        today.period.range === 'today' &&
          today.period.from.endsWith('T00:00:00.000Z') &&
          today.tickets.createdInPeriod === 1,
      );

      const from = new Date(now - 12 * DAY).toISOString();
      const to = new Date(now - 3 * DAY).toISOString();
      const custom = dataOf<Overview>(
        await ada(
          'GET',
          acme(
            `/analytics/overview?range=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          ),
        ),
      );
      record(
        '3.4 custom window honours inclusive from / exclusive to (created 4, resolved 2)',
        custom.period.range === 'custom' &&
          custom.tickets.createdInPeriod === 4 &&
          custom.tickets.resolvedInPeriod === 2,
      );

      const missingTo = await ada(
        'GET',
        acme(`/analytics/overview?range=custom&from=${encodeURIComponent(from)}`),
      );
      record('3.5 range=custom without to → 422', missingTo.status === 422);

      const reversed = await ada(
        'GET',
        acme(`/analytics/overview?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`),
      );
      record('3.6 from after to → 422', reversed.status === 422);

      const tooWide = await ada(
        'GET',
        acme(
          `/analytics/overview?from=${encodeURIComponent(new Date(now - 400 * DAY).toISOString())}&to=${encodeURIComponent(new Date(now).toISOString())}`,
        ),
      );
      record('3.7 window longer than 366 days → 422', tooWide.status === 422);

      const presetPlusBounds = await ada(
        'GET',
        acme(
          `/analytics/overview?range=7d&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        ),
      );
      record('3.8 preset range combined with from/to → 422', presetPlusBounds.status === 422);

      const badDate = await ada('GET', acme('/analytics/overview?from=yesterday&to=today'));
      record('3.9 invalid date format → 422', badDate.status === 422);

      const badRange = await ada('GET', acme('/analytics/overview?range=all-time'));
      record('3.10 unsupported range preset → 422', badRange.status === 422);

      const unknownParam = await ada(
        'GET',
        acme('/analytics/overview?workspaceId=000000000000000000000000'),
      );
      record('3.11 unknown query parameter → 422 (strict schema)', unknownParam.status === 422);

      const operatorInjection = await ada('GET', acme('/analytics/overview?range%5B%24ne%5D=x'));
      record('3.12 operator-shaped query param → 422', operatorInjection.status === 422);

      const badBucket = await ada('GET', acme('/analytics/tickets?bucket=hour'));
      record('3.13 unsupported bucket → 422', badBucket.status === 422);
    }

    // ══ 4. Ticket analytics & resolution durations ══════════════════════════
    {
      const res = await ada('GET', acme('/analytics/tickets'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = dataOf<TicketAnalytics>(res);

      record(
        '4.1 totals mirror the overview (8 live, 6 created, 2 resolved in window)',
        data.tickets.total === 8 &&
          data.tickets.createdInPeriod === 6 &&
          data.tickets.resolvedInPeriod === 2,
      );
      record(
        '4.2 status/priority breakdowns match persisted tickets',
        data.byStatus['RESOLVED'] === 3 &&
          data.byStatus['OPEN'] === 2 &&
          data.byPriority['MEDIUM'] === 4,
      );

      const bucketAligned = data.created.every((point) => point.bucket.endsWith(':00:00.000Z'));
      const ascending = data.created.every((point, index) =>
        index === 0 ? true : data.created[index - 1]!.bucket < point.bucket,
      );
      record(
        '4.3 day buckets are zero-filled, chronological and UTC-aligned (30–31 points)',
        data.created.length >= 30 &&
          data.created.length <= 31 &&
          bucketAligned &&
          ascending &&
          data.created.every((point) => Number.isInteger(point.count) && point.count >= 0),
      );
      record(
        '4.4 created trend sums to createdInPeriod (6)',
        data.created.reduce((sum, point) => sum + point.count, 0) === 6,
      );
      record(
        '4.5 resolution trend sums to resolvedInPeriod (2)',
        data.resolved.reduce((sum, point) => sum + point.count, 0) === 2,
      );
      record(
        '4.6 duration excludes unresolved/null/negative stamps (count 1, 48h)',
        data.resolutionTime.count === 1 &&
          data.resolutionTime.averageMs === 48 * HOUR &&
          data.resolutionTime.minMs === 48 * HOUR &&
          data.resolutionTime.maxMs === 48 * HOUR &&
          data.resolutionTime.medianMs === 48 * HOUR,
      );

      const repeat = dataOf<TicketAnalytics>(await ada('GET', acme('/analytics/tickets')));
      record(
        '4.7 identical requests produce identical trend buckets',
        JSON.stringify(repeat.created) === JSON.stringify(data.created),
      );

      const weekly = dataOf<TicketAnalytics>(
        await ada('GET', acme('/analytics/tickets?range=90d&bucket=week')),
      );
      record(
        '4.8 week buckets start on Monday and sum to 7',
        weekly.created.length >= 12 &&
          weekly.created.length <= 15 &&
          weekly.created.reduce((sum, point) => sum + point.count, 0) === 7 &&
          weekly.created.every((point) => new Date(point.bucket).getUTCDay() === 1),
      );

      const monthly = dataOf<TicketAnalytics>(
        await ada('GET', acme('/analytics/tickets?range=90d&bucket=month')),
      );
      record(
        '4.9 month buckets start on the first of the month (3–4 points)',
        monthly.created.length >= 3 &&
          monthly.created.length <= 4 &&
          monthly.created.every((point) => point.bucket.endsWith('-01T00:00:00.000Z')),
      );

      record(
        '4.10 90d durations: 2 valid, avg 36h, min 24h, max 48h',
        monthly.resolutionTime.count === 2 &&
          monthly.resolutionTime.averageMs === 36 * HOUR &&
          monthly.resolutionTime.minMs === 24 * HOUR &&
          monthly.resolutionTime.maxMs === 48 * HOUR,
      );
      record(
        '4.11 median is an approximate percentile inside [min, max]',
        monthly.resolutionTime.medianMs !== null &&
          monthly.resolutionTime.medianMs >= 24 * HOUR &&
          monthly.resolutionTime.medianMs <= 48 * HOUR,
      );
    }

    // ══ 5. Performance ══════════════════════════════════════════════════════
    {
      const res = await ada('GET', acme('/analytics/performance'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = dataOf<Performance>(res);

      record(
        '5.1 backlog counts live open-ish tickets only (4: 2 open, 1 in progress, 1 waiting)',
        data.backlog.totalBacklog === 4 &&
          data.backlog.open === 2 &&
          data.backlog.inProgress === 1 &&
          data.backlog.waitingForCustomer === 1,
      );
      record(
        '5.2 awaiting-assignment count and backlog priority mix',
        data.backlog.unassigned === 3 &&
          data.backlog.byPriority['MEDIUM'] === 2 &&
          data.backlog.byPriority['HIGH'] === 1 &&
          data.backlog.byPriority['LOW'] === 1 &&
          data.backlog.byPriority['URGENT'] === 0,
      );
      record(
        '5.3 resolution duration reuses the real-stamp definition (48h)',
        data.resolutionTime.count === 1 && data.resolutionTime.averageMs === 48 * HOUR,
      );
      record(
        '5.4 first STAFF reply excludes INTERNAL notes (1 conversation, 24h)',
        data.firstStaffReply.conversations === 1 &&
          data.firstStaffReply.averageMs === 24 * HOUR,
      );
      record(
        '5.5 customer first response is explicitly unavailable, not fabricated',
        data.customerFirstResponse.available === false &&
          data.customerFirstResponse.reason.length > 20,
      );
      record(
        '5.6 escalation frequency is a documented ratio (2 / 6 = 0.3333)',
        data.escalationFrequency.escalationsCreated === 2 &&
          data.escalationFrequency.ticketsCreated === 6 &&
          data.escalationFrequency.perTicket === 0.3333,
      );
      record(
        '5.7 message volume counts by visibility (3 total, 1 public, 2 internal)',
        data.conversationVolume.conversationsCreated === 3 &&
          data.conversationVolume.messages.total === 3 &&
          data.conversationVolume.messages.public === 1 &&
          data.conversationVolume.messages.internal === 2,
      );

      const serialized = JSON.stringify(data);
      record(
        '5.8 no message content, ticket text or customer identity in performance',
        !serialized.includes('marker') &&
          !serialized.includes('nora.analytics@example.test') &&
          !serialized.includes('Analytics seed'),
      );
    }

    // ══ 6. AI analytics ═════════════════════════════════════════════════════
    {
      const res = await ada('GET', acme('/analytics/ai'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = dataOf<AiAnalytics>(res);

      record(
        '6.1 audit-derived outcomes (4 requests = 1 answered + 2 abstained + 1 failed)',
        data.metrics.requests === 4 &&
          data.metrics.answered === 1 &&
          data.metrics.abstained === 2 &&
          data.metrics.failed === 1 &&
          data.metrics.requests ===
            data.metrics.answered + data.metrics.abstained + data.metrics.failed,
      );
      record(
        '6.2 citation-backed count and machine abstention reasons',
        data.metrics.citationBackedAnswers === 1 &&
          data.metrics.abstentionReasons['NO_KNOWLEDGE'] === 1 &&
          data.metrics.abstentionReasons['LOW_RELEVANCE'] === 1,
      );
      record(
        '6.3 AI handoffs counted once; the STAFF escalation is excluded',
        data.metrics.aiEscalations === 1 &&
          data.metrics.humanHandoffs === 1 &&
          data.metrics.aiEscalationsByTrigger['AI_INSUFFICIENT_KNOWLEDGE'] === 1,
      );
      record(
        '6.4 daily series is zero-filled and sums to the totals',
        data.timeSeries.length >= 30 &&
          data.timeSeries.length <= 31 &&
          data.timeSeries.reduce((sum, point) => sum + point.answered, 0) === 1 &&
          data.timeSeries.reduce((sum, point) => sum + point.abstained, 0) === 2 &&
          data.timeSeries.reduce((sum, point) => sum + point.failed, 0) === 1,
      );
      record(
        '6.5 provider state is reported as configuration, not live usage',
        data.aiProviderConfigured === false,
      );
      record(
        '6.6 no audit metadata, model name or failure code is exposed',
        !JSON.stringify(data).includes('test-model') &&
          !JSON.stringify(data).includes('AI_PROVIDER_ERROR'),
      );

      const ninety = dataOf<AiAnalytics>(await ada('GET', acme('/analytics/ai?range=90d')));
      record(
        '6.7 the 40-day-old row is outside 30d but inside 90d (4 vs 5 requests)',
        data.metrics.requests === 4 && ninety.metrics.requests === 5 && ninety.metrics.answered === 2,
      );
    }

    // ══ 7. Tenant isolation + empty workspace ═══════════════════════════════
    {
      const rivalOverview = dataOf<Overview>(await eve('GET', rival('/analytics/overview')));
      record(
        '7.1 rival analytics counts only its own workspace',
        rivalOverview.tickets.total === 1 &&
          rivalOverview.customers.total === 1 &&
          rivalOverview.conversations.total === 0 &&
          rivalOverview.escalations.total === 0 &&
          rivalOverview.knowledgeBase.total === 0 &&
          rivalOverview.ai.requests === 0,
      );

      const rivalTickets = dataOf<TicketAnalytics>(await eve('GET', rival('/analytics/tickets')));
      record(
        '7.2 rival trends contain only its own ticket (created 1)',
        rivalTickets.tickets.total === 1 &&
          rivalTickets.created.reduce((sum, point) => sum + point.count, 0) === 1,
      );

      const acmeAgain = dataOf<Overview>(await ada('GET', acme('/analytics/overview')));
      record('7.3 acme metrics unaffected by rival reads', acmeAgain.tickets.total === 8);

      const emptyOverview = dataOf<Overview>(await sam('GET', empty('/analytics/overview')));
      record(
        '7.4 empty workspace returns valid zeros (not errors, not nulls)',
        emptyOverview.tickets.total === 0 &&
          emptyOverview.tickets.createdInPeriod === 0 &&
          emptyOverview.customers.total === 0 &&
          emptyOverview.conversations.total === 0 &&
          emptyOverview.escalations.byStatus['PENDING'] === 0 &&
          emptyOverview.knowledgeBase.total === 0 &&
          emptyOverview.ai.requests === 0,
      );

      const emptyTickets = dataOf<TicketAnalytics>(await sam('GET', empty('/analytics/tickets')));
      record(
        '7.5 empty time series are zero-filled with a full bucket set',
        emptyTickets.created.length >= 30 &&
          emptyTickets.created.every((point) => point.count === 0) &&
          emptyTickets.resolutionTime.count === 0 &&
          emptyTickets.resolutionTime.averageMs === null,
      );

      const emptyPerformance = dataOf<Performance>(
        await sam('GET', empty('/analytics/performance')),
      );
      record(
        '7.6 empty performance metrics are null/zero, not fabricated ratios',
        emptyPerformance.backlog.totalBacklog === 0 &&
          emptyPerformance.escalationFrequency.perTicket === null &&
          emptyPerformance.firstStaffReply.conversations === 0 &&
          emptyPerformance.firstStaffReply.averageMs === null,
      );

      const emptyAi = dataOf<AiAnalytics>(await sam('GET', empty('/analytics/ai')));
      record(
        '7.7 empty AI metrics are genuine zeros',
        emptyAi.metrics.requests === 0 &&
          emptyAi.metrics.abstained === 0 &&
          emptyAi.timeSeries.every((point) => point.answered + point.abstained + point.failed === 0),
      );

      const emptyCsv = await sam('GET', empty('/analytics/reports/tickets.csv'));
      record(
        '7.8 empty workspace export returns the header only',
        emptyCsv.status === 200 &&
          emptyCsv.text.trim() ===
            'number,status,priority,created_at,resolved_at,resolution_minutes,assigned',
      );
    }

    // ══ 8. CSV export ═══════════════════════════════════════════════════════
    {
      const res = await ada('GET', acme('/analytics/reports/tickets.csv'));
      const contentType = res.headers.get('content-type') ?? '';
      const disposition = res.headers.get('content-disposition') ?? '';

      record(
        '8.1 export is text/csv, attachment, no-store, nosniff',
        res.status === 200 &&
          contentType.startsWith('text/csv') &&
          disposition.startsWith('attachment;') &&
          res.headers.get('cache-control') === 'no-store' &&
          res.headers.get('x-content-type-options') === 'nosniff',
      );

      const lines = res.text.trim().split('\n');
      record(
        '8.2 header is machine-only and rows equal created-in-window (6)',
        lines.length === 7 &&
          lines[0] === 'number,status,priority,created_at,resolved_at,resolution_minutes,assigned',
      );
      record(
        '8.3 export contains no subject, customer identity or note content',
        !res.text.includes('nora.analytics@example.test') &&
          !res.text.includes('Alpha open queue') &&
          !res.text.includes('marker') &&
          !res.text.includes('Analytics seed'),
      );

      const rows = lines.slice(1).map((line) => line.split(','));
      record(
        '8.4 resolved rows carry resolved_at and non-negative minutes; unresolved are blank',
        rows.every((row) => row.length === 7) &&
          rows.some((row) => row[1] === 'RESOLVED' && row[4] !== '' && Number(row[5]) >= 0) &&
          rows.some((row) => row[1] !== 'RESOLVED' && row[4] === '' && row[5] === ''),
      );
      record(
        '8.5 assignment is exported as a machine boolean',
        rows.every((row) => row[6] === 'true' || row[6] === 'false'),
      );

      const bounded = await ada(
        'GET',
        acme(
          `/analytics/reports/tickets.csv?from=${encodeURIComponent(new Date(now - 400 * DAY).toISOString())}&to=${encodeURIComponent(new Date(now).toISOString())}`,
        ),
      );
      record('8.6 export rejects an over-wide range → 422', bounded.status === 422);

      const injectionParam = await ada(
        'GET',
        acme('/analytics/reports/tickets.csv?from%5B%24ne%5D=x'),
      );
      record('8.7 export rejects operator-shaped params → 422', injectionParam.status === 422);

      record(
        '8.8 CSV cell escaping blocks formula injection and quotes delimiters',
        csvCell('=1+1') === "'=1+1" &&
          csvCell('+SUM(A1)') === "'+SUM(A1)" &&
          csvCell('-2') === "'-2" &&
          csvCell('@cmd') === "'@cmd" &&
          csvCell('a,b') === '"a,b"' &&
          csvCell('say "hi"') === '"say ""hi"""' &&
          csvCell(null) === '',
      );
    }

    // ══ 9. Response hygiene ═════════════════════════════════════════════════
    {
      const overviewRaw = JSON.stringify(dataOf<Overview>(await ada('GET', acme('/analytics/overview'))));
      record(
        '9.1 overview leaks no customer email, ticket text or audit content',
        !overviewRaw.includes('@example.test') &&
          !overviewRaw.includes('Analytics seed') &&
          !overviewRaw.includes('marker'),
      );
      record(
        '9.2 overview exposes no raw documents or internal fields',
        !overviewRaw.includes('"_id"') &&
          !overviewRaw.includes('workspaceId') &&
          !overviewRaw.includes('deletedAt'),
      );

      const aiRaw = JSON.stringify(dataOf<AiAnalytics>(await ada('GET', acme('/analytics/ai'))));
      record(
        '9.3 AI analytics carries no prompts, answers or provider secrets',
        !aiRaw.includes('prompt') && !aiRaw.includes('apiKey') && !aiRaw.includes('answer"'),
      );
    }
  } finally {
    await shutdown();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
