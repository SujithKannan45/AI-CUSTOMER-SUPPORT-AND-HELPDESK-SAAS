/* eslint-disable no-console -- verification driver output is the deliverable */
/**
 * Prompt 16 verification driver — notifications & email.
 *
 * Boots the REAL server against in-memory Mongo (same recipe as
 * verify-escalations.ts) and exercises the whole notification stack:
 *
 *   1. pure policy: preference channels, template escaping, event keys,
 *   2. ticket events → in-app notifications (assignment / status / priority /
 *      creation fan-out) with actor suppression,
 *   3. inbox isolation, pagination, unread count and the read lifecycle,
 *   4. preferences (defaults, partial patch, validation, respect at dispatch,
 *      audit trail) — including cross-user isolation,
 *   5. conversation events: PUBLIC replies notify, INTERNAL notes never do,
 *   6. escalation events (manual + AI handoff + AI failure) and lifecycle,
 *   7. email rendering/escaping through the log provider outbox,
 *   8. email failure handling: notification still persists, RETRY_PENDING,
 *      backoff sweep recovery, permanent failure, attempt exhaustion, invalid
 *      recipient (no network calls),
 *   9. duplicate/idempotent dispatch (same event emitted twice),
 *  10. socket publication seam: failure never breaks the REST operation and
 *      the publisher only sees persisted notifications.
 *
 * NOT covered (documented, not faked): live Socket.IO delivery (the socket
 * server does not exist yet), real SMTP delivery (requires credentials; the
 * adapter is exercised only up to its pre-network validation), and durable
 * queue retries (no Redis/BullMQ in this deployment).
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
  headers['x-forwarded-for'] = `10.31.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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
function errorCodeOf(res: HttpResult): string | undefined {
  const error = res.body['error'] as { code?: string } | undefined;
  return error?.code;
}

/** Typed escape hatch for lean-returned ids (same pattern as the other drivers). */
const oid = (value: unknown): Types.ObjectId => value as Types.ObjectId;

interface NotificationDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly readAt: string | null;
  readonly createdAt: string;
}

interface Inbox {
  readonly items: NotificationDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

async function main(): Promise<void> {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_notifications' },
  });

  const expectedUri = memoryServer.getUri('verify_notifications');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '100000';
  process.env['LOG_LEVEL'] = 'error';
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'verify-notifications-storage-'));
  mkdirSync(storageRoot, { recursive: true });
  process.env['STORAGE_DATA_DIR'] = storageRoot;

  // Email policy for THIS driver: the dev outbox provider, three attempts and
  // a tiny backoff so the retry sweep is deterministic (no sleeping seconds).
  process.env['EMAIL_PROVIDER'] = 'log';
  process.env['NOTIFICATION_EMAIL_ENABLED'] = 'true';
  process.env['NOTIFICATION_EMAIL_MAX_ATTEMPTS'] = '3';
  process.env['NOTIFICATION_EMAIL_RETRY_BASE_MS'] = '5';
  process.env['NOTIFICATION_MAX_RECIPIENTS'] = '10';
  // Escalation triggers used by section 6.
  process.env['ESCALATION_ON_ABSTENTION'] = 'true';
  process.env['ESCALATION_ON_TECHNICAL_FAILURE'] = 'true';
  process.env['ESCALATION_ON_HUMAN_REQUEST'] = 'false';
  process.env['ESCALATION_ON_SENSITIVE_TOPIC'] = 'false';
  process.env['ESCALATION_REPEATED_FAILURE_THRESHOLD'] = '9';

  const port = 4081;
  process.env['PORT'] = String(port);

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

  const { awaitNotificationDispatchIdle } = await import(
    '../server/src/modules/notifications/notification.dispatcher.js'
  );

  try {
    const api = (pathSegments: string): string => `http://127.0.0.1:${port}/api/v1${pathSegments}`;
    const { UserModel } = await import('../server/src/modules/users/user.model.js');
    const { WorkspaceMemberModel } = await import(
      '../server/src/modules/workspaces/workspace-member.model.js'
    );
    const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
    const { NotificationModel } = await import(
      '../server/src/modules/notifications/notification.model.js'
    );
    const { listEmailDeliveriesForRecipient, createEmailDeliveryIfAbsent } = await import(
      '../server/src/modules/notifications/email/email-delivery.repository.js'
    );
    const { attemptEmailDelivery, sweepEmailDeliveries, deliverNotificationEmail } = await import(
      '../server/src/modules/notifications/email/email-delivery.service.js'
    );
    const { logEmailProvider } = await import(
      '../server/src/modules/notifications/email/log-email.provider.js'
    );
    const { setEmailProvider } = await import(
      '../server/src/modules/notifications/email/email.factory.js'
    );
    const { EmailProviderError } = await import(
      '../server/src/modules/notifications/email/email.types.js'
    );
    const { setNotificationPublisher } = await import(
      '../server/src/modules/notifications/notification.publisher.js'
    );
    const { ticketEventBus } = await import('../server/src/modules/tickets/ticket.events.js');
    const { noteAgentInteraction } = await import(
      '../server/src/modules/escalations/escalation.service.js'
    );
    const { createTicketRecord } = await import('../server/src/modules/tickets/ticket.repository.js');
    const { createConversation } = await import(
      '../server/src/modules/conversations/conversation.repository.js'
    );

    const PASSWORD = 'Str0ngPass!42';

    async function newUser(name: string, email: string): Promise<string> {
      const reg = await http('POST', api('/auth/register'), { body: { name, email, password: PASSWORD } });
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

    const adaToken = await newUser('Ada Owner', 'ada.note@example.test');
    const bobToken = await newUser('Bob Desk', 'bob.note@example.test');
    const danToken = await newUser('Dan Desk', 'dan.note@example.test');
    const vicToken = await newUser('Vic Viewer', 'vic.note@example.test');
    const fayToken = await newUser('Fay Prefs', 'fay.note@example.test');
    const eveToken = await newUser('Eve Rival', 'eve.note@example.test');

    const acmeId = await newWorkspace(adaToken, 'Acme Notifications', 'acme-note');
    const rivalId = await newWorkspace(eveToken, 'Rival Notifications', 'rival-note');

    const acmeWs = new Types.ObjectId(acmeId);
    const rivalWs = new Types.ObjectId(rivalId);
    const userIds: Record<string, Types.ObjectId> = {};
    for (const [key, email] of Object.entries({
      ada: 'ada.note@example.test',
      bob: 'bob.note@example.test',
      dan: 'dan.note@example.test',
      vic: 'vic.note@example.test',
      fay: 'fay.note@example.test',
      eve: 'eve.note@example.test',
    })) {
      userIds[key] = oid((await UserModel.findOne({ email }))!._id);
    }
    await WorkspaceMemberModel.create([
      { workspaceId: acmeWs, userId: userIds['bob'], role: 'agent' },
      { workspaceId: acmeWs, userId: userIds['dan'], role: 'agent' },
      { workspaceId: acmeWs, userId: userIds['fay'], role: 'agent' },
      { workspaceId: acmeWs, userId: userIds['vic'], role: 'viewer' },
    ]);

    const requester =
      (token: string) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathSegments: string, init?: { body?: unknown }): Promise<HttpResult> =>
        http(method, api(pathSegments), { token, ...init });
    const ada = requester(adaToken);
    const bob = requester(bobToken);
    const dan = requester(danToken);
    const vic = requester(vicToken);
    const fay = requester(fayToken);
    const eve = requester(eveToken);

    const inbox = async (token: string, wsId: string, query = ''): Promise<Inbox> => {
      const res = await http('GET', api(`/workspaces/${wsId}/notifications${query}`), { token });
      assert.equal(res.status, 200, `inbox read failed: ${JSON.stringify(res.body)}`);
      return dataOf<Inbox>(res);
    };
    const unreadCount = async (token: string, wsId: string): Promise<number> => {
      const res = await http('GET', api(`/workspaces/${wsId}/notifications/unread-count`), { token });
      assert.equal(res.status, 200);
      return dataOf<{ unreadCount: number }>(res).unreadCount;
    };
    const drain = async (): Promise<void> => {
      await awaitNotificationDispatchIdle();
    };

    const customer = await ada('POST', `/workspaces/${acmeId}/customers`, {
      body: { name: 'Nora Customer', email: 'nora.customer@example.test' },
    });
    assert.equal(customer.status, 201);
    const customerId = dataOf<{ customer?: { id?: string } }>(customer)?.customer?.id ?? '';
    assert.ok(customerId.length > 0);

    let ticketSeq = 0;
    async function newTicket(token: string, subject: string, agentId?: string): Promise<{ id: string; number: string }> {
      ticketSeq += 1;
      const res = await http('POST', api(`/workspaces/${acmeId}/tickets`), {
        token,
        body: {
          customerId,
          subject,
          description: `Driver ticket ${ticketSeq} for notification coverage.`,
          ...(agentId !== undefined ? { agentId } : {}),
        },
      });
      assert.equal(res.status, 201, `ticket create failed: ${JSON.stringify(res.body)}`);
      const ticket = dataOf<{ ticket?: { id?: string; number?: string } }>(res)?.ticket;
      assert.ok(ticket?.id !== undefined && ticket.id.length > 0);
      return { id: ticket.id, number: ticket.number ?? '' };
    }

    // ══ 1. Pure policy: channels, templates, keys ═══════════════════════════
    {
      const prefs = await import('../server/src/modules/notifications/notification.preferences.js');
      const templates = await import(
        '../server/src/modules/notifications/email/email.templates.js'
      );
      const ticketEvents = await import('../server/src/modules/tickets/ticket.events.js');

      const defaults = prefs.resolvePreferenceValues(null);
      record(
        '1.1 defaults enable both channels and every category',
        defaults.inAppEnabled && defaults.emailEnabled && defaults.ticketAssignment &&
          defaults.publicReplies && defaults.escalations && defaults.aiHandoff,
      );

      record(
        '1.2 every notification type maps to exactly one category',
        prefs.categoryOf('ticket.assigned') === 'ticketAssignment' &&
          prefs.categoryOf('conversation.public_message') === 'publicReplies' &&
          prefs.categoryOf('ai.handoff') === 'aiHandoff' &&
          prefs.categoryOf('escalation.resolved') === 'escalations',
      );

      const muted = prefs.decideChannels('escalation.created', { ...defaults, escalations: false });
      record('1.3 a muted category disables BOTH channels', muted.inApp === false && muted.email === false);

      const emailOnly = prefs.decideChannels('ticket.assigned', { ...defaults, inAppEnabled: false });
      record('1.4 channels are independent (in-app off, email on)', emailOnly.inApp === false && emailOnly.email === true);

      const rendered = templates.renderNotificationEmail({
        templateKey: 'ticket.assigned',
        workspaceName: 'Acme <script>alert(1)</script>',
        recipientName: 'Bob & Co',
        title: 'You were assigned TCK-1 <img src=x onerror=alert(1)>',
        body: 'Subject with "quotes" & <b>tags</b>',
      });
      record(
        '1.5 HTML escaping neutralizes injected markup',
        rendered.html.includes('&lt;img src=x') &&
          rendered.html.includes('&lt;script&gt;') &&
          rendered.html.includes('Bob &amp; Co') &&
          !rendered.html.includes('<img src=x'),
      );
      record(
        '1.6 plain-text alternative is produced',
        rendered.text.includes('You were assigned TCK-1') && rendered.text.includes('Workspace: Acme'),
      );
      const crlf = templates.renderNotificationEmail({
        templateKey: 'ticket.assigned',
        workspaceName: 'Acme',
        recipientName: 'Bob',
        title: 'Line one\r\nBcc: attacker@example.test',
        body: 'x',
      });
      record('1.7 subjects cannot be header-injected', !crlf.subject.includes('\n') && !crlf.subject.includes('\r'));

      record(
        '1.8 ticket event keys are stable for the same persisted timestamp',
        ticketEvents.ticketEventKey('abc', 'created', new Date(1000)) ===
          ticketEvents.ticketEventKey('abc', 'created', new Date(1000)) &&
          ticketEvents.ticketEventKey('abc', 'created', new Date(1000)) !==
            ticketEvents.ticketEventKey('abc', 'created', new Date(2000)),
      );
    }

    // ══ 2. Ticket events → in-app notifications ═════════════════════════════
    const assignedTicket = await newTicket(adaToken, 'Printer will not connect');
    {
      const assigned = await ada('PATCH', `/workspaces/${acmeId}/tickets/${assignedTicket.id}/assignment`, {
        body: { agentId: userIds['bob']!.toHexString() },
      });
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      await drain();

      const bobInbox = await inbox(bobToken, acmeId);
      record(
        '2.1 ticket assignment notifies the assignee exactly once',
        bobInbox.items.length === 1 && bobInbox.items[0]?.type === 'ticket.assigned',
      );
      record(
        '2.2 assignment notification references the ticket and carries its number',
        bobInbox.items[0]?.entityType === 'ticket' &&
          bobInbox.items[0]?.entityId === assignedTicket.id &&
          bobInbox.items[0]?.title.includes(assignedTicket.number),
      );
      record('2.3 the acting staff member is not notified about their own action', (await inbox(adaToken, acmeId)).items.length === 0);

      const statusChange = await bob('PATCH', `/workspaces/${acmeId}/tickets/${assignedTicket.id}/status`, {
        body: { status: 'IN_PROGRESS' },
      });
      assert.equal(statusChange.status, 200, JSON.stringify(statusChange.body));
      await drain();
      const adaAfterStatus = await inbox(adaToken, acmeId);
      record(
        '2.4 status changes notify the ticket creator (acted by the assignee)',
        adaAfterStatus.items.some(
          (item) => item.type === 'ticket.status_changed' && item.entityId === assignedTicket.id,
        ),
      );

      const priorityChange = await ada('PATCH', `/workspaces/${acmeId}/tickets/${assignedTicket.id}/priority`, {
        body: { priority: 'HIGH' },
      });
      assert.equal(priorityChange.status, 200, JSON.stringify(priorityChange.body));
      await drain();
      record(
        '2.5 priority changes notify the assignee',
        (await inbox(bobToken, acmeId)).items.some(
          (item) => item.type === 'ticket.priority_changed' && item.title.includes('High'),
        ),
      );

      const reassign = await ada('PATCH', `/workspaces/${acmeId}/tickets/${assignedTicket.id}/assignment`, {
        body: { agentId: userIds['dan']!.toHexString() },
      });
      assert.equal(reassign.status, 200);
      await drain();
      record(
        '2.6 reassignment notifies the NEW assignee with the reassigned type',
        (await inbox(danToken, acmeId)).items.some(
          (item) => item.type === 'ticket.reassigned' && item.entityId === assignedTicket.id,
        ),
      );

      // Unassigned creation fans out to the triage desk (ticket.assign holders).
      const triageTicket = await newTicket(danToken, 'Refund policy question');
      await drain();
      const adaQueue = await inbox(adaToken, acmeId);
      record(
        '2.7 unassigned ticket creation notifies the triage desk (ticket.assign holders)',
        adaQueue.items.some((item) => item.type === 'ticket.created' && item.entityId === triageTicket.id),
      );
      record(
        '2.8 an agent WITHOUT ticket.assign is not part of the triage fan-out',
        (await inbox(bobToken, acmeId)).items.every(
          (item) => !(item.type === 'ticket.created' && item.entityId === triageTicket.id),
        ),
      );
      record(
        '2.9 the creating agent is never notified about the ticket they opened',
        (await inbox(danToken, acmeId)).items.every((item) => item.entityId !== triageTicket.id),
      );
    }

    // ══ 3. Inbox isolation, pagination, read lifecycle ══════════════════════
    {
      const bobInbox = await inbox(bobToken, acmeId);
      assert.ok(bobInbox.items.length >= 2);
      const first = bobInbox.items[0]!;

      // Cross-user: Ada cannot see or mutate Bob's notification.
      const adaReadForeign = await ada('POST', `/workspaces/${acmeId}/notifications/${first.id}/read`);
      record('3.1 another user cannot mark a notification they do not own', adaReadForeign.status === 404);
      const adaList = await inbox(adaToken, acmeId);
      record(
        '3.2 another user never sees this notification in their own inbox',
        adaList.items.every((item) => item.id !== first.id),
      );

      // Cross-tenant: the same id under a foreign workspace reads as missing.
      const eveForeign = await eve('POST', `/workspaces/${rivalId}/notifications/${first.id}/read`);
      record('3.3 cross-workspace notification access conceals existence (404)', eveForeign.status === 404);
      const eveForeignInbox = await inbox(eveToken, rivalId, `?entityId=${assignedTicket.id}`);
      record('3.4 cross-workspace listing cannot reveal foreign notifications', eveForeignInbox.total === 0);

      // Pagination shape.
      const page1 = await inbox(bobToken, acmeId, '?page=1&limit=1');
      record(
        '3.5 pagination is bounded and reports totals',
        page1.limit === 1 && page1.items.length === 1 && page1.total === bobInbox.total && page1.hasMore === true,
      );

      const before = await unreadCount(bobToken, acmeId);
      const readFirst = await bob('POST', `/workspaces/${acmeId}/notifications/${first.id}/read`);
      assert.equal(readFirst.status, 200);
      const readAt = dataOf<{ notification?: NotificationDto }>(readFirst)?.notification?.readAt ?? null;
      record('3.6 marking read stamps readAt and decreases the unread count', readAt !== null && (await unreadCount(bobToken, acmeId)) === before - 1);

      const readAgain = await bob('POST', `/workspaces/${acmeId}/notifications/${first.id}/read`);
      record(
        '3.7 marking read twice is idempotent (original timestamp preserved)',
        readAgain.status === 200 &&
          (dataOf<{ notification?: NotificationDto }>(readAgain)?.notification?.readAt ?? null) === readAt &&
          (await unreadCount(bobToken, acmeId)) === before - 1,
      );

      const unreadOnly = await inbox(bobToken, acmeId, '?unread=true');
      record(
        '3.8 unread filter excludes read items',
        unreadOnly.items.every((item) => item.readAt === null) && unreadOnly.total === before - 1,
      );

      const readAll = await bob('POST', `/workspaces/${acmeId}/notifications/read-all`);
      record(
        '3.9 read-all marks every unread item of the caller only',
        readAll.status === 200 &&
          dataOf<{ markedRead?: number }>(readAll)?.markedRead === before - 1 &&
          (await unreadCount(bobToken, acmeId)) === 0,
      );
      record('3.10 read-all does not touch another user\u2019s inbox', (await unreadCount(adaToken, acmeId)) > 0);

      const badId = await bob('POST', `/workspaces/${acmeId}/notifications/not-an-id/read`);
      record('3.11 malformed notification ids are rejected with 422', badId.status === 422);
      const badFilter = await bob('GET', `/workspaces/${acmeId}/notifications?type=ticket.nope`);
      record('3.12 unknown notification types are rejected with 422', badFilter.status === 422);
    }

    // ══ 4. Preferences: defaults, patch, isolation, dispatch respect, audit ═
    {
      const prefsUrl = `/workspaces/${acmeId}/notifications/preferences`;
      const defaults = await fay('GET', prefsUrl);
      const values = dataOf<{ preferences?: Record<string, unknown> }>(defaults)?.preferences;
      record(
        '4.1 preference defaults are returned without creating a row',
        defaults.status === 200 && values?.['emailEnabled'] === true && values?.['updatedAt'] === null,
      );

      const patched = await fay('PATCH', prefsUrl, { body: { emailEnabled: false } });
      record(
        '4.2 a partial patch changes only the requested field',
        patched.status === 200 &&
          dataOf<{ preferences?: Record<string, unknown> }>(patched)?.preferences?.['emailEnabled'] === false &&
          dataOf<{ preferences?: Record<string, unknown> }>(patched)?.preferences?.['inAppEnabled'] === true,
      );
      record(
        '4.3 the patched preferences are persisted for later reads',
        dataOf<{ preferences?: Record<string, unknown> }>(await fay('GET', prefsUrl))?.preferences?.[
          'emailEnabled'
        ] === false,
      );

      record(
        '4.4 empty patches are rejected',
        (await fay('PATCH', prefsUrl, { body: {} })).status === 422,
      );
      record(
        '4.5 non-boolean values are rejected (no string coercion)',
        (await fay('PATCH', prefsUrl, { body: { inAppEnabled: 'false' } })).status === 422,
      );
      record(
        '4.6 unknown keys are rejected (no userId smuggled into the patch)',
        (await fay('PATCH', prefsUrl, { body: { emailEnabled: true, userId: userIds['bob']!.toHexString() } }))
          .status === 422,
      );
      record(
        '4.7 a user cannot modify another user\u2019s preferences (no addressable field)',
        dataOf<{ preferences?: Record<string, unknown> }>(
          await bob('GET', `/workspaces/${acmeId}/notifications/preferences`),
        )?.preferences?.['emailEnabled'] === true,
      );

      // Audit: field NAMES only, no values.
      const auditRows = await AuditLogModel.find({
        workspaceId: acmeWs,
        action: 'notification.preferences_updated',
      }).lean();
      const auditMetadata = (auditRows[0]?.['metadata'] ?? {}) as { fields?: unknown };
      record(
        '4.8 preference updates are audited with field names only',
        auditRows.length === 1 &&
          String(auditRows[0]?.['resourceId']) === userIds['fay']!.toHexString() &&
          Array.isArray(auditMetadata.fields) &&
          (auditMetadata.fields as string[])[0] === 'emailEnabled',
      );

      // Dispatch respects the preference: in-app notification, NO email.
      const prefsTicket = await newTicket(adaToken, 'Preference-respect ticket', userIds['fay']!.toHexString());
      await drain();
      await drain();
      const fayInbox = await inbox(fayToken, acmeId);
      const fayDeliveries = await listEmailDeliveriesForRecipient(acmeWs, userIds['fay']!);
      record(
        '4.9 email-disabled user still receives the in-app notification',
        fayInbox.items.some(
          (item) => item.entityId === prefsTicket.id && item.type === 'ticket.created',
        ),
      );
      record('4.10 email-disabled user gets no delivery row at all', fayDeliveries.length === 0);

      // Category mute suppresses BOTH channels for the muted user.
      const muted = await dan('PATCH', `/workspaces/${acmeId}/notifications/preferences`, {
        body: { ticketUpdates: false },
      });
      assert.equal(muted.status, 200);
      const muteTicket = await newTicket(
        adaToken,
        'Muted-category ticket whose updates must stay silent',
        userIds['dan']!.toHexString(),
      );
      const muteStatus = await ada('PATCH', `/workspaces/${acmeId}/tickets/${muteTicket.id}/status`, {
        body: { status: 'IN_PROGRESS' },
      });
      assert.equal(muteStatus.status, 200);
      await drain();
      record(
        '4.11 a muted category suppresses the in-app notification for that user',
        (await inbox(danToken, acmeId)).items.every((item) => item.entityId !== muteTicket.id),
      );
      record(
        '4.12 a muted category suppresses the email too (no ledger row)',
        (await listEmailDeliveriesForRecipient(acmeWs, userIds['dan']!)).every(
          (delivery) => !delivery.eventKey.startsWith(muteTicket.id),
        ),
      );
      // Restore Dan so later sections observe normal behaviour again.
      await dan('PATCH', `/workspaces/${acmeId}/notifications/preferences`, {
        body: { ticketUpdates: true },
      });
    }

    // ══ 5. Conversation events: PUBLIC vs INTERNAL ══════════════════════════
    {
      const convoTicket = await newTicket(adaToken, 'Conversation notification ticket', userIds['bob']!.toHexString());
      const convoRes = await ada('POST', `/workspaces/${acmeId}/tickets/${convoTicket.id}/conversations`);
      assert.ok(convoRes.status === 200 || convoRes.status === 201, JSON.stringify(convoRes.body));
      const conversationId =
        dataOf<{ conversation?: { id?: string } }>(convoRes)?.conversation?.id ?? '';
      assert.ok(conversationId.length > 0);

      const internal = await bob('POST', `/workspaces/${acmeId}/conversations/${conversationId}/messages`, {
        body: { body: 'Internal: customer is escalating quietly', visibility: 'INTERNAL' },
      });
      assert.equal(internal.status, 201, JSON.stringify(internal.body));
      await drain();
      record(
        '5.1 INTERNAL notes never notify (staff-only content stays out of inboxes)',
        (await inbox(adaToken, acmeId)).items.every(
          (item) => item.type !== 'conversation.public_message' || item.entityId !== conversationId,
        ),
      );

      const publicReply = await bob('POST', `/workspaces/${acmeId}/conversations/${conversationId}/messages`, {
        body: { body: 'Public: we are looking into this now', visibility: 'PUBLIC' },
      });
      assert.equal(publicReply.status, 201);
      await drain();
      const adaInbox = await inbox(adaToken, acmeId);
      const messageNotification = adaInbox.items.find(
        (item) => item.type === 'conversation.public_message' && item.entityId === conversationId,
      );
      record('5.2 a PUBLIC staff reply notifies the ticket creator', messageNotification !== undefined);
      record(
        '5.3 the message notification carries no message body',
        messageNotification !== undefined &&
          !messageNotification.body.includes('looking into this') &&
          !messageNotification.title.includes('looking into this'),
      );
      record(
        '5.4 the sender is not notified about their own reply',
        (await inbox(bobToken, acmeId)).items.every(
          (item) => item.type !== 'conversation.public_message' || item.entityId !== conversationId,
        ),
      );
    }

    // ══ 6. Escalation events (manual, AI handoff, AI failure) ═══════════════
    {
      const unitFor = async (): Promise<{ ticketId: string; conversationId: string }> => {
        const ticket = await newTicket(adaToken, 'Escalation notification unit');
        const convo = await ada('POST', `/workspaces/${acmeId}/tickets/${ticket.id}/conversations`);
        const conversationId = dataOf<{ conversation?: { id?: string } }>(convo)?.conversation?.id ?? '';
        assert.ok(conversationId.length > 0);
        return { ticketId: ticket.id, conversationId };
      };

      // Manual escalation by Ada (owner, actor) → desk agents with escalation.manage hear about it.
      const manualUnit = await unitFor();
      const manual = await ada('POST', `/workspaces/${acmeId}/escalations`, {
        body: { conversationId: manualUnit.conversationId, priority: 'HIGH', note: 'please take over' },
      });
      assert.equal(manual.status, 201, JSON.stringify(manual.body));
      const escalationId = dataOf<{ escalation?: { id?: string } }>(manual)?.escalation?.id ?? '';
      assert.ok(escalationId.length > 0);
      await drain();

      const bobEscalationNotification = (await inbox(bobToken, acmeId)).items.find(
        (item) => item.entityType === 'escalation' && item.entityId === escalationId,
      );
      record(
        '6.1 manual escalation notifies the desk with an escalation notification',
        bobEscalationNotification?.type === 'escalation.created',
      );
      record(
        '6.2 escalation notification never includes the escalation note',
        bobEscalationNotification !== undefined &&
          !bobEscalationNotification.body.includes('please take over') &&
          !bobEscalationNotification.title.includes('please take over'),
      );
      record('6.3 the escalating staff member is not notified', (await inbox(adaToken, acmeId)).items.every((item) => item.entityId !== escalationId));

      const assigned = await ada('POST', `/workspaces/${acmeId}/escalations/${escalationId}/assign`, {
        body: { assigneeId: userIds['dan']!.toHexString() },
      });
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      await drain();
      record(
        '6.4 escalation assignment notifies the assignee',
        (await inbox(danToken, acmeId)).items.some(
          (item) => item.type === 'escalation.assigned' && item.entityId === escalationId,
        ),
      );

      const accepted = await dan('POST', `/workspaces/${acmeId}/escalations/${escalationId}/accept`);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      await drain();
      record(
        '6.5 accepting your own assignment notifies nobody',
        [...(await inbox(danToken, acmeId)).items, ...(await inbox(bobToken, acmeId)).items].every(
          (item) => !(item.type === 'escalation.accepted' && item.entityId === escalationId),
        ),
      );

      const resolved = await dan('POST', `/workspaces/${acmeId}/escalations/${escalationId}/resolve`, {
        body: { resolutionNote: 'handled, customer replied' },
      });
      assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
      await drain();
      const adaResolved = (await inbox(adaToken, acmeId)).items.find(
        (item) => item.type === 'escalation.resolved' && item.entityId === escalationId,
      );
      record('6.6 resolution notifies the initiator', adaResolved !== undefined);
      record(
        '6.7 resolution notes never surface in notifications',
        adaResolved !== undefined && !adaResolved.body.includes('handled, customer replied'),
      );

      // AI abstention → AI handoff notification (through the REAL agent hook).
      const aiUnit = await unitFor();
      await noteAgentInteraction({
        workspaceId: acmeWs,
        conversationId: new Types.ObjectId(aiUnit.conversationId),
        actorId: userIds['bob']!,
        question: 'how do I export the monthly summary',
        outcome: { kind: 'ABSTAINED', abstentionReason: 'NO_KNOWLEDGE' },
      });
      await drain();
      const handoffNotification = (await inbox(adaToken, acmeId)).items.find(
        (item) => item.type === 'ai.handoff',
      );
      record('6.8 an AI abstention handoff produces an ai.handoff notification', handoffNotification !== undefined);
      record(
        '6.9 the AI handoff notification describes the ticket, not the question',
        handoffNotification !== undefined && !handoffNotification.body.includes('export the monthly'),
      );

      // Provider failure → ai.failure notification.
      const failUnit = await unitFor();
      await noteAgentInteraction({
        workspaceId: acmeWs,
        conversationId: new Types.ObjectId(failUnit.conversationId),
        actorId: userIds['bob']!,
        question: 'what are the delivery windows',
        outcome: { kind: 'FAILED', failureCode: 'AGENT_AI_PROVIDER_FAILED' },
      });
      await drain();
      record(
        '6.10 an AI technical failure produces an ai.failure notification',
        (await inbox(adaToken, acmeId)).items.some((item) => item.type === 'ai.failure'),
      );

      // Escalation events for a vanished record are dropped, not faked.
      const { publishEscalationEvent } = await import(
        '../server/src/modules/escalations/escalation.events.js'
      );
      publishEscalationEvent({
        type: 'escalation.resolved',
        workspaceId: acmeId,
        escalationId: new Types.ObjectId().toHexString(),
        conversationId: manualUnit.conversationId,
        actorId: userIds['bob']!.toHexString(),
      });
      await drain();
      record(
        '6.11 an event for a missing escalation creates no notification',
        (await NotificationModel.countDocuments({ workspaceId: acmeWs, type: 'escalation.resolved' })) === 1,
      );
    }

    // ══ 7. Email rendering through the outbox provider ══════════════════════
    {
      logEmailProvider.clear();
      const emailTicket = await newTicket(
        adaToken,
        'Email delivery <script>alert("x")</script> ticket',
        userIds['fay']!.toHexString(),
      );
      // Fay muted EMAIL earlier (4.2); re-enable so this section can observe mail.
      await fay('PATCH', `/workspaces/${acmeId}/notifications/preferences`, { body: { emailEnabled: true } });
      await ada('PATCH', `/workspaces/${acmeId}/tickets/${emailTicket.id}/priority`, { body: { priority: 'URGENT' } });
      await drain();

      const sent = logEmailProvider.sentMessages().filter((message) => message.to === 'fay.note@example.test');
      const message = sent.at(-1);
      record('7.1 an email is handed to the provider for an email-enabled recipient', message !== undefined);
      record(
        '7.2 the rendered email escapes user-controlled subject text',
        message !== undefined &&
          message.html.includes('&lt;script&gt;') &&
          !message.html.includes('<script>alert'),
      );
      record(
        '7.3 the email carries both an HTML and a plain-text alternative',
        message !== undefined && message.html.length > 0 && message.text.length > 0,
      );

      const deliveries = await listEmailDeliveriesForRecipient(acmeWs, userIds['fay']!);
      record(
        '7.4 the delivery ledger records provider acceptance (SENT), not "delivered"',
        deliveries.some(
          (delivery) => delivery.status === 'SENT' && delivery.provider === 'log' && delivery.acceptedAt !== null,
        ),
      );
      record(
        '7.5 the ledger stores no rendered HTML',
        deliveries.every((delivery) => !('html' in (delivery.toObject() as Record<string, unknown>))),
      );
    }

    // ══ 8. Failure handling, retry sweep, exhaustion, invalid recipient ═════
    {
      const mkTicket = async (token: string, subject: string, agentId: string): Promise<{ id: string }> =>
        newTicket(token, subject, agentId);

      // 8.1 transient failure: business op succeeds, notification persists.
      const transientTicket = await mkTicket(adaToken, 'Transient email failure ticket', userIds['dan']!.toHexString());
      let transientCalls = 0;
      setEmailProvider({
        name: 'test-transient',
        send: async () => {
          transientCalls += 1;
          throw new EmailProviderError('SMTP_ETIMEDOUT', 'timed out', true);
        },
      });
      const assignedTransient = await ada('PATCH', `/workspaces/${acmeId}/tickets/${transientTicket.id}/priority`, {
        body: { priority: 'HIGH' },
      });
      await drain();
      const transientDeliveries = await listEmailDeliveriesForRecipient(acmeWs, userIds['dan']!);
      const transientRow = transientDeliveries.find((delivery) => delivery.templateKey === 'ticket.priority_changed');
      record(
        '8.1 a provider failure never fails the business operation (HTTP 200)',
        assignedTransient.status === 200,
      );
      record(
        '8.2 the in-app notification is persisted despite email failure',
        (await inbox(danToken, acmeId)).items.some((item) => item.entityId === transientTicket.id),
      );
      record(
        '8.3 the failure is recorded as RETRY_PENDING with a stable error code',
        transientRow !== undefined &&
          transientRow.status === 'RETRY_PENDING' &&
          transientRow.lastErrorCode === 'SMTP_ETIMEDOUT' &&
          transientRow.attempts === 1 &&
          transientRow.nextAttemptAt !== null,
      );

      // 8.4 sweep recovers once the provider works again.
      setEmailProvider(null);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const sweep = await sweepEmailDeliveries(acmeWs);
      const recovered = await listEmailDeliveriesForRecipient(acmeWs, userIds['dan']!);
      record(
        '8.4 the retry sweep re-attempts due rows and marks them SENT',
        sweep.attempted >= 1 && sweep.accepted >= 1 && transientCalls >= 1,
      );
      record(
        '8.5 a successful retry preserves the attempt history on the same row',
        recovered.some(
          (delivery) =>
            delivery.templateKey === 'ticket.priority_changed' &&
            delivery.status === 'SENT' &&
            delivery.attempts === 2,
        ),
      );

      // 8.6 permanent failure → FAILED immediately (no pointless retries).
      const permTicket = await mkTicket(adaToken, 'Permanent email failure ticket', userIds['fay']!.toHexString());
      setEmailProvider({
        name: 'test-permanent',
        send: async () => {
          throw new EmailProviderError('SMTP_EENVELOPE', 'rejected', false);
        },
      });
      await ada('PATCH', `/workspaces/${acmeId}/tickets/${permTicket.id}/priority`, { body: { priority: 'LOW' } });
      await drain();
      const permRows = await listEmailDeliveriesForRecipient(acmeWs, userIds['fay']!);
      record(
        '8.6 a permanent provider error is terminal (FAILED, not retried)',
        permRows.some(
          (delivery) => delivery.status === 'FAILED' && delivery.lastErrorCode === 'SMTP_EENVELOPE',
        ),
      );

      // 8.7 attempts exhaustion → FAILED after maxAttempts.
      const exhaustTicket = await mkTicket(adaToken, 'Exhaustion ticket', userIds['dan']!.toHexString());
      let attemptsSeen = 0;
      setEmailProvider({
        name: 'test-always-failing',
        send: async () => {
          attemptsSeen += 1;
          throw new EmailProviderError('SMTP_ECONNECTION', 'down', true);
        },
      });
      await ada('PATCH', `/workspaces/${acmeId}/tickets/${exhaustTicket.id}/priority`, { body: { priority: 'URGENT' } });
      await drain();
      // Backoff doubles per attempt (5ms base here), so drain generously until
      // the ledger's attempt cap turns the row terminal.
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        await sweepEmailDeliveries(acmeWs);
      }
      const exhaustRow = (await listEmailDeliveriesForRecipient(acmeWs, userIds['dan']!)).find(
        (delivery) =>
          delivery.templateKey === 'ticket.priority_changed' &&
          delivery.eventKey.startsWith(exhaustTicket.id) &&
          delivery.status === 'FAILED',
      );
      record(
        '8.7 retries stop at NOTIFICATION_EMAIL_MAX_ATTEMPTS and become terminal (FAILED)',
        exhaustRow !== undefined &&
          exhaustRow.attempts === 3 &&
          exhaustRow.nextAttemptAt === null &&
          exhaustRow.lastErrorCode === 'SMTP_ECONNECTION',
      );
      record('8.8 no further provider calls happen after exhaustion', attemptsSeen >= 3);

      // 8.9 invalid recipient never reaches the network (SMTP adapter validation).
      setEmailProvider(null);
      const { smtpEmailProvider } = await import(
        '../server/src/modules/notifications/email/smtp-email.provider.js'
      );
      setEmailProvider(smtpEmailProvider);
      const invalid = await createEmailDeliveryIfAbsent({
        workspaceId: acmeWs,
        recipientId: userIds['dan']!,
        notificationId: null,
        to: 'definitely-not-an-email',
        templateKey: 'ticket.assigned',
        title: 'Invalid recipient probe',
        body: 'probe',
        eventKey: `${new Types.ObjectId().toHexString()}:invalid-recipient`,
        maxAttempts: 2,
      });
      assert.ok(invalid !== null);
      const invalidStatus = await attemptEmailDelivery(acmeWs, invalid.delivery._id);
      record(
        '8.9 an invalid recipient fails fast with INVALID_RECIPIENT',
        invalidStatus === 'FAILED' &&
          (await listEmailDeliveriesForRecipient(acmeWs, userIds['dan']!)).some(
            (delivery) => delivery.lastErrorCode === 'INVALID_RECIPIENT',
          ),
      );
      setEmailProvider(null);

      // 8.10 a direct delivery call is also idempotent through the ledger.
      const beforeRows = (await listEmailDeliveriesForRecipient(acmeWs, userIds['bob']!)).length;
      const disabled = await deliverNotificationEmail({
        workspaceId: acmeWs,
        recipientId: userIds['bob']!,
        notificationId: null,
        type: 'ticket.assigned',
        eventKey: `${new Types.ObjectId().toHexString()}:ignored`,
        title: 'direct probe',
        body: 'direct probe',
      });
      record(
        '8.10 direct delivery calls respect the idempotency ledger (no duplicate rows)',
        disabled.queued === true &&
          (await listEmailDeliveriesForRecipient(acmeWs, userIds['bob']!)).length === beforeRows + 1,
      );
    }

    // ══ 9. Idempotency: the same event emitted twice ════════════════════════
    {
      const captured: Array<{ type: string; ticketId: string; workspaceId: string }> = [];
      const listener = (event: { type: string; ticketId?: string; workspaceId?: string }): void => {
        if (event.type !== 'ticket.created') return;
        captured.push({
          type: event.type,
          ticketId: event.ticketId ?? '',
          workspaceId: event.workspaceId ?? '',
        });
      };
      ticketEventBus.on('ticket', listener);

      const dedupeTicket = await newTicket(danToken, 'Idempotency ticket');
      await drain();
      const original = captured.at(-1);
      record('9.1 the ticket event was published exactly once by the service', original !== undefined);

      // Re-emit the SAME persisted event (a retry/duplicate): nothing may duplicate.
      const adaBefore = (await inbox(adaToken, acmeId)).items.filter(
        (item) => item.entityId === dedupeTicket.id,
      ).length;
      const bobDeliveriesBefore = (await listEmailDeliveriesForRecipient(acmeWs, userIds['ada']!)).length;
      ticketEventBus.emit('ticket', original);
      ticketEventBus.emit('ticket', original);
      await drain();

      const adaAfter = (await inbox(adaToken, acmeId)).items.filter(
        (item) => item.entityId === dedupeTicket.id,
      ).length;
      const adaDeliveriesAfter = (await listEmailDeliveriesForRecipient(acmeWs, userIds['ada']!)).length;
      record('9.2 a duplicated event creates no second in-app notification', adaAfter === adaBefore);
      record('9.3 a duplicated event creates no second email ledger row', adaDeliveriesAfter === bobDeliveriesBefore);

      ticketEventBus.removeListener('ticket', listener);
    }

    // ══ 10. Socket publication seam ═════════════════════════════════════════
    {
      setNotificationPublisher({
        publish: () => {
          throw new Error('socket transport down');
        },
      });
      const publishTicket = await newTicket(
        adaToken,
        'Publisher failure ticket',
        userIds['bob']!.toHexString(),
      );
      await drain();
      record(
        '10.1 a failing publisher never breaks the REST operation',
        (await inbox(bobToken, acmeId)).items.some((item) => item.entityId === publishTicket.id),
      );

      const published: Array<{ id: string; recipientId: string }> = [];
      setNotificationPublisher({
        publish: (notification) => {
          published.push({
            id: notification._id.toHexString(),
            recipientId: notification.recipientId.toHexString(),
          });
        },
      });
      const publishTicket2 = await newTicket(
        adaToken,
        'Publisher success ticket',
        userIds['dan']!.toHexString(),
      );
      await drain();
      const persisted = await NotificationModel.findOne({
        workspaceId: acmeWs,
        entityId: new Types.ObjectId(publishTicket2.id),
      });
      record(
        '10.2 the publisher receives only PERSISTED notifications for the real recipient',
        persisted !== null &&
          published.some(
            (entry) =>
              entry.id === persisted._id.toHexString() &&
              entry.recipientId === userIds['dan']!.toHexString(),
          ),
      );
      setNotificationPublisher(null);
    }

    // ══ 11. Storage-level guarantees ════════════════════════════════════════
    {
      const indexes = await NotificationModel.collection.indexes();
      record(
        '11.1 duplicate prevention is enforced by a unique (workspace, recipient, eventKey) index',
        indexes.some(
          (index) =>
            index.unique === true &&
            JSON.stringify(Object.keys(index.key)) ===
              JSON.stringify(['workspaceId', 'recipientId', 'eventKey']),
        ),
      );
      const everyInboxQueryScoped = (await NotificationModel.countDocuments({ workspaceId: rivalWs })) === 0;
      record('11.2 the foreign workspace holds no notifications from this run', everyInboxQueryScoped);
      record(
        '11.3 notifications never store message bodies or notes',
        (await NotificationModel.find({ workspaceId: acmeWs }).lean()).every(
          (row) =>
            !String(row.body).includes('looking into this') &&
            !String(row.body).includes('customer is escalating quietly') &&
            !String(row.body).includes('please take over'),
        ),
      );
    }

    if (failures > 0) {
      console.error(`\n${failures} check(s) FAILED`);
    } else {
      console.log('\nALL NOTIFICATION CHECKS PASSED');
    }
  } finally {
    await shutdown();
  }

  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error('verification driver crashed:', error);
  process.exit(1);
});
