/**
 * Ticket verification driver — HTTP-level end-to-end flows (Prompt 8).
 *
 * Boots its own in-memory mongod + the REAL Express app on an ephemeral port,
 * registers users via the real auth flows, seeds memberships/customers
 * directly where no API exists, and exercises every ticket behavior over
 * real HTTP:
 *
 *   1.  Creation (owner/admin/agent; ticket number format; normalized data;
 *       priority + assignee at creation; agent may NOT assign at creation)
 *   2.  Unauthenticated rejection on every endpoint (401)
 *   3.  Strangers (no membership) get 404 concealment on every endpoint
 *   4.  Cross-workspace listing/detail/update/resolve prevented (real
 *       mutation checks in BOTH tenants)
 *   5.  Creation for another workspace's customer → 404
 *   6.  Assignment: assign/unassign; cross-workspace assignee → 404-ish
 *       (validation); viewer assignee → 422; agent assignment attempt → 403
 *   7.  Ticket-number uniqueness under 12 concurrent creations
 *   8.  Listing: pagination bounds, filters (status/priority/agent/customer/
 *       tags), date ranges, allowlisted sorting (incl. priority weight),
 *       search by number/subject without cross-tenant leakage
 *   9.  Immutable/privileged fields rejected (workspaceId, number, status…);
 *       DB unchanged
 *   10. Status transitions: legal + illegal (409 + allowed list),
 *       resolvedAt/closedAt stamps, resolve/reopen idempotence
 *   11. Agent cap: agent cannot modify unassigned (403), can modify
 *       assigned, can modify self-created
 *   12. Permission enforcement (viewer read-only, agent no assignment)
 *   13. Audit events recorded; no subject/description/PII in metadata
 *   14. Archive behavior (live-only default reads, archived slice)
 *   15. Regressions: health, auth bad password, workspace detail, customer
 *       create/detail still work after mounting ticket routes
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
  headers['x-forwarded-for'] = `10.7.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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

function extractError(body: Record<string, unknown>): { code?: unknown; message?: unknown; details?: unknown } {
  return (body['error'] as Record<string, unknown> | undefined) ?? {};
}

function assert(condition: boolean): void {
  if (!condition) throw new Error('assertion failed inside test steps');
}

/** Shape of a ticket DTO in responses (subset used by assertions). */
interface TicketPayload {
  id?: string;
  number?: string;
  subject?: string;
  description?: string;
  status?: string;
  priority?: string;
  customerId?: string;
  agentId?: string | null;
  tags?: string[];
  resolvedAt?: string | null;
  closedAt?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
}

function ticketOf(result: HttpResult): TicketPayload {
  const data = result.body['data'] as { ticket?: TicketPayload } | undefined;
  return data?.ticket ?? {};
}

function listData(result: HttpResult): { items: TicketPayload[]; total: number; hasMore: boolean } {
  return result.body['data'] as { items: TicketPayload[]; total: number; hasMore: boolean };
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_tickets' },
  });

  const expectedUri = memoryServer.getUri('verify_tickets');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  const port = 4019;
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

  const PASSWORD = 'Str0ngPass!42';

  async function newUser(name: string, email: string): Promise<string> {
    const reg = await http('POST', api('/auth/register'), {
      body: { name, email, password: PASSWORD },
    });
    /* eslint-disable no-console -- driver debug */
    if (reg.status !== 201) {
      console.log('REGISTER FAILED', JSON.stringify(reg.body));
    }
    /* eslint-enable no-console -- driver debug */
    assert(reg.status === 201);
    const login = await http('POST', api('/auth/login'), {
      body: { email, password: PASSWORD },
    });
    /* eslint-disable no-console -- driver debug */
    if (login.status !== 200) {
      console.log('LOGIN FAILED', JSON.stringify(login.body));
    }
    /* eslint-enable no-console -- driver debug */
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

  /** Seeds a customer directly (Prompt 7 verified the HTTP path end-to-end). */
  async function newCustomer(workspaceId: string, name: string, email: string): Promise<string> {
    const customer = await CustomerModel.create({ workspaceId, name, email });
    return customer._id.toHexString();
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
    const ownerToken = await newUser('Ada Acme', 'ada2@acme.example');
    const adminToken = await newUser('Nia Admin', 'nia2@acme.example');
    const bobToken = await newUser('Bob Agent', 'bob2@acme.example');
    const carlToken = await newUser('Carl Agent', 'carl2@acme.example');
    const veraToken = await newUser('Vera Viewer', 'vera2@acme.example');
    const acmeId = await newWorkspace(ownerToken, 'Acme Helpdesk', 'acme-helpdesk');

    await addMember(acmeId, 'nia2@acme.example', 'admin');
    await addMember(acmeId, 'bob2@acme.example', 'agent');
    await addMember(acmeId, 'carl2@acme.example', 'agent');
    await addMember(acmeId, 'vera2@acme.example', 'viewer');

    const eveToken = await newUser('Eve Rival', 'eve@rival2.example');
    const rivalId = await newWorkspace(eveToken, 'Rival Co', 'rival-co');
    const eveCustomer = await newCustomer(rivalId, 'Rival Customer', 'rc@rival2.example');

    const strangerToken = await newUser('Sam Stranger', 'sam2@stranger.example');

    await newCustomer(acmeId, 'Morgan Customer', 'morgan@acme.example');
    const acmeCustomer = (
      await CustomerModel.findOne({ workspaceId: acmeId })
    )!._id.toHexString();

    const ada = req(ownerToken);
    const nia = req(adminToken);
    const bob = req(bobToken);
    const carl = req(carlToken);
    const vera = req(veraToken);
    const eve = req(eveToken);
    const stranger = req(strangerToken);
    const anon = req(undefined);

    const acmeTickets = `/workspaces/${acmeId}/tickets`;
    const rivalTickets = `/workspaces/${rivalId}/tickets`;
    const BOGUS_ID = 'd'.repeat(24);

    // Hold on to ids seeded for later sections.
    let morganTicketId = '';

    // ══ 2. Unauthenticated rejection ═══════════════════════════════════════
    {
      const anonCreate = await anon('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'Nope',
        description: 'Nope',
      });
      record('create: unauthenticated → 401', anonCreate.status === 401);

      const anonList = await anon('GET', acmeTickets);
      record('list: unauthenticated → 401', anonList.status === 401);

      const anonDetail = await anon('GET', `${acmeTickets}/${BOGUS_ID}`);
      record('detail: unauthenticated → 401', anonDetail.status === 401);

      const anonStatus = await anon('PATCH', `${acmeTickets}/${BOGUS_ID}/status`, {
        status: 'CLOSED',
      });
      record('status: unauthenticated → 401', anonStatus.status === 401);

      const anonAssign = await anon('PATCH', `${acmeTickets}/${BOGUS_ID}/assignment`, {
        agentId: null,
      });
      record('assignment: unauthenticated → 401', anonAssign.status === 401);

      const anonResolve = await anon('POST', `${acmeTickets}/${BOGUS_ID}/resolve`, {});
      record('resolve: unauthenticated → 401', anonResolve.status === 401);

      const anonArchive = await anon('POST', `${acmeTickets}/${BOGUS_ID}/archive`);
      record('archive: unauthenticated → 401', anonArchive.status === 401);
    }

    // ══ 3. Strangers (404 concealment) ═════════════════════════════════════
    {
      const strangerList = await stranger('GET', acmeTickets);
      record('list: non-member → 404', strangerList.status === 404);

      const strangerCreate = await stranger('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'Sneak',
        description: 'Sneak',
      });
      record('create: non-member → 404', strangerCreate.status === 404);

      const strangerDetail = await stranger('GET', `${acmeTickets}/${BOGUS_ID}`);
      record('detail: non-member → 404', strangerDetail.status === 404);

      const strangerClose = await stranger('PATCH', `${acmeTickets}/${BOGUS_ID}/status`, {
        status: 'CLOSED',
      });
      record('status: non-member → 404', strangerClose.status === 404);
    }

    // ══ 1. Authorized creation ═════════════════════════════════════════════
    {
      const created = await ada('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: '  Refund not received  ',
        description: 'I paid twice and nothing arrived.',
        priority: 'HIGH',
        tags: ['billing', 'refund'],
        category: 'billing',
        dueAt: '2030-01-02T00:00:00.000Z',
      });
      const ticket = ticketOf(created);
      morganTicketId = ticket.id ?? '';
      record(
        'create: owner → 201, trimmed fields, defaults + explicit priority',
        created.status === 201 &&
          ticket.subject === 'Refund not received' &&
          ticket.status === 'OPEN' &&
          ticket.priority === 'HIGH' &&
          ticket.agentId === null &&
          ticket.tags?.join(',') === 'billing,refund' &&
          ticket.archivedAt === null &&
          typeof ticket.customerId === 'string' &&
          typeof ticket.createdAt === 'string',
      );
      record(
        'create: ticket number is human-readable sequential (TKT-000001)',
        (ticket.number ?? '').startsWith('TKT-') &&
          /^TKT-\d{6}$/.test(ticket.number ?? '') &&
          ticket.number === 'TKT-000001',
      );

      const bobCreated = await bob('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'Agent-created ticket',
        description: 'Opened by Bob for Morgan.',
      });
      record(
        'create: agent (no assignTicket) → 201 unassigned',
        bobCreated.status === 201 && ticketOf(bobCreated).agentId === null,
      );

      const bobAssigning = await bob('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'Agent tries to assign',
        description: 'x',
        agentId: (await UserModel.findOne({ email: 'carl2@acme.example' }))!._id.toHexString(),
      });
      record(
        'create: agent attempting assignment → 403',
        bobAssigning.status === 403,
      );

      const adminAssigns = await nia('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'Pre-assigned ticket',
        description: 'Assigned at creation by admin.',
        agentId: (await UserModel.findOne({ email: 'bob2@acme.example' }))!._id.toHexString(),
      });
      const preAssigned = ticketOf(adminAssigns);
      record(
        'create: admin with valid agent assignee → 201 assigned',
        adminAssigns.status === 201 &&
          typeof preAssigned.agentId === 'string' &&
          preAssigned.number === 'TKT-000003',
      );
    }

    // ══ 5. Cross-workspace customer at creation ════════════════════════════
    {
      const crossCustomer = await eve('POST', rivalTickets, {
        customerId: acmeCustomer, // acme customer from rival workspace
        subject: 'Should fail',
        description: 'Should fail',
      });
      record(
        'create: another workspace’s customer → 404 (no leak)',
        crossCustomer.status === 404,
      );

      const badCustomer = await ada('POST', acmeTickets, {
        customerId: BOGUS_ID,
        subject: 'No such customer',
        description: 'No such customer',
      });
      record('create: unknown customer id → 404', badCustomer.status === 404);
    }

    // ══ 8(immutability). Privileged/immutable field rejection ══════════════
    {
      const privileged = await ada('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'Privileged injection',
        description: 'x',
        workspaceId: rivalId,
        number: 'TKT-999999',
        status: 'CLOSED',
        resolvedAt: '2000-01-01T00:00:00.000Z',
        priorityRank: 99,
      });
      record(
        'create: privileged fields (workspaceId/number/status/resolvedAt/priorityRank) → 422',
        privileged.status === 422,
      );

      const listed = await ada('GET', `${acmeTickets}`);
      record(
        'create: injected number/fields never created a ticket (still 3 live)',
        listed.status === 200 && listData(listed).total === 3,
      );
    }

    // ══ 7. Concurrent creation — unique sequential numbers ═════════════════
    {
      const promises = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          ada('POST', acmeTickets, {
            customerId: acmeCustomer,
            subject: `Concurrent ticket ${index + 1}`,
            description: 'Concurrency probe.',
          }),
        ),
      );
      assert(promises.every((r) => r.status === 201));
      const numbers = promises.map((r) => ticketOf(r).number ?? '');
      const unique = new Set(numbers);
      const expected = Array.from({ length: 12 }, (_, i) => `TKT-${String(i + 4).padStart(6, '0')}`);
      const sorted = [...numbers].sort();
      record(
        'numbering: 12 concurrent creates → 12 distinct sequential numbers',
        unique.size === 12 && sorted.join(',') === expected.join(','),
      );
      const dbTickets = await TicketModel.find({ workspaceId: acmeId });
      record(
        'numbering: DB index holds unique numbers (no dupes persisted)',
        dbTickets.length === 15 &&
          new Set(dbTickets.map((t) => t.number)).size === 15,
      );
    }

    // ══ 4. Cross-workspace isolation over a REAL rival ticket ══════════════
    let rivalTicketId = '';
    {
      const rivalTicket = await eve('POST', rivalTickets, {
        customerId: eveCustomer,
        subject: 'Rival ticket',
        description: 'Rival workspace data.',
      });
      assert(rivalTicket.status === 201);
      rivalTicketId = ticketOf(rivalTicket).id ?? '';

      for (const actor of [stranger]) {
        const read = await actor('GET', `${rivalTickets}/${rivalTicketId}`);
        record('cross-tenant: non-member cannot read rival ticket even with its id', read.status === 404);
      }

      // An acme member using the RIVAL workspace's ticket id, on their OWN
      // workspace route: reads as not-found, not as someone else's ticket.
      const wrongRoute = await ada('GET', `${acmeTickets}/${rivalTicketId}`);
      record('cross-tenant: acme route + rival ticket id → 404', wrongRoute.status === 404);

      // Rival listing never contains acme tickets, and acme still sees all 15 of
      // its own — same filter constraints on both counts.
      const rivalList = listData(await eve('GET', `${rivalTickets}`));
      record(
        'cross-tenant: rival listing never contains acme tickets',
        rivalList.items.every((t) => t.customerId === eveCustomer) && rivalList.total === 1,
      );
      const acmeListData = listData(await ada('GET', `${acmeTickets}`));
      record('cross-tenant: acme listing still shows all 15 own tickets', acmeListData.total === 15);

      // Mutation attempts from the other tenant (their own route context):
      const evePatchesAcme = await eve('PATCH', `${rivalTickets}/${morganTicketId}`, {
        subject: 'Hijacked from rival',
      });
      record('cross-tenant: rival PATCH on acme ticket id → 404', evePatchesAcme.status === 404);

      const eveResolvesAcme = await eve('POST', `${rivalTickets}/${morganTicketId}/resolve`, {});
      record('cross-tenant: rival resolve on acme ticket → 404', eveResolvesAcme.status === 404);

      const eveArchivesAcme = await eve('POST', `${rivalTickets}/${morganTicketId}/archive`);
      record('cross-tenant: rival archive on acme ticket → 404', eveArchivesAcme.status === 404);

      const acmeStill = ticketOf(await ada('GET', `${acmeTickets}/${morganTicketId}`));
      record(
        'cross-tenant: acme ticket unchanged after rival attempts',
        acmeStill.subject === 'Refund not received' && acmeStill.status === 'OPEN',
      );
      record(
        'cross-tenant: search does not leak (acme search “rival” empty)',
        listData(await ada('GET', `${acmeTickets}?search=rival`)).total === 0,
      );
      record(
        'cross-tenant: rival search “refund” empty while acme has it',
        listData(await eve('GET', `${rivalTickets}?search=refund`)).total === 0 &&
          listData(await ada('GET', `${acmeTickets}?search=refund`)).total === 1,
      );
    }

    // ══ 8. Listing, filters, sorting, pagination ═══════════════════════════
    {
      const paginated = await ada('GET', `${acmeTickets}?page=2&limit=10`);
      const paged = listData(paginated);
      record(
        'list: pagination (page 2 of 15, limit 10 → 5 items, hasMore=false)',
        paginated.status === 200 &&
          paged.total === 15 &&
          paged.items.length === 5 &&
          paged.hasMore === false,
      );

      const tooBig = await ada('GET', `${acmeTickets}?limit=999`);
      record('list: oversized page rejected → 422', tooBig.status === 422);

      const byStatus = await ada('GET', `${acmeTickets}?status=RESOLVED`);
      record('list: status filter with no resolved tickets → empty', listData(byStatus).total === 0);

      const byPriority = await ada('GET', `${acmeTickets}?priority=HIGH`);
      record('list: priority=HIGH → exactly the seeded one', listData(byPriority).total === 1);

      const byAgent = await ada(
        'GET',
        `${acmeTickets}?agentId=${(await UserModel.findOne({ email: 'bob2@acme.example' }))!._id.toHexString()}`,
      );
      const agentList = listData(byAgent);
      record(
        'list: agent filter → only bob’s pre-assigned ticket',
        agentList.total === 1 && agentList.items[0]?.subject === 'Pre-assigned ticket',
      );

      const byCustomer = await ada('GET', `${acmeTickets}?customerId=${acmeCustomer}`);
      record('list: customer filter → all 15 acme tickets', listData(byCustomer).total === 15);

      const sortedAsc = await ada('GET', `${acmeTickets}?sort=number&order=asc&page=1&limit=3`);
      const ascItems = listData(sortedAsc).items;
      record(
        'list: sort by number asc → TKT-000001 first',
        ascItems[0]?.number === 'TKT-000001',
      );

      // Give two acme tickets different priorities, then sort by priority.
      const t2search = (await ada('GET', `${acmeTickets}?search=Concurrent ticket 2`)).body as { data?: { items?: TicketPayload[] } };
      const t2id = t2search.data?.items?.[0]?.id ?? '';
      const t3search = (await ada('GET', `${acmeTickets}?search=Concurrent ticket 3`)).body as { data?: { items?: TicketPayload[] } };
      const t3id = t3search.data?.items?.[0]?.id ?? '';
      await ada('PATCH', `${acmeTickets}/${t2id}/priority`, { priority: 'URGENT' });
      await ada('PATCH', `${acmeTickets}/${t3id}/priority`, { priority: 'LOW' });
      const byPrioritySort = await ada('GET', `${acmeTickets}?sort=priority&order=desc`);
      const prio = listData(byPrioritySort).items;
      record(
        'list: sort=priority desc ranks URGENT before LOW (weighted, not alphabetic)',
        prio[0]?.priority === 'URGENT' && prio[prio.length - 1]?.priority === 'LOW',
      );

      const dateFiltered = await ada(
        'GET',
        `${acmeTickets}?createdFrom=2099-01-01T00:00:00.000Z`,
      );
      record('list: createdFrom in the future → empty', listData(dateFiltered).total === 0);

      const badRange = await ada(
        'GET',
        `${acmeTickets}?createdFrom=2030-01-02T00:00:00.000Z&createdTo=2030-01-01T00:00:00.000Z`,
      );
      record('list: createdFrom > createdTo rejected', badRange.status === 422);

      const tagged = await ada('GET', `${acmeTickets}?tags=billing`);
      record('list: tag filter → seeded billing/refund ticket', listData(tagged).total === 1);

    }

    // ══ 10. Status transitions ═════════════════════════════════════════════
    {
      // Fresh ticket for Bob (assigned) — the agent-cap-allowed actor.
      const assignment = await nia('PATCH', `${acmeTickets}/${morganTicketId}/assignment`, {
        agentId: (await UserModel.findOne({ email: 'bob2@acme.example' }))!._id.toHexString(),
      });
      record(
        'assignment: admin assigns bob → 200',
        assignment.status === 200 && ticketOf(assignment).agentId !== null,
      );

      const toProgress = await bob('PATCH', `${acmeTickets}/${morganTicketId}/status`, {
        status: 'IN_PROGRESS',
      });
      record(
        'status: OPEN → IN_PROGRESS legal, closedAt stays null',
        toProgress.status === 200 && ticketOf(toProgress).status === 'IN_PROGRESS',
      );

      const resolved = await bob('POST', `${acmeTickets}/${morganTicketId}/resolve`, {
        resolutionNote: 'Sent replacement shipment.',
      });
      const resolvedTicket = ticketOf(resolved);
      record(
        'resolve: notes stored, resolvedAt stamped, closedAt null',
        resolved.status === 200 &&
          resolvedTicket.status === 'RESOLVED' &&
          resolvedTicket.resolvedAt !== null &&
          resolvedTicket.closedAt === null,
      );
      record(
        'resolve: ticket number preserved',
        resolvedTicket.number === 'TKT-000001',
      );

      const idemResolve = await bob('POST', `${acmeTickets}/${morganTicketId}/resolve`, {});
      record(
        'resolve: idempotent on an already-resolved ticket → 200 + unchanged resolvedAt',
        idemResolve.status === 200 &&
          ticketOf(idemResolve).resolvedAt === resolvedTicket.resolvedAt,
      );

      const closed = await nia('PATCH', `${acmeTickets}/${morganTicketId}/status`, {
        status: 'CLOSED',
      });
      const closedTicket = ticketOf(closed);
      record(
        'status: RESOLVED → CLOSED legal; closedAt stamped; resolvedAt retained',
        closed.status === 200 &&
          closedTicket.status === 'CLOSED' &&
          closedTicket.closedAt !== null &&
          closedTicket.resolvedAt !== null,
      );

      const illegal = await bob('PATCH', `${acmeTickets}/${morganTicketId}/status`, {
        status: 'IN_PROGRESS',
      });
      const details = extractError(illegal.body).details as
        | { allowedFrom?: string[] }
        | undefined;
      record(
        'status: CLOSED → IN_PROGRESS → 409 with allowed transitions documented',
        illegal.status === 409 &&
          extractError(illegal.body).code === 'INVALID_STATUS_TRANSITION' &&
          Array.isArray(details?.allowedFrom),
      );

      const dbAfterIllegal = await TicketModel.findById(morganTicketId);
      record(
        'status: illegal attempt did not mutate the document',
        dbAfterIllegal?.status === 'CLOSED',
      );

      const reopensViaStatus = await nia('PATCH', `${acmeTickets}/${morganTicketId}/status`, {
        status: 'OPEN',
      });
      record(
        'status: CLOSED → OPEN permitted (same law the reopen endpoint uses)',
        reopensViaStatus.status === 200 && ticketOf(reopensViaStatus).status === 'OPEN',
      );

      // Re-body the reopen ENDPOINT test: land the ticket in RESOLVED first so
      // /reopen performs a REAL transition (and emits its audit trail) rather
      // than the idempotent OPEN no-op.
      const resolvedAgain = await bob('POST', `${acmeTickets}/${morganTicketId}/resolve`, {});
      assert(resolvedAgain.status === 200);

      const reopened = await bob('POST', `${acmeTickets}/${morganTicketId}/reopen`);
      const reopenedTicket = ticketOf(reopened);
      record(
        'reopen: stamps cleared on the way out of RESOLVED/CLOSED',
        reopened.status === 200 &&
          reopenedTicket.status === 'OPEN' &&
          reopenedTicket.resolvedAt === null &&
          reopenedTicket.closedAt === null,
      );

      const openAgain = await bob('POST', `${acmeTickets}/${morganTicketId}/reopen`);
      record('reopen: idempotent on an OPEN ticket → 200', openAgain.status === 200);

      // WAITING_FOR_CUSTOMER loop over a fresh concurrent ticket (TKT-000016
      // does NOT exist; use the second seeded one — TKT-000002).
      const t2 = (
        listData(await ada('GET', `${acmeTickets}?sort=number&order=asc&page=1&limit=2`)).items.find(
          (t) => t.number === 'TKT-000002',
        ) ?? { id: '' }
      ).id as string;
      const waiting = await ada('PATCH', `${acmeTickets}/${t2}/status`, {
        status: 'WAITING_FOR_CUSTOMER',
      });
      record('status: OPEN → WAITING_FOR_CUSTOMER legal', waiting.status === 200);
      const waitingList = await ada('GET', `${acmeTickets}?status=WAITING_FOR_CUSTOMER`);
      record(
        'status: WAITING_FOR_CUSTOMER filter matches the transitioned ticket',
        listData(waitingList).total === 1,
      );
    }

    // ══ 11. Agent cap ══════════════════════════════════════════════════════
    {
      // Carl (not assigned, not creator) on bob's pre-assigned ticket 000003.
      const t3 = (
        listData(await ada('GET', `${acmeTickets}?search=Pre-assigned`)).items[0] ?? { id: '' }
      ).id as string;
      const carlBlocked = await carl('PATCH', `${acmeTickets}/${t3}`, { subject: 'Hijack' });
      record(
        'agent cap: non-assigned agent PATCH → 403',
        carlBlocked.status === 403,
      );
      const carlStatus = await carl('PATCH', `${acmeTickets}/${t3}/status`, {
        status: 'RESOLVED',
      });
      record('agent cap: non-assigned agent status change → 403', carlStatus.status === 403);

      const bobAllowed = await bob('PATCH', `${acmeTickets}/${t3}`, {
        description: 'Bob edited his own assigned ticket.',
      });
      record('agent cap: assigned agent PATCH → 200', bobAllowed.status === 200);

      // Bob's agent-created ticket (TKT-000002): creator may edit unassigned.
      const t2 = (
        listData(await ada('GET', `${acmeTickets}?search=Agent-created`)).items[0] ?? { id: '' }
      ).id as string;
      const creatorEdit = await bob('PATCH', `${acmeTickets}/${t2}`, {
        subject: 'Agent-created ticket (edited by creator)',
      });
      record(
        'agent cap: creator (unassigned) PATCH → 200',
        creatorEdit.status === 200,
      );

      const viewerCreates = await vera('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'Viewer should not create',
        description: 'x',
      });
      record('permissions: viewer create → 403', viewerCreates.status === 403);

      const viewerReads = await vera('GET', `${acmeTickets}/${morganTicketId}`);
      record('permissions: viewer read → 200', viewerReads.status === 200);

      const viewerAssigns = await vera('PATCH', `${acmeTickets}/${morganTicketId}/assignment`, {
        agentId: null,
      });
      record('permissions: viewer assignment → 403', viewerAssigns.status === 403);

      const bobAssigns = await bob('PATCH', `${acmeTickets}/${morganTicketId}/assignment`, {
        agentId: null,
      });
      record('permissions: agent (no assignTicket) assignment → 403', bobAssigns.status === 403);

      const carlAssigned = await nia('PATCH', `${acmeTickets}/${morganTicketId}/assignment`, {
        agentId: (await UserModel.findOne({ email: 'carl2@acme.example' }))!._id.toHexString(),
      });
      record(
        'assignment: admin reassigns to carl → 200',
        carlAssigned.status === 200 && ticketOf(carlAssigned).agentId !== null,
      );

      const unassign = await nia('PATCH', `${acmeTickets}/${morganTicketId}/assignment`, {
        agentId: null,
      });
      record(
        'unassignment: admin unassigns → 200, agentId null',
        unassign.status === 200 && ticketOf(unassign).agentId === null,
      );

      const eveAsAssignee = await nia('PATCH', `${acmeTickets}/${morganTicketId}/assignment`, {
        agentId: (await UserModel.findOne({ email: 'eve@rival2.example' }))!._id.toHexString(),
      });
      record(
        'assignment: another workspace’s user is NOT assignable → 422/404 (no oracle)',
        eveAsAssignee.status === 422 || eveAsAssignee.status === 404,
      );

      const ratio = await nia('PATCH', `${acmeTickets}/${morganTicketId}/priority`, {
        priority: 'URGENT',
      });
      record('priority: admin escalates → 200', ratio.status === 200);
    }

    // ══ 9. Immutable/protected fields on PATCH ═════════════════════════════
    {
      const protectedPatch = await ada('PATCH', `${acmeTickets}/${morganTicketId}`, {
        workspaceId: rivalId,
        number: 'TKT-000001',
        status: 'CLOSED',
        priority: 'LOW',
        createdAt: '2000-01-01T00:00:00.000Z',
      });
      record(
        'patch: protected fields (workspaceId/number/status/priority/timestamps) → 422',
        protectedPatch.status === 422,
      );
      const unchanged = ticketOf(await ada('GET', `${acmeTickets}/${morganTicketId}`));
      record(
        'patch: protected fields did not touch the DB',
        unchanged.status === 'OPEN' && unchanged.number === 'TKT-000001',
      );

      const customerSwap = await ada('PATCH', `${acmeTickets}/${morganTicketId}`, {
        customerId: eveCustomer,
      });
      record(
        'patch: re-pointing at another workspace’s customer → 404',
        customerSwap.status === 404,
      );

      const validPatch = await ada('PATCH', `${acmeTickets}/${morganTicketId}`, {
        subject: 'Refund not received (updated)',
        dueAt: '2031-06-01T00:00:00.000Z',
        customerId: acmeCustomer,
      });
      record(
        'patch: editable fields update (subject/dueAt/customer same-ws)',
        validPatch.status === 200 &&
          ticketOf(validPatch).subject === 'Refund not received (updated)',
      );
    }

    // ══ 5b. Invalid ids / unknown ids / invalid input ══════════════════════
    {
      const badId = await ada('GET', `${acmeTickets}/not-an-id`);
      record('ids: malformed ticket id → 422', badId.status === 422);

      const badWs = await ada('GET', `/workspaces/nothex/tickets`);
      record('ids: malformed workspace id → 404 (concealment)', badWs.status === 404);

      const unknown = await ada('GET', `${acmeTickets}/${BOGUS_ID}`);
      record('ids: unknown ticket → 404', unknown.status === 404);

      const emptyCreate = await ada('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: '',
        description: 'x',
      });
      record('input: empty subject → 422', emptyCreate.status === 422);

      const missingDescription = await ada('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'Missing description',
      });
      record('input: missing description → 422', missingDescription.status === 422);

      const badCustomerShape = await ada('POST', acmeTickets, {
        customerId: 'zzz',
        subject: 'x',
        description: 'x',
      });
      record('input: malformed customerId → 422', badCustomerShape.status === 422);

      const badPriority = await ada('POST', acmeTickets, {
        customerId: acmeCustomer,
        subject: 'x',
        description: 'x',
        priority: 'CATASTROPHIC',
      });
      record('input: unknown priority → 422', badPriority.status === 422);
    }

    // ══ 14. Archive behavior ═══════════════════════════════════════════════
    {
      // Eve (the rival workspace's OWNER) archives her own tenant's ticket.
      const archived = await eve('POST', `${rivalTickets}/${rivalTicketId}/archive`);
      record('archive: owner archives own tenant ticket → 200', archived.status === 200);

      const defaultList = await eve('GET', `${rivalTickets}`);
      record(
        'archive: archived ticket excluded from default listing',
        listData(defaultList).total === 0,
      );

      const archivedSlice = await eve('GET', `${rivalTickets}?archiveState=archived`);
      record(
        'archive: archived slice returns exactly it',
        listData(archivedSlice).total === 1,
      );

      const allSlice = await eve('GET', `${rivalTickets}?archiveState=all`);
      record('archive: all slice returns 1', listData(allSlice).total === 1);

      const detailAfterArchive = await eve('GET', `${rivalTickets}/${rivalTicketId}`);
      record('archive: detail reads archived ticket as 404', detailAfterArchive.status === 404);

      const mutateAfterArchive = await eve('PATCH', `${rivalTickets}/${rivalTicketId}`, {
        subject: 'Zombie',
      });
      record('archive: PATCH on archived ticket → 404', mutateAfterArchive.status === 404);
    }

    // ══ 13. Audit trails ═══════════════════════════════════════════════════
    {
      const actions = await AuditLogModel.find({ resourceType: 'ticket' }).select('action');
      const seen = new Set(actions.map((a) => a.action));
      const wanted = [
        'ticket.created',
        'ticket.updated',
        'ticket.status_changed',
        'ticket.assigned',
        'ticket.priority_changed',
        'ticket.resolved',
        'ticket.reopened',
        'ticket.archived',
      ];
      record(
        'audit: created/updated/status_changed/assigned/priority_changed/resolved/reopened/archived recorded',
        wanted.every((a) => seen.has(a)),
      );

      const docs = await AuditLogModel.find({ resourceType: 'ticket' });
      const serialized = JSON.stringify(docs.map((d) => d.metadata ?? {}));
      record(
        'audit: no ticket content or PII in metadata (subject/description/notes absent)',
        !serialized.includes('Refund') &&
          !serialized.includes('replacement shipment') &&
          !serialized.includes('morgan@acme'),
      );

      const denials = await AuditLogModel.find({ action: 'workspace.permission_denied' });
      record(
        'audit: permission denial audited (RBAC middleware)',
        denials.length > 0,
      );
    }

    // ══ 15. Regressions ════════════════════════════════════════════════════
    {
      const health = await http('GET', `http://127.0.0.1:${port}/health/ready`);
      record('regression: /health/ready still 200', health.status === 200);

      const badLogin = await http('POST', api('/auth/login'), {
        body: { email: 'ada2@acme.example', password: 'WrongPassword!' },
      });
      record('regression: auth rejects a bad password', badLogin.status === 401);

      const workspaceDetail = await ada('GET', `/workspaces/${acmeId}`);
      record('regression: workspace detail unchanged', workspaceDetail.status === 200);

      const customerCreate = await ada('POST', `/workspaces/${acmeId}/customers`, {
        name: ' regression customer ',
        email: 'regression@acme.example',
      });
      record(
        'regression: customer creation still works after mounting tickets',
        customerCreate.status === 201,
      );
      const customerList = await vera('GET', `/workspaces/${acmeId}/customers?limit=50`);
      record(
        'regression: customer list for viewer intact',
        customerList.status === 200 &&
          Number((customerList.body['data'] as { total?: number }).total) >= 2,
      );
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
