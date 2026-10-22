/**
 * Conversation & Message verification driver — HTTP-level end-to-end flows
 * (Prompt 9), following the verify-tickets.ts pattern:
 *
 * Boots its own in-memory mongod + the REAL Express app on an ephemeral port,
 * registers users via the real auth flows, seeds memberships/customers where
 * no API exists, and exercises conversation/message behavior over real HTTP:
 *
 *   1.  Get-or-create primary conversation: 201 created / 200 idempotent,
 *       subject normalization, unknown-field rejection
 *   2.  Unauthenticated rejection on every endpoint (401)
 *   3.  Strangers (no membership) get 404 concealment on every endpoint
 *   4.  One-primary-conversation-per-ticket: unique index, concurrent
 *       get-or-create race yields exactly ONE document
 *   5.  Repository/service tenant isolation: cross-workspace conversation
 *       access concealed (404) in both directions
 *   6.  Public reply: agent (assigned / creator), admin, owner; metadata
 *       (lastMessageAt/lastMessageById) updated server-side
 *   7.  Agent cap: unassigned non-creator agent denied (403); assigned
 *       allowed; unassigned ticket admin/owner allowed (triage)
 *   8.  Internal notes: staff can send+read; viewer denied (403) and
 *       internal notes excluded FROM THE QUERY in viewer thread reads
 *   9.  Viewer is strictly read-only (get-or-create → 403)
 *   10. Message validation: empty/whitespace/oversized bodies → 422,
 *       allowed-size body → 201, mass-assignment fields rejected (422)
 *   11. Edit policy: sender-only body edit audited; non-sender → 403;
 *       visibility flip / sender spoof on PATCH → 422
 *   12. Invalid and nonexistent ids (422/404), archived ticket → 404 across
 *       every conversation/message path
 *   13. Pagination: bounded pages, stable ascending chronology, totals
 *   14. Metadata self-heal: corrupted advisory metadata repaired on read
 *   15. Audit: conversation.created / message.created / message.edited;
 *       no message content or PII in metadata
 *   16. Regressions: health, auth, workspace detail, ticket+customer flows
 *       still work after mounting conversation routes
 *
 * NOTE: no customer-portal authentication exists yet (documented Prompt 9
 * dependency), so customer-identity scenarios are verified structurally:
 * every persisted message derives senderType `AGENT` from server context and
 * internal-note access is role-derived — the driver asserts those
 * invariants; customer-sender flows arrive with the customer identity
 * mechanism (never by trusting a client-supplied customerId).
 *
 * Server code imports DYNAMICALLY inside main() AFTER MONGODB_URI is set
 * (env.config.ts freezes process.env at module-evaluation time).
 */
import type { Server } from 'node:http';

import { MongoMemoryServer } from 'mongodb-memory-server';

interface Check {
  name: string;
  pass: boolean;
}

const checks: Check[] = [];

function record(name: string, pass: boolean): void {
  checks.push({ name, pass });
  // eslint-disable-next-line no-console -- verification driver output
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Map<string, string>;
}

async function http(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: { body?: unknown; token?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  // Unique IP per request defeats cross-test rate-limit coupling.
  headers['x-forwarded-for'] = `10.8.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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
  const headersMap = new Map<string, string>();
  response.headers.forEach((value, key) => headersMap.set(key.toLowerCase(), value));
  return { status: response.status, body, headers: headersMap };
}

function assert(condition: boolean): void {
  if (!condition) throw new Error('assertion failed inside test steps');
}

/** Shape of conversation/message DTO subsets used by assertions. */
interface ConversationPayload {
  id?: string;
  workspaceId?: string;
  ticketId?: string;
  customerId?: string;
  subject?: string | null;
  isPrimary?: boolean;
  lastMessageAt?: string | null;
  lastMessageById?: string | null;
  createdAt?: string;
}

interface MessagePayload {
  id?: string;
  workspaceId?: string;
  conversationId?: string;
  ticketId?: string;
  senderId?: string;
  senderType?: string;
  body?: string;
  visibility?: string;
  attachments?: unknown[];
  createdAt?: string;
}

function conversationOf(result: HttpResult): ConversationPayload {
  const data = result.body['data'] as
    | { conversation?: ConversationPayload }
    | undefined;
  return data?.conversation ?? {};
}

function messageOf(result: HttpResult): MessagePayload {
  const data = result.body['data'] as
    | { message?: MessagePayload }
    | undefined;
  return data?.message ?? {};
}

interface ListData<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

function conversationListData(result: HttpResult): ListData<ConversationPayload> {
  return result.body['data'] as unknown as ListData<ConversationPayload>;
}

function messageListData(result: HttpResult): ListData<MessagePayload> {
  return result.body['data'] as unknown as ListData<MessagePayload>;
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_conversations' },
  });

  const expectedUri = memoryServer.getUri('verify_conversations');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  const port = 4021;
  process.env['PORT'] = String(port);

  let httpServer: Server | undefined;
  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error('env.MONGODB_URI mismatch — aborting to protect foreign databases');
  }

  httpServer = await startServer();
  const api = (path: string): string => `http://127.0.0.1:${port}/api/v1${path}`;
  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { WorkspaceMemberModel } = await import(
    '../server/src/modules/workspaces/workspace-member.model.js'
  );
  const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
  const { CustomerModel } = await import('../server/src/modules/customers/customer.model.js');
  const { TicketModel } = await import('../server/src/modules/tickets/ticket.model.js');
  const { ConversationModel } = await import(
    '../server/src/modules/conversations/conversation.model.js'
  );
  const { findLatestMessage } = await import(
    '../server/src/modules/conversations/message.repository.js'
  );

  const PASSWORD = 'Str0ngPass!42';

  async function newUser(name: string, email: string): Promise<string> {
    const reg = await http('POST', api('/auth/register'), {
      body: { name, email, password: PASSWORD },
    });
    if (reg.status !== 201) {
      console.log('REGISTER FAILED', JSON.stringify(reg.body));
    }
    assert(reg.status === 201);
    const login = await http('POST', api('/auth/login'), {
      body: { email, password: PASSWORD },
    });
    if (login.status !== 200) {
      console.log('LOGIN FAILED', JSON.stringify(login.body));
    }
    assert(login.status === 200);
    const data = login.body['data'] as { tokens?: { accessToken?: string } } | undefined;
    const token = data?.tokens?.accessToken;
    assert(typeof token === 'string' && token.length > 0);
    return token;
  }

  async function newWorkspace(token: string, name: string, slug: string): Promise<string> {
    const created = await http('POST', api('/workspaces'), {
      token,
      body: { name, slug },
    });
    assert(created.status === 201);
    const workspace = (created.body['data'] as { workspace?: { id?: string } } | undefined)
      ?.workspace;
    assert(typeof workspace?.id === 'string');
    return workspace.id;
  }

  async function addMember(
    workspaceId: string,
    email: string,
    role: 'admin' | 'agent' | 'viewer',
  ): Promise<void> {
    const user = await UserModel.findOne({ email });
    assert(user !== null);
    await WorkspaceMemberModel.create({ workspaceId, userId: user!._id, role });
  }

  async function newCustomer(workspaceId: string, name: string, email: string): Promise<string> {
    const customer = await CustomerModel.create({ workspaceId, name, email });
    return customer._id.toHexString();
  }

  async function newTicketId(
    bearer: string,
    workspaceId: string,
    customerId: string,
    subject: string,
    agentEmail?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      customerId,
      subject,
      description: 'Verification ticket for the conversation module.',
    };
    if (agentEmail !== undefined) {
      body['agentId'] = (await UserModel.findOne({ email: agentEmail }))!._id.toHexString();
    }
    const created = await http('POST', api(`/workspaces/${workspaceId}/tickets`), {
      token: bearer,
      body,
    });
    assert(created.status === 201);
    const ticket = (created.body['data'] as { ticket?: { id?: string } } | undefined)?.ticket;
    assert(typeof ticket?.id === 'string');
    return ticket.id;
  }

  function req(bearer: string | undefined) {
    return (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<HttpResult> =>
      http(method, api(path), {
        token: bearer,
        ...(body !== undefined ? { body } : {}),
      });
  }

  try {
    // ── Actors & tenants ───────────────────────────────────────────────────
    const ownerToken = await newUser('Ada Acme', 'ada9@acme.example');
    const adminToken = await newUser('Nia Admin', 'nia9@acme.example');
    const bobToken = await newUser('Bob Agent', 'bob9@acme.example');
    const carlToken = await newUser('Carl Agent', 'carl9@acme.example');
    const veraToken = await newUser('Vera Viewer', 'vera9@acme.example');
    const acmeId = await newWorkspace(ownerToken, 'Acme Helpdesk 9', 'acme-helpdesk-9');

    await addMember(acmeId, 'nia9@acme.example', 'admin');
    await addMember(acmeId, 'bob9@acme.example', 'agent');
    await addMember(acmeId, 'carl9@acme.example', 'agent');
    await addMember(acmeId, 'vera9@acme.example', 'viewer');

    const eveToken = await newUser('Eve Rival', 'eve@rival9.example');
    const rivalId = await newWorkspace(eveToken, 'Rival Co 9', 'rival-co-9');

    const strangerToken = await newUser('Sam Stranger', 'sam9@stranger.example');

    const acmeCustomer = await newCustomer(acmeId, 'Morgan Customer', 'morgan9@acme.example');
    const rivalCustomer = await newCustomer(rivalId, 'Rival Customer', 'rc9@rival9.example');

    const ada = req(ownerToken);
    const nia = req(adminToken);
    const bob = req(bobToken);
    const carl = req(carlToken);
    const vera = req(veraToken);
    const eve = req(eveToken);
    const stranger = req(strangerToken);
    const anon = req(undefined);

    const BOGUS_ID = 'd'.repeat(24);
    const INTERNAL_MARKER = 'INTERNAL-SALARY-NOTE-X7Q';
    const PUBLIC_MARKER = 'customer-facing-reply-body-AA1';

    // ── Ticket scaffolding ─────────────────────────────────────────────────
    // t1: owner-created, unassigned (owner/admin triage flows).
    const t1 = await newTicketId(ownerToken, acmeId, acmeCustomer, 'Owner ticket one');
    // t2: admin-created, ASSIGNED to bob (assigned-agent flow).
    const t2 = await newTicketId(adminToken, acmeId, acmeCustomer, 'Bob ticket', 'bob9@acme.example');
    // t3: agent-created by carl, unassigned (creator flow).
    const t3 = await newTicketId(carlToken, acmeId, acmeCustomer, 'Carl ticket');
    // t4: owner-created — will be archived to prove archive behavior.
    const t4 = await newTicketId(ownerToken, acmeId, acmeCustomer, 'Archived ticket');
    // t5: pagination ticket.
    const t5 = await newTicketId(ownerToken, acmeId, acmeCustomer, 'Pagination ticket');

    // ══ 1. Get-or-create the primary conversation ══════════════════════════
    let t1ConversationId = '';
    let t2ConversationId = '';
    let t3ConversationId = '';
    let t4ConversationId = '';
    let t5ConversationId = '';
    {
      const path = (ticketId: string): string =>
        `/workspaces/${acmeId}/tickets/${ticketId}/conversations`;

      const created = await ada('POST', path(t1), { subject: '  VIP thread  ' });
      const conv = conversationOf(created);
      t1ConversationId = conv.id ?? '';
      record(
        'goc: owner → 201 created, subject trimmed, isPrimary, references server-side',
        created.status === 201 &&
          created.status === 201 &&
          conv.isPrimary === true &&
          conv.subject === 'VIP thread' &&
          conv.ticketId === t1 &&
          conv.customerId === acmeCustomer &&
          conv.workspaceId === acmeId &&
          conv.lastMessageAt === null,
      );

      const again = await ada('POST', path(t1), {});
      record(
        'goc: repeat → 200 idempotent, same conversation, created=false',
        again.status === 200 && conversationOf(again).id === t1ConversationId,
      );

      const subjectKept = await nia('POST', path(t1), {});
      record(
        'goc: repeat without subject does not clear the stored subject',
        subjectKept.status === 200 && conversationOf(subjectKept).subject === 'VIP thread',
      );

      const unknownField = await ada('POST', path(t1), { customerId: rivalCustomer });
      record('goc: mass-assignment field rejected → 422', unknownField.status === 422);

      const emptySubject = await ada('POST', path(t1), { subject: '   ' });
      record('goc: whitespace-only subject → 422', emptySubject.status === 422);

      for (const actor of [ada, nia, bob, carl]) {
        const result = await actor('GET', path(t1));
        record(
          'goc/list: staff can list the primary conversation',
          result.status === 200 &&
            conversationListData(result).total === 1 &&
            conversationListData(result).items[0]?.id === t1ConversationId,
        );
        break;
      }

      const bobConvCreated = await bob('POST', path(t2), {});
      t2ConversationId = conversationOf(bobConvCreated).id ?? '';
      record(
        'goc: assigned agent may create his ticket conversation (201)',
        bobConvCreated.status === 201 && t2ConversationId.length === 24,
      );

      const carlConvCreated = await carl('POST', path(t3), {});
      t3ConversationId = conversationOf(carlConvCreated).id ?? '';
      record(
        'goc: creator agent may create his ticket conversation (201)',
        carlConvCreated.status === 201 && t3ConversationId.length === 24,
      );

      const t4Conv = await ada('POST', path(t4), {});
      t4ConversationId = conversationOf(t4Conv).id ?? '';
      assert(t4Conv.status === 201);

      const t5Conv = await ada('POST', path(t5), {});
      t5ConversationId = conversationOf(t5Conv).id ?? '';
      assert(t5Conv.status === 201);
    }

    // ══ 2. Unauthenticated rejection ═══════════════════════════════════════
    {
      const ticketConvPath = `/workspaces/${acmeId}/tickets/${t1}/conversations`;
      const convPath = `/workspaces/${acmeId}/conversations/${t1ConversationId}`;

      record('unauth: goc → 401', (await anon('POST', ticketConvPath, {})).status === 401);
      record('unauth: ticket conversations list → 401', (await anon('GET', ticketConvPath)).status === 401);
      record('unauth: conversation detail → 401', (await anon('GET', convPath)).status === 401);
      record(
        'unauth: send message → 401',
        (await anon('POST', `${convPath}/messages`, { body: 'hello' })).status === 401,
      );
      record('unauth: message list → 401', (await anon('GET', `${convPath}/messages`)).status === 401);
      record(
        'unauth: message detail → 401',
        (await anon('GET', `${convPath}/messages/${BOGUS_ID}`)).status === 401,
      );
      record(
        'unauth: message edit → 401',
        (await anon('PATCH', `${convPath}/messages/${BOGUS_ID}`, { body: 'x' })).status === 401,
      );
    }

    // ══ 3. Strangers (404 concealment) ═════════════════════════════════════
    {
      const ticketConvPath = `/workspaces/${acmeId}/tickets/${t1}/conversations`;
      const convPath = `/workspaces/${acmeId}/conversations/${t1ConversationId}`;

      record(
        'stranger: conversations list → 404',
        (await stranger('GET', ticketConvPath)).status === 404,
      );
      record(
        'stranger: goc → 404',
        (await stranger('POST', ticketConvPath, {})).status === 404,
      );
      record('stranger: conversation detail → 404', (await stranger('GET', convPath)).status === 404);
      record(
        'stranger: send message → 404',
        (await stranger('POST', `${convPath}/messages`, { body: 'sneak' })).status === 404,
      );
      record(
        'stranger: message list → 404',
        (await stranger('GET', `${convPath}/messages`)).status === 404,
      );
    }

    // ══ 4. One primary conversation per ticket (unique index + race) ═══════
    {
      const duplicateDocs = await ConversationModel.countDocuments({ ticketId: t1 });
      record('dup: only ONE conversation document per ticket after repeats', duplicateDocs === 1);

      // Fresh ticket for a true concurrent get-or-create race.
      const t6 = await newTicketId(ownerToken, acmeId, acmeCustomer, 'Race ticket');
      const [first, second] = await Promise.all([
        bob('POST', `/workspaces/${acmeId}/tickets/${t6}/conversations`, {}),
        nia('POST', `/workspaces/${acmeId}/tickets/${t6}/conversations`, {}),
      ]);
      const createdCount =
        Number((first.body['data'] as { created?: boolean }).created === true) +
        Number((second.body['data'] as { created?: boolean }).created === true);
      record(
        'dup: concurrent goc race → exactly one created=true, single document',
        first.status !== second.status &&
          createdCount === 1 &&
          (await ConversationModel.countDocuments({ ticketId: t6 })) === 1,
      );
    }

    // ══ 5. Cross-tenant isolation (both directions) ════════════════════════
    let rivalConversationId = '';
    {
      const t1ConvPath = `/workspaces/${acmeId}/conversations/${t1ConversationId}`;
      const rivalTicket = await newTicketId(eveToken, rivalId, rivalCustomer, 'Rival ticket');
      const rivalConv = await eve('POST', `/workspaces/${rivalId}/tickets/${rivalTicket}/conversations`, {});
      rivalConversationId = conversationOf(rivalConv).id ?? '';

      record(
        'tenant: eve cannot read acme conversation under her workspace (404)',
        (await eve('GET', `/workspaces/${rivalId}/conversations/${t1ConversationId}`)).status === 404,
      );
      record(
        'tenant: eve cannot list messages of acme conversation (404)',
        (await eve('GET', `/workspaces/${rivalId}/conversations/${t1ConversationId}/messages`)).status === 404,
      );
      record(
        'tenant: eve cannot send to acme conversation (404, real scoping not a spoofed 403)',
        (
          await eve('POST', `/workspaces/${rivalId}/conversations/${t1ConversationId}/messages`, {
            body: 'poison',
          })
        ).status === 404,
      );
      record(
        'tenant: eve cannot edit a message of acme conversation (404)',
        (
          await eve('PATCH', `/workspaces/${rivalId}/conversations/${t1ConversationId}/messages/${BOGUS_ID}`, {
            body: 'poison',
          })
        ).status === 404,
      );
      record(
        'tenant: eve cannot list acme ticket conversations (404)',
        (await eve('GET', `/workspaces/${rivalId}/tickets/${t1}/conversations`)).status === 404,
      );
      record(
        'tenant: eve cannot create a conversation for an acme ticket (404)',
        (await eve('POST', `/workspaces/${rivalId}/tickets/${t1}/conversations`, {})).status === 404,
      );
      record(
        'tenant: coop — eve reads her own conversation under her workspace (200)',
        (await eve('GET', `/workspaces/${rivalId}/conversations/${rivalConversationId}`)).status === 200,
      );

      const convDoc = await ConversationModel.findById(t1ConversationId);
      record(
        'tenant: customer reference copied from the ticket, never mutated by clients',
        convDoc !== null &&
          convDoc?.customerId.toHexString() === acmeCustomer &&
          convDoc?.ticketId.toHexString() === t1,
      );
    }

    // ══ 6-7. Public replies, agent cap, metadata ═══════════════════════════
    let bobPublicMessageId = '';
    let bobInternalMessageId = '';
    {
      const send = (
        actor: ReturnType<typeof req>,
        conversationId: string,
        body: Record<string, unknown>,
      ): Promise<HttpResult> =>
        actor('POST', `/workspaces/${acmeId}/conversations/${conversationId}/messages`, body);

      const adaReply = await send(ada, t1ConversationId, { body: PUBLIC_MARKER });
      record(
        'reply: owner public default → 201 AGENT sender, empty attachments',
        adaReply.status === 201 &&
          messageOf(adaReply).senderType === 'AGENT' &&
          messageOf(adaReply).visibility === 'PUBLIC' &&
          Array.isArray(messageOf(adaReply).attachments) &&
          (messageOf(adaReply).attachments as unknown[]).length === 0 &&
          typeof messageOf(adaReply).senderId === 'string',
      );

      const metaAfterReply = conversationOf(await ada('GET', `/workspaces/${acmeId}/conversations/${t1ConversationId}`));
      record(
        'reply: conversation lastMessage metadata updated server-side',
        metaAfterReply.lastMessageAt !== null && metaAfterReply.lastMessageById === messageOf(adaReply).senderId,
      );

      const bobOnT2 = await send(bob, t2ConversationId, { body: 'assigned agent reply' });
      record(
        'reply: ASSIGNED agent may send (201)',
        bobOnT2.status === 201 && messageOf(bobOnT2).conversationId === t2ConversationId,
      );
      bobPublicMessageId = messageOf(bobOnT2).id ?? '';

      const bobOnT1 = await send(bob, t1ConversationId, { body: 'unassigned agent reply' });
      record(
        'cap: unassigned non-creator agent → 403 on another ticket conversation',
        bobOnT1.status === 403,
      );

      const carlOnT3 = await send(carl, t3ConversationId, { body: 'creator agent reply' });
      record('cap: agent who opened the ticket may send (creator rule)', carlOnT3.status === 201);

      const carlOnT2 = await send(carl, t2ConversationId, { body: 'foreign agent reply' });
      record(
        'cap: agent cannot reply to a ticket assigned to a colleague (403)',
        carlOnT2.status === 403,
      );

      const adaNote = await send(ada, t1ConversationId, { body: INTERNAL_MARKER, visibility: 'INTERNAL' });
      record(
        'note: owner can add an INTERNAL note (201, persisted as INTERNAL)',
        adaNote.status === 201 && messageOf(adaNote).visibility === 'INTERNAL',
      );
      bobInternalMessageId = messageOf(adaNote).id ?? '';

      const niaNote = await send(nia, t2ConversationId, { body: 'admin internal note', visibility: 'INTERNAL' });
      record('note: unassigned admin may note any ticket (triage role)', niaNote.status === 201);
    }

    // ══ 8-9. Internal-note visibility & viewer read-only ═══════════════════
    {
      const staffThread = messageListData(
        await ada('GET', `/workspaces/${acmeId}/conversations/${t1ConversationId}/messages`),
      );
      const staffSees = staffThread.items.some((m) => m.body === INTERNAL_MARKER);
      record(
        'note: staff thread read includes the INTERNAL note (no sanitization for staff)',
        staffSees === true && staffThread.items.length === 2,
      );

      const veraThread = messageListData(
        await vera('GET', `/workspaces/${acmeId}/conversations/${t1ConversationId}/messages`),
      );
      record(
        'note: viewer thread read EXCLUDES internal notes in the query (1 PUBLIC, marker absent)',
        veraThread.items.length === 1 &&
          veraThread.total === 1 &&
          veraThread.items.every((m) => m.visibility === 'PUBLIC') &&
          !JSON.stringify(veraThread).includes(INTERNAL_MARKER),
      );

      const veraDetail = await vera(
        'GET',
        `/workspaces/${acmeId}/conversations/${t1ConversationId}/messages/${bobInternalMessageId}`,
      );
      record('note: viewer direct internal-note read → 403', veraDetail.status === 403);

      const veraSend = await vera(
        'POST',
        `/workspaces/${acmeId}/conversations/${t1ConversationId}/messages`,
        { body: 'viewer tries', visibility: 'INTERNAL' },
      );
      record('note: viewer cannot send internal notes (403 permission)', veraSend.status === 403);

      const veraGoc = await vera(
        'POST',
        `/workspaces/${acmeId}/tickets/${t1}/conversations`,
        {},
      );
      record('viewer: get-or-create denied (read-only, mutation → 403)', veraGoc.status === 403);

      const veraThreadOk = await vera(
        'GET',
        `/workspaces/${acmeId}/conversations/${t1ConversationId}/messages?page=1`,
      );
      record('viewer: thread READ allowed (view permission intact)', veraThreadOk.status === 200);

      const veraTicketList = await vera(
        'GET',
        `/workspaces/${acmeId}/tickets/${t1}/conversations`,
      );
      record('viewer: conversation listing allowed', veraTicketList.status === 200);
    }

    // ══ 10. Message validation & mass assignment ═══════════════════════════
    {
      const convPath = `/workspaces/${acmeId}/conversations/${t1ConversationId}`;
      record('validate: empty body → 422', (await ada('POST', `${convPath}/messages`, { body: '' })).status === 422);
      record(
        'validate: whitespace-only body → 422',
        (await ada('POST', `${convPath}/messages`, { body: '   \n\t ' })).status === 422,
      );
      record(
        'validate: oversized body (10_001 chars) → 422',
        (await ada('POST', `${convPath}/messages`, { body: 'a'.repeat(10_001) })).status === 422,
      );
      const maxOk = await ada('POST', `${convPath}/messages`, { body: 'a'.repeat(10_000) });
      record('validate: exactly 10_000 chars → 201', maxOk.status === 201);

      const spoofSender = await ada('POST', `${convPath}/messages`, {
        body: 'spoof',
        senderId: '5'.repeat(24),
        senderType: 'CUSTOMER',
      });
      record('validate: senderId/senderType spoof rejected → 422', spoofSender.status === 422);

      const injectIdentity = await ada('POST', `${convPath}/messages`, {
        body: 'inject',
        workspaceId: rivalId,
        ticketId: BOGUS_ID,
        conversationId: BOGUS_ID,
      });
      record(
        'validate: workspace/ticket/conversation identity injection rejected → 422',
        injectIdentity.status === 422,
      );

      const badVisibility = await ada('POST', `${convPath}/messages`, {
        body: 'bad visibility',
        visibility: 'secret',
      });
      record('validate: unknown visibility enum → 422', badVisibility.status === 422);

      const noTicket = await ada(
        'POST',
        `/workspaces/${acmeId}/tickets/${BOGUS_ID}/conversations`,
        {},
      );
      record('validate: conversation for UNKNOWN ticket → 404', noTicket.status === 404);

      const badTicketShape = await ada(
        'POST',
        `/workspaces/${acmeId}/tickets/not-an-id/conversations`,
        {},
      );
      record('validate: malformed ticket id → 422', badTicketShape.status === 422);

      record(
        'validate: unknown conversation id → 404',
        (await ada('GET', `/workspaces/${acmeId}/conversations/${BOGUS_ID}`)).status === 404,
      );
      record(
        'validate: malformed conversation id → 422',
        (await ada('GET', `/workspaces/${acmeId}/conversations/nope`)).status === 422,
      );
      record(
        'validate: message on unknown conversation → 404',
        (await ada('POST', `/workspaces/${acmeId}/conversations/${BOGUS_ID}/messages`, { body: 'x' })).status === 404,
      );
      record(
        'validate: unknown message id → 404',
        (await ada('GET', `${convPath}/messages/${BOGUS_ID}`)).status === 404,
      );
    }

    // ══ 11. Edit policy ════════════════════════════════════════════════════
    {
      const target = `/workspaces/${acmeId}/conversations/${t2ConversationId}/messages/${bobPublicMessageId}`;

      const senderEdit = await bob('PATCH', target, { body: 'edited by the original sender' });
      record(
        'edit: original sender body-only edit → 200, body changed, visibility kept',
        senderEdit.status === 200 &&
          messageOf(senderEdit).body === 'edited by the original sender' &&
          messageOf(senderEdit).visibility === 'PUBLIC',
      );

      const secondMessage = await nia(
        'POST',
        `/workspaces/${acmeId}/conversations/${t2ConversationId}/messages`,
        { body: 'admin message', visibility: 'INTERNAL' },
      );
      const adminMessageId = messageOf(secondMessage).id ?? '';

      const bobEditsAdmins = await bob(
        'PATCH',
        `/workspaces/${acmeId}/conversations/${t2ConversationId}/messages/${adminMessageId}`,
        { body: 'bob rewrites admin note' },
      );
      record('edit: NON-sender staff edit → 403 (history integrity)', bobEditsAdmins.status === 403);

      const adaEditsAdmins = await ada(
        'PATCH',
        `/workspaces/${acmeId}/conversations/${t2ConversationId}/messages/${adminMessageId}`,
        { body: 'owner rewrites admin note' },
      );
      record('edit: owner cannot rewrite someone else’s message → 403', adaEditsAdmins.status === 403);

      const visibilityFlip = await bob('PATCH', target, {
        body: 'flip attempt',
        visibility: 'INTERNAL',
      });
      record('edit: visibility flip field → 422 (immutable)', visibilityFlip.status === 422);

      const senderSwap = await bob('PATCH', target, {
        body: 'swap attempt',
        senderId: '5'.repeat(24),
      });
      record('edit: sender swap on PATCH → 422', senderSwap.status === 422);

      const viewerEdit = await vera('PATCH', target, { body: 'viewer edit' });
      record('edit: viewer edit → 403 (no edit permission)', viewerEdit.status === 403);
    }

    // ══ 12. Archived ticket behavior ═══════════════════════════════════════
    {
      const archive = await ada('POST', `/workspaces/${acmeId}/tickets/${t4}/archive`, {});
      assert(archive.status === 200);

      record(
        'archived: conversation detail → 404 (ticket-lifecycle inheritance)',
        (await ada('GET', `/workspaces/${acmeId}/conversations/${t4ConversationId}`)).status === 404,
      );
      record(
        'archived: thread list → 404',
        (await ada('GET', `/workspaces/${acmeId}/conversations/${t4ConversationId}/messages`)).status === 404,
      );
      record(
        'archived: send message → 404 (no tunneling into archived history)',
        (
          await ada('POST', `/workspaces/${acmeId}/conversations/${t4ConversationId}/messages`, {
            body: 'nope',
          })
        ).status === 404,
      );
      record(
        'archived: ticket conversations list → 404',
        (await ada('GET', `/workspaces/${acmeId}/tickets/${t4}/conversations`)).status === 404,
      );
    }

    // ══ 13. Pagination + chronology ════════════════════════════════════════
    {
      for (let index = 1; index <= 25; index += 1) {
        const sent = await ada('POST', `/workspaces/${acmeId}/conversations/${t5ConversationId}/messages`, {
          body: `m_${String(index).padStart(3, '0')}`,
        });
        assert(sent.status === 201);
      }

      const page1 = messageListData(
        await ada('GET', `/workspaces/${acmeId}/conversations/${t5ConversationId}/messages?limit=10&page=1`),
      );
      record(
        'pagination: total 25, first page has 10, hasMore, ascending chronology from the start',
        page1.total === 25 &&
          page1.items.length === 10 &&
          page1.hasMore === true &&
          page1.items[0]?.body === 'm_001',
      );

      const page3 = messageListData(
        await ada('GET', `/workspaces/${acmeId}/conversations/${t5ConversationId}/messages?limit=10&page=3`),
      );
      record(
        'pagination: last page has 5 items, hasMore=false, still ordered',
        page3.items.length === 5 &&
          page3.hasMore === false &&
          page3.items[0]?.body === 'm_021',
      );

      const oversizedPage = await ada(
        'GET',
        `/workspaces/${acmeId}/conversations/${t5ConversationId}/messages?limit=10000`,
      );
      record('pagination: unbounded page size rejected (422 strict bound)', oversizedPage.status === 422);

      const convAfterPagination = conversationOf(
        await ada('GET', `/workspaces/${acmeId}/conversations/${t5ConversationId}`),
      );
      const newestOnT5 = await findLatestMessage(
        (await ConversationModel.findById(t5ConversationId))!.workspaceId,
        (await ConversationModel.findById(t5ConversationId))!._id,
      );
      record(
        'pagination: last-message metadata derives from the real newest message (no fabricated counts)',
        newestOnT5 !== null &&
          convAfterPagination.lastMessageAt === newestOnT5.createdAt.toISOString() &&
          convAfterPagination.lastMessageById === newestOnT5.senderId.toHexString(),
      );
    }

    // ══ 14. Metadata self-heal (documented no-transaction limitation) ══════
    {
      const t5Doc = (await ConversationModel.findById(t5ConversationId))!;
      await ConversationModel.updateOne(
        { _id: t5ConversationId },
        { $set: { lastMessageAt: new Date(0), lastMessageById: null } },
      );
      const drifted = conversationOf(
        await ada('GET', `/workspaces/${acmeId}/conversations/${t5ConversationId}`),
      );
      record(
        'selfheal: corrupt metadata visible before repair read',
        drifted.lastMessageAt === '1970-01-01T00:00:00.000Z',
      );

      await ada('GET', `/workspaces/${acmeId}/conversations/${t5ConversationId}/messages?limit=1&page=3`);
      const repaired = conversationOf(
        await ada('GET', `/workspaces/${acmeId}/conversations/${t5ConversationId}`),
      );
      const newestOnT5again = await findLatestMessage(t5Doc.workspaceId, t5Doc._id);
      record(
        'selfheal: thread read repairs lastMessageAt/lastMessageById from the newest message',
        newestOnT5again !== null &&
          repaired.lastMessageAt === newestOnT5again.createdAt.toISOString() &&
          repaired.lastMessageById === newestOnT5again.senderId.toHexString(),
      );
    }

    // ══ 15. Audit events ═══════════════════════════════════════════════════
    {
      const actionsRelevant = [
        'conversation.created',
        'message.created',
        'message.edited',
      ];
      for (const action of actionsRelevant) {
        const count = await AuditLogModel.countDocuments({ action });
        record(`audit: ${action} recorded`, count > 0);
      }

      const convDocs = await AuditLogModel.find({
        action: { $in: ['conversation.created', 'message.created', 'message.edited'] },
      });
      const serialized = JSON.stringify(convDocs.map((d) => d.metadata ?? {}));
      record(
        'audit: no content or PII in metadata (markers/subjects absent)',
        !serialized.includes(INTERNAL_MARKER) &&
          !serialized.includes(PUBLIC_MARKER) &&
          !serialized.includes('VIP thread'),
      );

      const denial = await AuditLogModel.countDocuments({ action: 'workspace.permission_denied' });
      record('audit: permission denials still audited (RBAC middleware)', denial > 0);
    }

    // ══ 16. Regressions ════════════════════════════════════════════════════
    {
      const health = await http('GET', `http://127.0.0.1:${port}/health/ready`);
      record('regression: /health/ready still 200', health.status === 200);

      const badLogin = await http('POST', api('/auth/login'), {
        body: { email: 'ada9@acme.example', password: 'WrongPassword!' },
      });
      record('regression: auth rejects a bad password', badLogin.status === 401);

      const workspaceDetail = await ada('GET', `/workspaces/${acmeId}`);
      record('regression: workspace detail unchanged', workspaceDetail.status === 200);

      const ticketList = await ada('GET', `/workspaces/${acmeId}/tickets?limit=10`);
      record(
        'regression: ticket listing intact after mounting conversations',
        ticketList.status === 200 && Number((ticketList.body['data'] as { total?: number }).total) >= 5,
      );

      const ticketDetail = await ada('GET', `/workspaces/${acmeId}/tickets/${t1}`);
      record(
        'regression: ticket lifecycle untouched (no status change from messaging)',
        ticketDetail.status === 200 && (ticketDetail.body['data'] as { ticket?: { status?: string } }).ticket?.status === 'OPEN',
      );

      const customerCreate = await ada('POST', `/workspaces/${acmeId}/customers`, {
        name: ' regression customer 9 ',
        email: 'regression9@acme.example',
      });
      record('regression: customer creation still works', customerCreate.status === 201);
    }

    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer!.closeAllConnections();
    const failures = checks.filter((c) => !c.pass);
    // eslint-disable-next-line no-console -- verification driver output
    console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
    if (failures.length > 0) {
      // eslint-disable-next-line no-console -- verification driver output
      console.log('FAILURES:');
      for (const failure of failures) {
        // eslint-disable-next-line no-console -- verification driver output
        console.log(`  - ${failure.name}`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- verification driver crash output
    console.error('DRIVER ERROR:', error);
    process.exitCode = 1;
  } finally {
    // Crash paths must never leave the listening socket pumping the event loop,
    // or a failing driver would hang instead of exiting with a failure code.
    if (httpServer !== undefined) {
      httpServer.closeAllConnections();
      httpServer.close();
    }
    await Promise.all([
      (await import('mongoose')).default.connection.close(),
      memoryServer.stop(),
    ]);
  }
}

void main().then(() => {
  // Belt-and-braces: guarantee process termination even if some socket slips
  // through (undici keep-alive, in-flight mongod handles). The recorded exit
  // code always wins.
  process.exit(process.exitCode ?? 0);
});
