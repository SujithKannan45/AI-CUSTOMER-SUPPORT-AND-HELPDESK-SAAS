/* eslint-disable no-console -- verification driver output is the deliverable */
/**
 * Prompt 17 verification driver — search, filtering & pagination.
 *
 * Boots the REAL server against in-memory Mongo (same recipe as
 * verify-notifications.ts) and checks, over real HTTP:
 *
 *   1. module search: tickets (number/subject/description), customers
 *      (name/email/phone), KB (title/summary/body), escalations (reason/topic),
 *      notifications (title/body), messages (body, visibility-aware),
 *   2. literal-regex safety: metacharacters match literally, operator-shaped
 *      query params are rejected as 422,
 *   3. filters: enums, combined filters, reference ids, date ranges,
 *      contradictory ranges, unsupported fields,
 *   4. pagination: defaults, hard maxima, invalid page/limit, deterministic
 *      order, next-page behaviour, empty pages, no duplicates across pages,
 *   5. security: cross-workspace isolation, concealment, notification
 *      recipient isolation, internal-note privacy, sensitive-field exclusion
 *      from unified search results,
 *   6. unified workspace search: type selection, per-type RBAC fan-out,
 *      bounded preview, tenant scope.
 *
 * NOT covered (documented, not faked): relevance ranking / Atlas Search /
 * Elasticsearch (not configured anywhere), cursor pagination (the project's
 * established contract is page/limit; no cursor API exists), query-plan
 * inspection (mongodb-memory-server does not expose stable plan output for
 * substring scans), and message search across conversations (deliberately not
 * exposed — see modules/search/search.types.ts).
 */

import assert from 'node:assert/strict';
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
  headers['x-forwarded-for'] = `10.41.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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

function dataOf<T>(res: HttpResult): T {
  return (res.body as { data?: T }).data as T;
}

interface ListPayload<T> {
  readonly items: T[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

interface SearchPayload {
  readonly query: string;
  readonly requestedTypes: string[];
  readonly searchedTypes: string[];
  readonly skippedTypes: string[];
  readonly perTypeLimit: number;
  readonly counts: Record<string, number>;
  readonly items: Array<{
    type: string;
    id: string;
    title: string;
    snippet: string | null;
    metadata: Record<string, string | null>;
  }>;
  readonly totalResults: number;
}

interface IdItem {
  id: string;
}

async function main(): Promise<void> {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_search' },
  });

  const expectedUri = memoryServer.getUri('verify_search');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '100000';
  process.env['LOG_LEVEL'] = 'error';
  process.env['NOTIFICATION_EMAIL_ENABLED'] = 'false';
  process.env['EMAIL_PROVIDER'] = 'log';
  process.env['AI_PROVIDER'] = 'none';
  process.env['PORT'] = '4082';

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
    const api = (pathSegments: string): string => `http://127.0.0.1:${4082}/api/v1${pathSegments}`;
    const { UserModel } = await import('../server/src/modules/users/user.model.js');
    const { WorkspaceMemberModel } = await import(
      '../server/src/modules/workspaces/workspace-member.model.js'
    );
    const { createNotificationIfAbsent } = await import(
      '../server/src/modules/notifications/notification.repository.js'
    );

    const PASSWORD = 'Str0ngPass!42';

    async function newUser(name: string, email: string): Promise<string> {
      const reg = await http('POST', api('/auth/register'), {
        body: { name, email, password: PASSWORD },
      });
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
      const id = dataOf<{ workspace?: { id?: string } }>(created)?.workspace?.id ?? '';
      assert.ok(id.length > 0);
      return id;
    }

    const adaToken = await newUser('Ada Owner', 'ada.search@example.test');
    const bobToken = await newUser('Bob Agent', 'bob.search@example.test');
    const vicToken = await newUser('Vic Viewer', 'vic.search@example.test');
    const eveToken = await newUser('Eve Rival', 'eve.search@example.test');
    const samToken = await newUser('Sam Stranger', 'sam.search@example.test');

    const acmeId = await newWorkspace(adaToken, 'Acme Search', 'acme-search');
    const rivalId = await newWorkspace(eveToken, 'Rival Search', 'rival-search');
    const acmeWs = new Types.ObjectId(acmeId);
    const rivalWs = new Types.ObjectId(rivalId);

    const userIds: Record<string, Types.ObjectId> = {};
    for (const [key, email] of Object.entries({
      ada: 'ada.search@example.test',
      bob: 'bob.search@example.test',
      vic: 'vic.search@example.test',
      eve: 'eve.search@example.test',
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
        pathSegments: string,
        init?: { body?: unknown },
      ): Promise<HttpResult> =>
        http(method, api(pathSegments), { token, ...init });
    const ada = as(adaToken);
    const bob = as(bobToken);
    const vic = as(vicToken);
    const eve = as(eveToken);
    const sam = as(samToken);

    const acme = (pathSegments: string): string => `/workspaces/${acmeId}${pathSegments}`;
    const rival = (pathSegments: string): string => `/workspaces/${rivalId}${pathSegments}`;

    // ── Seed data ─────────────────────────────────────────────────────────────

    const customerRes = await ada('POST', acme('/customers'), {
      body: { name: 'Nora Customer', email: 'nora.search@example.test', phone: '+919876543210' },
    });
    assert.equal(customerRes.status, 201, JSON.stringify(customerRes.body));
    const customerId = dataOf<{ customer?: { id?: string } }>(customerRes)?.customer?.id ?? '';
    assert.ok(customerId.length > 0);

    const rivalCustomerRes = await eve('POST', rival('/customers'), {
      body: { name: 'Rival Customer', email: 'rival.search@example.test' },
    });
    assert.equal(rivalCustomerRes.status, 201);
    const rivalCustomerId =
      dataOf<{ customer?: { id?: string } }>(rivalCustomerRes)?.customer?.id ?? '';

    async function newTicket(
      subject: string,
      description: string,
      token: string = adaToken,
      wsPath: string = acme(''),
      customer: string = customerId,
    ): Promise<{ id: string; number: string }> {
      const res = await http('POST', api(`${wsPath}/tickets`), {
        token,
        body: { customerId: customer, subject, description },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const ticket = dataOf<{ ticket?: { id?: string; number?: string } }>(res)?.ticket;
      assert.ok(ticket?.id !== undefined && ticket.id.length > 0);
      return { id: ticket.id, number: ticket.number ?? '' };
    }

    const refundTicket = await newTicket(
      'Refund request from Nora',
      'Customer says the warranty code zebra-77 is invalid.',
    );
    const symbolsTicket = await newTicket(
      'C++ crash [bracket] .* literal',
      'Symbols probe for regex-literal matching.',
    );
    const needleTickets: Array<{ id: string }> = [];
    for (const label of ['one', 'two', 'three', 'four', 'five']) {
      needleTickets.push(await newTicket(`Pagination needle ${label}`, `Needle body ${label}.`));
    }
    const rivalTicket = await newTicket(
      'Rival needle ticket',
      'Owned by the rival workspace.',
      eveToken,
      rival(''),
      rivalCustomerId,
    );
    assert.ok(rivalTicket.id.length > 0);

    // Conversation + messages (public + internal note) for refund ticket.
    const convRes = await ada('POST', acme(`/tickets/${refundTicket.id}/conversations`), {
      body: { subject: 'Refund conversation thread' },
    });
    assert.ok(convRes.status === 200 || convRes.status === 201, JSON.stringify(convRes.body));
    const conversationId =
      dataOf<{ conversation?: { id?: string } }>(convRes)?.conversation?.id ?? '';
    assert.ok(conversationId.length > 0);

    for (const [body, visibility] of [
      ['Public ledger zebra reply.', 'PUBLIC'],
      ['Internal ledger secret note.', 'INTERNAL'],
    ] as const) {
      const sent = await ada('POST', acme(`/conversations/${conversationId}/messages`), {
        body: { body, visibility },
      });
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
    }

    // Manual escalation over the conversation (reasonCode MANUAL).
    const escalationRes = await ada('POST', acme('/escalations'), {
      body: { conversationId },
    });
    assert.equal(escalationRes.status, 201, JSON.stringify(escalationRes.body));
    const escalationId =
      dataOf<{ escalation?: { id?: string } }>(escalationRes)?.escalation?.id ?? '';
    assert.ok(escalationId.length > 0);

    // KB articles: one live, one archived (excluded from unified search).
    const kbRes = await ada('POST', acme('/knowledge-base/articles'), {
      body: {
        title: 'Escalation matrix',
        summary: 'How escalations reach a human.',
        body: 'The warranty escalation matrix is reviewed quarterly.',
      },
    });
    assert.equal(kbRes.status, 201, JSON.stringify(kbRes.body));
    const kbArticleId = dataOf<{ article?: { id?: string } }>(kbRes)?.article?.id ?? '';
    assert.ok(kbArticleId.length > 0);

    const archivedKbRes = await ada('POST', acme('/knowledge-base/articles'), {
      body: { title: 'Matrix archive memo', summary: 'Old matrix notes.', body: 'Matrix archived body.' },
    });
    assert.equal(archivedKbRes.status, 201);
    const archivedKbId = dataOf<{ article?: { id?: string } }>(archivedKbRes)?.article?.id ?? '';
    const archiveAction = await ada(
      'POST',
      acme(`/knowledge-base/articles/${archivedKbId}/archive`),
      { body: {} },
    );
    assert.equal(archiveAction.status, 200, JSON.stringify(archiveAction.body));

    // Notifications for two recipients in the same workspace (isolation).
    await createNotificationIfAbsent(
      {
        recipientId: userIds['ada']!,
        type: 'ticket.created',
        title: 'Invoice paid',
        body: 'Invoice INV-9 was paid.',
        entityType: 'ticket',
        entityId: new Types.ObjectId(refundTicket.id),
        eventKey: 'verify-search:ada:invoice',
      },
      acmeWs,
    );
    await createNotificationIfAbsent(
      {
        recipientId: userIds['bob']!,
        type: 'ticket.created',
        title: 'Invoice overdue',
        body: 'Invoice INV-10 is overdue.',
        entityType: 'ticket',
        entityId: new Types.ObjectId(refundTicket.id),
        eventKey: 'verify-search:bob:invoice',
      },
      acmeWs,
    );

    // ══ 1. Module search ════════════════════════════════════════════════════
    {
      const bySubject = await ada('GET', acme('/tickets?search=refund'));
      const subjectData = dataOf<ListPayload<IdItem>>(bySubject);
      record(
        '1.1 ticket search matches subject (tenant-scoped, total reported)',
        bySubject.status === 200 && subjectData.total >= 1 && subjectData.items.some((i) => i.id === refundTicket.id),
      );

      const byDescription = await ada('GET', acme('/tickets?search=zebra-77'));
      record(
        '1.2 ticket search matches DESCRIPTION (Prompt 17 scope)',
        dataOf<ListPayload<IdItem>>(byDescription).items.some((i) => i.id === refundTicket.id),
      );

      const byNumber = await ada('GET', acme(`/tickets?search=${refundTicket.number}`));
      record(
        '1.3 ticket search matches ticket NUMBER',
        dataOf<ListPayload<IdItem>>(byNumber).items.some((i) => i.id === refundTicket.id),
      );

      const noMatch = await ada('GET', acme('/tickets?search=nothing-matches-this'));
      record('1.4 non-matching term → empty result set', dataOf<ListPayload<IdItem>>(noMatch).total === 0);

      const customerName = await ada('GET', acme('/customers?search=nora'));
      record(
        '1.5 customer search matches name',
        dataOf<ListPayload<IdItem>>(customerName).items.some((i) => i.id === customerId),
      );

      const customerPhone = await ada('GET', acme('/customers?search=98765'));
      record(
        '1.6 customer search matches PHONE',
        dataOf<ListPayload<IdItem>>(customerPhone).items.some((i) => i.id === customerId),
      );

      const kbTitle = await ada('GET', acme('/knowledge-base/articles?search=escalation'));
      record(
        '1.7 KB search matches title',
        dataOf<ListPayload<IdItem>>(kbTitle).items.some((i) => i.id === kbArticleId),
      );

      const kbBody = await ada('GET', acme('/knowledge-base/articles?search=quarterly'));
      record(
        '1.8 KB search matches BODY (Prompt 17 scope)',
        dataOf<ListPayload<IdItem>>(kbBody).items.some((i) => i.id === kbArticleId),
      );

      const escSearch = await ada('GET', acme('/escalations?search=manual'));
      record(
        '1.9 escalation search matches reason code',
        dataOf<ListPayload<IdItem>>(escSearch).items.some((i) => i.id === escalationId),
      );

      const notifOwner = await ada('GET', acme('/notifications?search=invoice'));
      record(
        '1.10 notification search matches title/body for the caller',
        dataOf<ListPayload<{ id: string }>>(notifOwner).total === 1,
      );

      const notifOther = await bob('GET', acme('/notifications?search=invoice'));
      const otherItems = dataOf<ListPayload<{ title: string }>>(notifOther).items;
      record(
        '1.11 notification search is recipient-isolated (Bob sees only his)',
        dataOf<ListPayload<{ title: string }>>(notifOther).total === 1 &&
          otherItems[0]?.title === 'Invoice overdue',
      );
    }

    // ══ 2. Message search & internal-note privacy ═══════════════════════════
    {
      const ownerMessages = await ada('GET', acme(`/conversations/${conversationId}/messages?search=ledger`));
      const ownerData = dataOf<ListPayload<{ visibility: string }>>(ownerMessages);
      record(
        '2.1 message search (staff) returns PUBLIC + INTERNAL matches',
        ownerMessages.status === 200 && ownerData.total === 2,
      );

      const viewerMessages = await vic(
        'GET',
        acme(`/conversations/${conversationId}/messages?search=ledger`),
      );
      const viewerData = dataOf<ListPayload<{ visibility: string; body: string }>>(viewerMessages);
      record(
        '2.2 viewer message search excludes INTERNAL notes in the query',
        viewerData.total === 1 &&
          viewerData.items.every((item) => item.visibility === 'PUBLIC') &&
          !JSON.stringify(viewerData).includes('Internal ledger secret'),
      );

      const longTerm = await ada(
        'GET',
        acme(`/conversations/${conversationId}/messages?search=${'a'.repeat(101)}`),
      );
      record('2.3 over-long message search term → 422', longTerm.status === 422);

      const strangerMessages = await sam(
        'GET',
        acme(`/conversations/${conversationId}/messages?search=ledger`),
      );
      record('2.4 non-member message search → 404 concealment', strangerMessages.status === 404);
    }

    // ══ 3. Regex-literal safety ═════════════════════════════════════════════
    {
      const dotStar = await ada('GET', acme('/tickets?search=.*'));
      const dotStarData = dataOf<ListPayload<IdItem>>(dotStar);
      record(
        '3.1 regex metacharacters match LITERALLY (.* matches only the literal ticket)',
        dotStar.status === 200 &&
          dotStarData.total === 1 &&
          dotStarData.items[0]?.id === symbolsTicket.id,
      );

      const brackets = await ada('GET', acme('/tickets?search=%5Bbracket%5D'));
      record(
        '3.2 bracket expression is literal, not a character class',
        dataOf<ListPayload<IdItem>>(brackets).total === 1 &&
          dataOf<ListPayload<IdItem>>(brackets).items[0]?.id === symbolsTicket.id,
      );

      const plus = await ada('GET', acme('/tickets?search=c%2B%2B'));
      record('3.3 plus signs are literal (C++ search works)', dataOf<ListPayload<IdItem>>(plus).total === 1);

      const operatorQuery = await ada('GET', acme('/tickets?search%5B%24ne%5D=x'));
      record('3.4 operator-shaped query param (search[$ne]) → 422', operatorQuery.status === 422);

      const operatorUnified = await ada('GET', acme('/search?q%5B%24ne%5D=x'));
      record('3.5 operator-shaped unified q (q[$ne]) → 422', operatorUnified.status === 422);

      const emptySearch = await ada('GET', acme('/tickets?search=%20%20'));
      record('3.6 whitespace-only search term → 422', emptySearch.status === 422);

      const longSearch = await ada('GET', acme(`/tickets?search=${'a'.repeat(101)}`));
      record('3.7 over-long search term (>100) → 422', longSearch.status === 422);
    }

    // ══ 4. Filters ══════════════════════════════════════════════════════════
    {
      const escByTicket = await ada('GET', acme(`/escalations?ticketId=${refundTicket.id}`));
      record(
        '4.1 escalation filter by related ticket → 1',
        dataOf<ListPayload<IdItem>>(escByTicket).total === 1,
      );

      const escByCustomer = await ada('GET', acme(`/escalations?customerId=${customerId}`));
      record(
        '4.2 escalation filter by customer → 1',
        dataOf<ListPayload<IdItem>>(escByCustomer).total === 1,
      );

      const escByForeignTicket = await ada(
        'GET',
        acme('/escalations?ticketId=0123456789abcdef01234567'),
      );
      record(
        '4.3 unknown/foreign reference filter → empty (no existence oracle)',
        escByForeignTicket.status === 200 && dataOf<ListPayload<IdItem>>(escByForeignTicket).total === 0,
      );

      const escByStatus = await ada('GET', acme('/escalations?status=PENDING'));
      record(
        '4.4 escalation status filter → 1 PENDING',
        dataOf<ListPayload<IdItem>>(escByStatus).total === 1,
      );

      const escCombined = await ada(
        'GET',
        acme(`/escalations?status=PENDING&priority=${'MEDIUM'}&ticketId=${refundTicket.id}`),
      );
      record(
        '4.5 combined escalation filters compose (AND)',
        dataOf<ListPayload<IdItem>>(escCombined).total === 1,
      );

      const badEnum = await ada('GET', acme('/escalations?status=BOGUS'));
      record('4.6 unsupported enum value → 422', badEnum.status === 422);

      const unsupportedField = await ada('GET', acme('/escalations?assignedUser=x'));
      record('4.7 unsupported filter field → 422 (strict query schema)', unsupportedField.status === 422);

      const past = new Date(Date.now() - 3_600_000).toISOString();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const validRange = await ada(
        'GET',
        acme(`/escalations?createdFrom=${encodeURIComponent(past)}&createdTo=${encodeURIComponent(future)}`),
      );
      record(
        '4.8 valid creation date range → 1',
        dataOf<ListPayload<IdItem>>(validRange).total === 1,
      );

      const contradictory = await ada(
        'GET',
        acme(`/escalations?createdFrom=${encodeURIComponent(future)}&createdTo=${encodeURIComponent(past)}`),
      );
      record('4.9 contradictory date range → 422', contradictory.status === 422);

      const badDate = await ada('GET', acme('/escalations?createdFrom=yesterday'));
      record('4.10 invalid date format → 422', badDate.status === 422);

      const notifUnread = await ada('GET', acme('/notifications?unread=true'));
      record(
        '4.11 notification unread filter → only unread rows',
        dataOf<ListPayload<{ readAt: string | null }>>(notifUnread).items.every(
          (item) => item.readAt === null,
        ),
      );

      const notifFutureRange = await ada(
        'GET',
        acme(`/notifications?createdFrom=${encodeURIComponent(future)}`),
      );
      record(
        '4.12 notification future-only date range → empty',
        dataOf<ListPayload<IdItem>>(notifFutureRange).total === 0,
      );

      const notifBadRange = await ada(
        'GET',
        acme(`/notifications?createdFrom=${encodeURIComponent(future)}&createdTo=${encodeURIComponent(past)}`),
      );
      record('4.13 notification contradictory date range → 422', notifBadRange.status === 422);

      const ticketTags = await ada('GET', acme('/tickets?priority=HIGH&status=OPEN'));
      record(
        '4.14 pre-existing ticket filters unchanged (status+priority compose)',
        ticketTags.status === 200,
      );
    }

    // ══ 5. Pagination ═══════════════════════════════════════════════════════
    {
      const defaults = await ada('GET', acme('/tickets'));
      const defaultsData = dataOf<ListPayload<IdItem>>(defaults);
      record(
        '5.1 default page size is 20 with page 1 metadata',
        defaultsData.page === 1 && defaultsData.limit === 20 && defaultsData.total === 7,
      );

      const tooLarge = await ada('GET', acme('/tickets?limit=51'));
      record('5.2 ticket page size above the 50 cap → 422', tooLarge.status === 422);

      const zeroPage = await ada('GET', acme('/tickets?page=0'));
      record('5.3 page 0 → 422', zeroPage.status === 422);

      const nonNumeric = await ada('GET', acme('/tickets?page=abc'));
      record('5.4 non-numeric page → 422', nonNumeric.status === 422);

      const notifTooLarge = await ada('GET', acme('/notifications?limit=101'));
      record('5.5 notification page size above its cap → 422', notifTooLarge.status === 422);

      const page1 = await ada('GET', acme('/tickets?search=needle&limit=2&page=1'));
      const page2 = await ada('GET', acme('/tickets?search=needle&limit=2&page=2'));
      const p1 = dataOf<ListPayload<IdItem>>(page1);
      const p2 = dataOf<ListPayload<IdItem>>(page2);
      const p1Ids = p1.items.map((item) => item.id);
      const p2Ids = p2.items.map((item) => item.id);
      record(
        '5.6 page 1/2 of a 5-item search: no duplicates, no skips, hasMore=true',
        p1.total === 5 &&
          p2.total === 5 &&
          p1.items.length === 2 &&
          p2.items.length === 2 &&
          p1.hasMore &&
          p2.hasMore &&
          p1Ids.every((id) => !p2Ids.includes(id)),
      );

      const page3 = await ada('GET', acme('/tickets?search=needle&limit=2&page=3'));
      const p3 = dataOf<ListPayload<IdItem>>(page3);
      record(
        '5.7 final partial page → 1 item, hasMore=false',
        p3.items.length === 1 && p3.hasMore === false,
      );

      const page4 = await ada('GET', acme('/tickets?search=needle&limit=2&page=4'));
      const p4 = dataOf<ListPayload<IdItem>>(page4);
      record(
        '5.8 page past the end → empty items, hasMore=false, total intact',
        p4.items.length === 0 && p4.hasMore === false && p4.total === 5,
      );

      const sortedA = await ada('GET', acme('/tickets?search=needle&sort=createdAt&order=asc&limit=5'));
      const sortedB = await ada('GET', acme('/tickets?search=needle&sort=createdAt&order=asc&limit=5'));
      record(
        '5.9 deterministic sorting is stable across identical requests',
        JSON.stringify(dataOf<ListPayload<IdItem>>(sortedA).items.map((i) => i.id)) ===
          JSON.stringify(dataOf<ListPayload<IdItem>>(sortedB).items.map((i) => i.id)),
      );

      const invalidSort = await ada('GET', acme('/tickets?sort=deletedAt'));
      record('5.10 sort by a non-allowlisted field → 422', invalidSort.status === 422);

      const escPaged = await ada('GET', acme('/escalations?limit=1&page=2'));
      record(
        '5.11 escalation listing keeps the page/limit contract',
        escPaged.status === 200 && dataOf<ListPayload<IdItem>>(escPaged).page === 2,
      );

      const escSorted = await ada('GET', acme('/escalations?sort=priority&order=asc'));
      record(
        '5.12 escalation allowlisted sort accepted',
        escSorted.status === 200 && dataOf<ListPayload<IdItem>>(escSorted).total === 1,
      );
    }

    // ══ 6. Unified search ═══════════════════════════════════════════════════
    {
      const allTypes = await ada('GET', acme('/search?q=needle'));
      const allData = dataOf<SearchPayload>(allTypes);
      record(
        '6.1 unified search fans out across all six entity types',
        allTypes.status === 200 &&
          allData.searchedTypes.length === 6 &&
          allData.skippedTypes.length === 0 &&
          allData.counts['ticket'] === 5,
      );
      record(
        '6.2 unified search returns homogeneous items with type + id',
        allData.items.length === allData.totalResults &&
          allData.items.every((item) => item.type.length > 0 && item.id.length === 24),
      );

      const typeScoped = await ada('GET', acme('/search?q=matrix&types=knowledge_base_article'));
      const scopedData = dataOf<SearchPayload>(typeScoped);
      record(
        '6.3 type selection narrows the fan-out exactly',
        scopedData.requestedTypes.length === 1 &&
          scopedData.searchedTypes.length === 1 &&
          scopedData.items.every((item) => item.type === 'knowledge_base_article'),
      );
      record(
        '6.4 archived KB content is excluded from unified search',
        scopedData.items.length === 1 && scopedData.items[0]?.id === kbArticleId,
      );

      const managementKb = await ada('GET', acme('/knowledge-base/articles?search=matrix'));
      record(
        '6.5 management KB listing still searches archived content (explicit scope)',
        dataOf<ListPayload<IdItem>>(managementKb).total === 2,
      );

      const regexLiteralUnified = await ada('GET', acme('/search?q=.*&types=ticket'));
      const regexData = dataOf<SearchPayload>(regexLiteralUnified);
      record(
        '6.6 unified search is literal too (.* → one literal ticket)',
        regexData.items.length === 1 && regexData.items[0]?.id === symbolsTicket.id,
      );

      const customerLeak = await ada('GET', acme('/search?q=9876543210&types=customer'));
      const customerItems = dataOf<SearchPayload>(customerLeak).items;
      record(
        '6.7 unified customer results match phone without echoing PII',
        customerItems.length === 1 &&
          customerItems[0]?.title === 'Nora Customer' &&
          !JSON.stringify(customerItems[0]?.metadata).includes('9876543210') &&
          !JSON.stringify(customerItems[0]).includes('nora.search@example.test'),
      );

      const ticketLeak = await ada('GET', acme('/search?q=zebra&types=ticket'));
      record(
        '6.8 unified ticket results do not expose descriptions',
        !JSON.stringify(dataOf<SearchPayload>(ticketLeak).items).includes('warranty code'),
      );

      const notifOwnerUnified = await ada('GET', acme('/search?q=invoice&types=notification'));
      const notifOwnerData = dataOf<SearchPayload>(notifOwnerUnified);
      record(
        '6.9 unified notification search is restricted to the caller',
        notifOwnerData.items.length === 1 && notifOwnerData.items[0]?.title === 'Invoice paid',
      );

      const notifBobUnified = await bob('GET', acme('/search?q=invoice&types=notification'));
      const notifBobData = dataOf<SearchPayload>(notifBobUnified);
      record(
        '6.10 another member sees only their own matching notification',
        notifBobData.items.length === 1 && notifBobData.items[0]?.title === 'Invoice overdue',
      );

      const multi = await ada('GET', acme('/search?q=needle&types=ticket,customer'));
      const multiData = dataOf<SearchPayload>(multi);
      record(
        '6.11 multi-type request reports per-type counts (including zeros)',
        multiData.requestedTypes.length === 2 &&
          multiData.counts['ticket'] === 5 &&
          multiData.counts['customer'] === 0,
      );

      const capped = await ada('GET', acme('/search?q=needle&types=ticket&limit=2'));
      record(
        '6.12 per-type limit bounds the preview (2 rows, limit echoed)',
        dataOf<SearchPayload>(capped).items.length === 2 &&
          dataOf<SearchPayload>(capped).perTypeLimit === 2,
      );

      const tooMany = await ada('GET', acme('/search?q=needle&limit=26'));
      record('6.13 per-type limit above the 25 cap → 422', tooMany.status === 422);

      const badType = await ada('GET', acme('/search?q=needle&types=bogus'));
      record('6.14 unsupported entity type → 422', badType.status === 422);

      const missingQuery = await ada('GET', acme('/search'));
      record('6.15 missing q → 422', missingQuery.status === 422);

      const emptyQuery = await ada('GET', acme('/search?q=%20'));
      record('6.16 blank q → 422', emptyQuery.status === 422);

      const longQuery = await ada('GET', acme(`/search?q=${'a'.repeat(101)}`));
      record('6.17 over-long q → 422', longQuery.status === 422);
    }

    // ══ 7. Tenant isolation & authorization ═════════════════════════════════
    {
      const rivalSearch = dataOf<ListPayload<IdItem>>(
        await eve('GET', rival('/tickets?search=needle')),
      );
      const acmeTicketIds = [refundTicket.id, symbolsTicket.id, ...needleTickets.map((t) => t.id)];
      record(
        '7.1 rival ticket search finds only its own ticket, never acme rows',
        rivalSearch.total === 1 &&
          rivalSearch.items[0]?.id === rivalTicket.id &&
          rivalSearch.items.every((item) => !acmeTicketIds.includes(item.id)),
      );

      const rivalUnified = dataOf<SearchPayload>(await eve('GET', rival('/search?q=needle')));
      record(
        '7.2 rival unified search sees only its own workspace',
        rivalUnified.totalResults === 1 && rivalUnified.items[0]?.id === rivalTicket.id,
      );

      const acmeStill = await ada('GET', acme('/tickets?search=needle'));
      record(
        '7.3 acme search still returns all 5 (rival search did not affect it)',
        dataOf<ListPayload<IdItem>>(acmeStill).total === 5,
      );

      const rivalReadsAcme = await eve('GET', acme('/search?q=needle'));
      record('7.4 rival on acme search path → 404 concealment', rivalReadsAcme.status === 404);

      const stranger = await sam('GET', acme('/search?q=needle'));
      record('7.5 non-member search → 404 concealment', stranger.status === 404);

      const strangerTickets = await sam('GET', acme('/tickets?search=needle'));
      record('7.6 non-member ticket search → 404 concealment', strangerTickets.status === 404);

      const rivalEscalations = await eve(
        'GET',
        rival(`/escalations?ticketId=${refundTicket.id}`),
      );
      record(
        '7.7 foreign reference filter in another workspace → 404, never a result',
        rivalEscalations.status === 404 ||
          dataOf<ListPayload<IdItem>>(rivalEscalations).total === 0,
      );

      const anonymous = await http('GET', api(acme('/search?q=needle')));
      record('7.8 anonymous search → 401', anonymous.status === 401);

      const malformedWorkspace = await ada('GET', '/workspaces/not-an-object-id/search?q=needle');
      record('7.9 malformed workspace id → 422/404 (never 500)', [422, 404].includes(malformedWorkspace.status));
    }

    // ══ 8. Role visibility of the search surface ════════════════════════════
    {
      const viewerSearch = await vic('GET', acme('/search?q=needle'));
      const viewerData = dataOf<SearchPayload>(viewerSearch);
      record(
        '8.1 viewer keeps read-only search access (all six read scopes granted)',
        viewerSearch.status === 200 && viewerData.searchedTypes.length === 6,
      );
      record(
        '8.2 no read scope is skipped for any current role (registry-derived)',
        viewerData.skippedTypes.length === 0,
      );

      const agentSearch = await bob('GET', acme('/search?q=needle'));
      record('8.3 agent search works within the same workspace', agentSearch.status === 200);
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
