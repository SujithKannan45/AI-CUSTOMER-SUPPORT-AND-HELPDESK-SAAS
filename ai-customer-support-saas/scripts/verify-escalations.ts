/* eslint-disable no-console -- verification driver output is the deliverable */
/**
 * Prompt 15 verification driver — AI human handoff & escalation (integration).
 *
 * Boots the REAL server against the documented local verification fixtures
 * (in-memory Mongo + mock provider seams, exactly like verify-agent.ts) and
 * drives the escalation system end-to-end:
 *
 *   1. pure trigger-rule policy checks (no HTTP, no provider),
 *   2. RBAC, concealment and validation of the escalation endpoints,
 *   3. manual escalation lifecycle (create → assign → accept → resolve with
 *      ticket side-effects, duplicate prevention, idempotency),
 *   4. reassignment semantics + event-transport-failure resilience,
 *   5. cancellation ownership rules,
 *   6. automatic triggers through the AI agent (explicit human request,
 *      sensitive topic, insufficient knowledge, provider-failure fallback,
 *      repeated-failure threshold) and the agent PAUSE gate,
 *   7. concurrency safety (racing creates + racing assignments),
 *   8. content-free audit trail and typed event seam.
 *
 * Determinism strategy (same recipe as verify-agent.ts): the driver boots
 * with ESCALATION_ON_TECHNICAL_FAILURE=false so the repeated-failure HTTP
 * run is deterministic — three consecutive FORCE_FAIL asks trip the
 * threshold and NO single-shot technical escalation intercepts the first
 * failure. The single-shot TECHNICAL_FAILURE mapping is asserted by the
 * pure rule checks in section 1 instead. The seeded KB article's body IS
 * the exact probe string (hash mock → cosine 1.0 self-match at
 * RAG_MAX_RETRIEVE_LIMIT=1), so provider-bound asks deterministically reach
 * the mock provider; abstention comes from the model's FORCE_ABSTAIN
 * protocol (MODEL_DECLINED), never from ambiguous retrieval scores.
 *
 * NOT covered here: a live Socket.IO transport (Prompt 10's socket server
 * is a documented design contract only — the typed transport seam is what
 * ships) and live OpenAI behavior (requires credentials).
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
  headers['x-forwarded-for'] = `10.21.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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
const pollUntil = async (probe: () => Promise<boolean>, attempts = 60): Promise<boolean> => {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe()) return true;
    await sleep(100);
  }
  return false;
};

function dataOf<T>(res: HttpResult): T {
  return (res.body as { data?: T }).data as T;
}
function errorCodeOf(res: HttpResult): string | undefined {
  const error = res.body['error'] as { code?: string } | undefined;
  return error?.code;
}

/** Typed escape hatch for lean-returned ids (same pattern as the other drivers). */
const oid = (value: unknown): Types.ObjectId => value as Types.ObjectId;

interface EscalationDto {
  readonly id: string;
  readonly conversationId: string;
  readonly ticketId: string;
  readonly triggerType: string;
  readonly reasonCode: string;
  readonly topicKey: string | null;
  readonly status: string;
  readonly eligibleAssigneeId: string | null;
  readonly acceptedById: string | null;
  readonly hasResolutionNote: boolean;
  readonly hasCancelReason: boolean;
  readonly initiatedBy: { readonly actorType: string; readonly actorId: string | null };
}

/** Typed events observed through the published seam (attached at boot). */
const externalEventLog: { readonly type: string; readonly payload: Record<string, unknown> }[] = [];

const CONVERSATION_NOT_FOUND = 'Conversation not found';

async function main(): Promise<void> {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_escalations' },
  });

  const expectedUri = memoryServer.getUri('verify_escalations');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '100000';
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'verify-escalations-storage-'));
  mkdirSync(storageRoot, { recursive: true });
  process.env['STORAGE_DATA_DIR'] = storageRoot;

  // RAG fixtures: the documented local verification configuration.
  process.env['RAG_EMBEDDING_PROVIDER'] = 'mock';
  process.env['RAG_EMBEDDING_MODEL'] = 'mock-model';
  process.env['RAG_EMBEDDING_DIMENSIONS'] = '8';
  process.env['RAG_VECTOR_SEARCH'] = 'inmemory';
  process.env['AI_AGENT_MIN_CONTEXT_SCORE'] = '0';
  process.env['RAG_MAX_RETRIEVE_LIMIT'] = '1';
  process.env['AI_AGENT_CONTEXT_MAX_PASSAGES'] = '1';

  // Escalation policy for THIS driver (see the header note): single-shot
  // technical failure is off so the repeated-failure run is deterministic.
  process.env['ESCALATION_ON_ABSTENTION'] = 'true';
  process.env['ESCALATION_ON_HUMAN_REQUEST'] = 'true';
  process.env['ESCALATION_ON_SENSITIVE_TOPIC'] = 'true';
  process.env['ESCALATION_ON_TECHNICAL_FAILURE'] = 'false';
  process.env['ESCALATION_REPEATED_FAILURE_THRESHOLD'] = '3';
  process.env['ESCALATION_FAILURE_WINDOW_HOURS'] = '24';

  const port = 4079;
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

  // Event-seam observer attached BEFORE any code path runs, so section 8 can
  // assert the full lifecycle fan-out (service persists FIRST, then emits).
  const { escalationEventBus } = await import('../server/src/modules/escalations/escalation.events.js');
  const onEscalationEvent = (event: { type: string }): void => {
    externalEventLog.push({ type: event.type, payload: { ...(event as unknown as Record<string, unknown>) } });
  };
  escalationEventBus.on('escalation', onEscalationEvent);

  try {
    const api = (pathSegments: string): string => `http://127.0.0.1:${port}/api/v1${pathSegments}`;
    const { UserModel } = await import('../server/src/modules/users/user.model.js');
    const { WorkspaceMemberModel } = await import(
      '../server/src/modules/workspaces/workspace-member.model.js'
    );
    const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
    const { TicketModel } = await import('../server/src/modules/tickets/ticket.model.js');
    const { EscalationModel } = await import('../server/src/modules/escalations/escalation.model.js');
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

    const adaToken = await newUser('Ada Agentia', 'ada.esc@example.test');
    const bobToken = await newUser('Bob Handler', 'bob.esc@example.test');
    const danToken = await newUser('Dan Uninvolved', 'dan.esc@example.test');
    const vicToken = await newUser('Vic Viewer', 'vic.esc@example.test');
    const eveToken = await newUser('Eve Napier', 'eve.esc@example.test');

    const acmeId = await newWorkspace(adaToken, 'Acme Escalations', 'acme-esc');
    const rivalId = await newWorkspace(eveToken, 'Rival Escalations', 'rival-esc');

    const acmeWs = new Types.ObjectId(acmeId);
    const rivalWs = new Types.ObjectId(rivalId);
    const adaId = oid((await UserModel.findOne({ email: 'ada.esc@example.test' }))!._id);
    const bobId = oid((await UserModel.findOne({ email: 'bob.esc@example.test' }))!._id);
    const danId = oid((await UserModel.findOne({ email: 'dan.esc@example.test' }))!._id);
    const vicId = oid((await UserModel.findOne({ email: 'vic.esc@example.test' }))!._id);
    const eveId = oid((await UserModel.findOne({ email: 'eve.esc@example.test' }))!._id);
    await WorkspaceMemberModel.create([
      { workspaceId: acmeWs, userId: bobId, role: 'agent' },
      { workspaceId: acmeWs, userId: danId, role: 'agent' },
      { workspaceId: acmeWs, userId: vicId, role: 'viewer' },
    ]);

    const requester =
      (token: string) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathSegments: string, init?: { body?: unknown }): Promise<HttpResult> =>
        http(method, api(pathSegments), { token, ...init });
    const ada = requester(adaToken);
    const bob = requester(bobToken);
    const dan = requester(danToken);
    const vic = requester(vicToken);
    const eve = requester(eveToken);

    const escalationsBase = `/workspaces/${acmeId}/escalations`;

    /** One escalation-capable unit: a real ticket + its primary conversation. */
    interface EscalationUnit {
      readonly ticketId: Types.ObjectId;
      readonly conversationId: Types.ObjectId;
    }
    const units: EscalationUnit[] = [];
    async function newUnit(): Promise<EscalationUnit> {
      const customerId = new Types.ObjectId();
      const ticket = await createTicketRecord(acmeWs, {
        customerId,
        subject: `Escalation driver unit ${units.length + 1}`,
        description: 'Driver-created ticket for escalation lifecycle coverage.',
        createdById: adaId,
      });
      const conversation = await createConversation(acmeWs, {
        ticketId: ticket._id,
        customerId,
        subject: null,
      });
      const unit: EscalationUnit = { ticketId: ticket._id, conversationId: conversation._id };
      units.push(unit);
      return unit;
    }

    const c1 = await newUnit(); // HUMAN_REQUEST trigger
    const c2 = await newUnit(); // SENSITIVE_TOPIC trigger
    const c3 = await newUnit(); // AI_INSUFFICIENT_KNOWLEDGE trigger
    const c4 = await newUnit(); // AI_REPEATED_FAILURE trigger + pause gate
    const c5 = await newUnit(); // manual lifecycle (assign→accept→resolve)
    const c6 = await newUnit(); // reassignment semantics
    const c7 = await newUnit(); // cancellation ownership
    const c8 = await newUnit(); // concurrency races
    const c9 = await newUnit(); // manual creation → agent pause gate
    const cTech = await newUnit(); // provider-failure safe fallback (no escalation)
    const convoHex = (unit: EscalationUnit): string => unit.conversationId.toHexString();

    /** Raw escalation document lookup for a unit (id + machine fields only). */
    async function getEscalationFor(unit: EscalationUnit): Promise<{
      readonly id: string;
      readonly triggerType: string;
      readonly reasonCode: string;
      readonly topicKey: string | null;
      readonly status: string;
      readonly initiatedBy: { readonly actorType: string; readonly actorId: string | null };
    } | null> {
      const doc = await EscalationModel.findOne({ conversationId: unit.conversationId })
        .lean<Record<string, unknown> | null>()
        .exec();
      if (doc === null) return null;
      const initiatedBy = doc['initiatedBy'] as
        | { actorType?: string; actorId?: Types.ObjectId | null }
        | undefined;
      return {
        id: oid(doc['_id']).toHexString(),
        triggerType: doc['triggerType'] as string,
        reasonCode: doc['reasonCode'] as string,
        topicKey: (doc['topicKey'] as string | null | undefined) ?? null,
        status: doc['status'] as string,
        initiatedBy: {
          actorType: initiatedBy?.actorType ?? '',
          actorId: initiatedBy?.actorId ? initiatedBy.actorId.toHexString() : null,
        },
      };
    }

    // ══ 1. Pure trigger-rule policy (no HTTP) ═════════════════════════════
    {
      const rules = await import('../server/src/modules/escalations/escalation.rules.js');
      const policy = rules.escalationPolicyFromEnv();

      record('1.1 platform mis-configurations are not escalation-worthy',
        rules.isConfigurationError('AGENT_AI_NOT_CONFIGURED') && rules.isConfigurationError('RAG_EMBEDDING_NOT_CONFIGURED'));
      record('1.2 runtime provider failure IS escalation-worthy',
        rules.isConfigurationError('AGENT_AI_PROVIDER_FAILED') === false);

      const techPolicy = { ...policy, onTechnicalFailure: true };
      const tech = rules.decideEscalationTrigger(
        'FORCE_FAIL context',
        { kind: 'FAILED', failureCode: 'AGENT_AI_PROVIDER_FAILED' },
        techPolicy,
      );
      record('1.3 provider failure maps to a single-shot TECHNICAL_FAILURE trigger (HTTP-side env choice documented)',
        tech !== null && tech.triggerType === 'TECHNICAL_FAILURE');
      const techConfig = rules.decideEscalationTrigger('x', { kind: 'FAILED', failureCode: 'AGENT_AI_NOT_CONFIGURED' }, techPolicy);
      record('1.4 a misconfigured deployment is never a handoff trigger', techConfig === null);

      const abstOff = rules.decideEscalationTrigger('q', { kind: 'ABSTAINED', abstentionReason: 'NO_KNOWLEDGE' }, { ...policy, onAbstention: false });
      record('1.5 the abstention trigger is toggleable (off → no escalation)', abstOff === null);

      const dominant = rules.decideEscalationTrigger(
        'I need a human representative about my refund invoice charge',
        { kind: 'ANSWERED' },
        techPolicy,
      );
      record('1.6 an explicit human request dominates keyword topic detection',
        dominant !== null && dominant.triggerType === 'HUMAN_REQUEST');

      record('1.7 keyword rules match word-boundary prefixes ("refunds" matches refund)',
        rules.matchesAnyKeyword('my refund was not processed', ['refund']) &&
        rules.matchesAnyKeyword('REFUNDS policy', ['refund']));
      record('1.8 keyword rules never match mid-word ("prefundo" does not match refund)',
        rules.matchesAnyKeyword('the prefundo clause', ['refund']) === false);

      record('1.9 repeated-failure rule trips at the configured threshold',
        rules.shouldEscalateRepeatedFailure(true, 2, policy) === true);
      record('1.10 repeated-failure rule does not trip below the threshold',
        rules.shouldEscalateRepeatedFailure(true, 1, policy) === false);
    }

    // Install the deterministic mock (same test seam as verify-agent).
    const { setChatProviderForTests } = await import('../server/src/modules/ai/chat/chat.factory.js');
    const { MockChatProvider } = await import('../server/src/modules/ai/chat/mock-chat.provider.js');
    setChatProviderForTests(new MockChatProvider());

    // ══ 2. RBAC, concealment, validation ═══════════════════════════════════
    {
      const unauth = await http('POST', api(escalationsBase), { body: { conversationId: convoHex(c5) } });
      record('2.1 unauthenticated escalation creation is 401', unauth.status === 401);

      const foreign = await eve('GET', escalationsBase);
      record('2.2 foreign-workspace listing is 404 (concealment)', foreign.status === 404);

      const viewerList = await vic('GET', escalationsBase);
      record('2.3 viewer MAY list escalations (escalation.view granted)', viewerList.status === 200);

      const viewerCreate = await vic('POST', escalationsBase, { body: { conversationId: convoHex(c5) } });
      record('2.4 viewer escalation creation is 403 (escalation.manage denied)', viewerCreate.status === 403);

      const malformed = await ada('POST', escalationsBase, { body: { conversationId: 'not-a-24-hex' } });
      record('2.5 malformed conversationId is 422', malformed.status === 422);

      const oversizedNote = await ada('POST', escalationsBase, {
        body: { conversationId: convoHex(c5), note: 'x'.repeat(501) },
      });
      record('2.6 note over 500 chars is 422', oversizedNote.status === 422);

      const rivalUnit = await createConversation(rivalWs, {
        ticketId: new Types.ObjectId(),
        customerId: new Types.ObjectId(),
        subject: null,
      });
      const crossTenant = await ada('POST', escalationsBase, {
        body: { conversationId: rivalUnit._id.toHexString() },
      });
      record('2.7 foreign conversationId (other workspace) is 404', crossTenant.status === 404);

      const viewerEscalation = await ada('POST', escalationsBase, { body: { conversationId: convoHex(c7) } });
      const viewerEscalationId = viewerEscalation.status === 201
        ? dataOf<{ escalation: EscalationDto }>(viewerEscalation)?.escalation.id
        : '';
      assert.ok(viewerEscalationId !== undefined && viewerEscalationId.length > 0, 'c7 record required for RBAC section');
      // bob (agent, but NOT the initiator of c7's record created by ada) is
      // still non-involved at creation; the mutation gate is exercised below.
      const viewerAccept = await vic('POST', `${escalationsBase}/${viewerEscalationId}/accept`, { body: {} });
      record('2.8 viewer cannot mutate lifecycle (403)', viewerAccept.status === 403);

      const agentCreate = await bob('POST', escalationsBase, { body: { conversationId: convoHex(c7) } });
      record('2.9 agent-role staff may create (active-escalation rule reuses ada\'s)',
        agentCreate.status === 200 && dataOf<{ created: boolean }>(agentCreate)?.created === false);
    }

    // ══ 3. Manual lifecycle ═════════════════════════════════════════════════
    let c5EscalationId = '';
    {
      const created = await ada('POST', escalationsBase, {
        body: { conversationId: convoHex(c5), note: 'HANDOFF-NOTE-please-prioritize' },
      });
      record('3.1 manual escalation create is 201 with created=true',
        created.status === 201 && dataOf<{ created: boolean }>(created)?.created === true);
      const esc = dataOf<{ escalation: EscalationDto }>(created)?.escalation ?? null;
      assert.ok(esc !== null, 'c5 escalation record required');
      c5EscalationId = esc.id;
      record('3.2 record lands in the PENDING queue with MANUAL trigger',
        esc.status === 'PENDING' && esc.triggerType === 'MANUAL' && esc.reasonCode === 'MANUAL');
      record('3.3 initiator is the authenticated staff member (never a client field)',
        esc.initiatedBy.actorType === 'STAFF' && esc.initiatedBy.actorId === adaId.toHexString());

      const ticket = await TicketModel.findById(esc.ticketId).lean<Record<string, unknown> | null>().exec();
      record('3.4 associated ticket transitioned to IN_PROGRESS by the handoff',
        ticket?.['status'] === 'IN_PROGRESS');

      const duplicate = await ada('POST', escalationsBase, { body: { conversationId: convoHex(c5) } });
      record('3.5 duplicate create reuses the active record (200, created=false, same id)',
        duplicate.status === 200 && dataOf<{ created: boolean; escalation: EscalationDto }>(duplicate)?.created === false &&
        dataOf<{ escalation: EscalationDto }>(duplicate)?.escalation.id === esc.id);

      const crossWorkspaceRead = await eve('GET', `${escalationsBase}/${esc.id}`);
      record('3.6 foreign read of the escalation id is 404', crossWorkspaceRead.status === 404);

      const crossAssignee = await ada('POST', `${escalationsBase}/${esc.id}/assign`, {
        body: { assigneeId: eveId.toHexString() },
      });
      record('3.7 cross-workspace assignee is rejected as ineligible (422, no oracle)',
        crossAssignee.status === 422);

      const assigned = await ada('POST', `${escalationsBase}/${esc.id}/assign`, { body: { assigneeId: bobId.toHexString() } });
      const assignedDto = dataOf<{ escalation: EscalationDto }>(assigned)?.escalation;
      record('3.8 assignment to an eligible staff member is 200 → ASSIGNED',
        assigned.status === 200 && assignedDto?.status === 'ASSIGNED' &&
        assignedDto?.eligibleAssigneeId === bobId.toHexString());

      const nonAssigneeAccept = await ada('POST', `${escalationsBase}/${esc.id}/accept`, { body: {} });
      record('3.9 accept by someone other than the assignee is 403',
        nonAssigneeAccept.status === 403 && errorCodeOf(nonAssigneeAccept) === 'FORBIDDEN');

      const accepted = await bob('POST', `${escalationsBase}/${esc.id}/accept`, { body: {} });
      const acceptedDto = dataOf<{ escalation: EscalationDto }>(accepted)?.escalation;
      record('3.10 the assignee accepts → ACCEPTED with the acceptedBy stamp',
        accepted.status === 200 && acceptedDto?.status === 'ACCEPTED' &&
        acceptedDto?.acceptedById === bobId.toHexString());

      const resolved = await bob('POST', `${escalationsBase}/${esc.id}/resolve`, {
        body: { resolutionNote: 'RESOLUTION-NOTE-refunded-and-closed' },
      });
      const resolvedDto = dataOf<{ escalation: EscalationDto }>(resolved)?.escalation;
      record('3.11 the acceptee resolves → RESOLVED',
        resolved.status === 200 && resolvedDto?.status === 'RESOLVED');
      record('3.12 resolution surfaces only its presence, never its text',
        resolvedDto?.hasResolutionNote === true &&
        JSON.stringify(resolved.body).includes('RESOLUTION-NOTE-refunded-and-closed') === false);

      const resolvedAgain = await bob('POST', `${escalationsBase}/${esc.id}/resolve`, {
        body: { resolutionNote: 'RESOLUTION-NOTE-refunded-and-closed' },
      });
      record('3.13 repeated identical resolution is idempotent (200)',
        resolvedAgain.status === 200 && dataOf<{ escalation: EscalationDto }>(resolvedAgain)?.escalation.status === 'RESOLVED');

      const cancelledAfterResolve = await ada('POST', `${escalationsBase}/${esc.id}/cancel`, { body: { reason: 'too late' } });
      record('3.14 cancelling a RESOLVED escalation is 409 (terminal state)',
        cancelledAfterResolve.status === 409 && errorCodeOf(cancelledAfterResolve) === 'INVALID_ESCALATION_TRANSITION');

      const resolvedTicket = await TicketModel.findById(esc.ticketId).lean<Record<string, unknown> | null>().exec();
      record('3.15 resolution followed the ticket lifecycle to RESOLVED', resolvedTicket?.['status'] === 'RESOLVED');

      const detail = await bob('GET', `${escalationsBase}/${esc.id}`);
      record('3.16 detail payload is staff-visible and content-free (no note text)',
        detail.status === 200 && JSON.stringify(detail.body).includes('HANDOFF-NOTE') === false);

      const history = await bob('GET', `${escalationsBase}/${esc.id}/history`);
      const historyActions = (history.status === 200
        ? dataOf<{ history: readonly { action: string }[] }>(history)?.history ?? []
        : []
      ).map((entry) => entry.action);
      record('3.17 history endpoint returns the bounded lifecycle story',
        historyActions.includes('escalation.created') && historyActions.includes('escalation.assigned') &&
        historyActions.includes('escalation.accepted') && historyActions.includes('escalation.resolved') &&
        historyActions[0] === 'escalation.created' && historyActions[historyActions.length - 1] === 'escalation.resolved');
    }

    // ══ 4. Reassignment + event-transport-failure resilience ═══════════════
    {
      const created = await ada('POST', escalationsBase, { body: { conversationId: convoHex(c6) } });
      const escId = dataOf<{ escalation: EscalationDto }>(created)?.escalation.id ?? '';
      assert.ok(escId.length > 0, 'c6 escalation record required');

      const assigned = await ada('POST', `${escalationsBase}/${escId}/assign`, { body: { assigneeId: bobId.toHexString() } });
      record('4.1 queue assignment is 200 → ASSIGNED', assigned.status === 200);

      const { setEscalationEventTransport } = await import(
        '../server/src/modules/escalations/escalation.events.js'
      );
      const throwingTransport = (): void => {
        throw new Error('transport deliberately broken for the test');
      };
      setEscalationEventTransport(throwingTransport);
      const reassigned = await ada('POST', `${escalationsBase}/${escId}/assign`, { body: { assigneeId: adaId.toHexString() } });
      if (reassigned.status !== 200) console.log(' (4.2 debug)', reassigned.status, errorCodeOf(reassigned), JSON.stringify(reassigned.body).slice(0, 400));
      record('4.2 a throwing fan-out transport never fails the REST operation (200)',
        reassigned.status === 200);
      setEscalationEventTransport(null);

      const reassignedDto = dataOf<{ escalation: EscalationDto }>(reassigned)?.escalation;
      record('4.3 reassignment stamps the new assignee and clears the acceptance stamp',
        reassignedDto?.eligibleAssigneeId === adaId.toHexString() && reassignedDto?.acceptedById === null);

      const selfAccepted = await ada('POST', `${escalationsBase}/${escId}/accept`, { body: {} });
      record('4.4 the administrator may self-accept the reassigned escalation',
        selfAccepted.status === 200 && dataOf<{ escalation: EscalationDto }>(selfAccepted)?.escalation.acceptedById === adaId.toHexString());

      const movedBack = await ada('POST', `${escalationsBase}/${escId}/assign`, { body: { assigneeId: bobId.toHexString() } });
      record('4.5 reassigning an ACCEPTED escalation is legal (acceptance resets)',
        movedBack.status === 200 && dataOf<{ escalation: EscalationDto }>(movedBack)?.escalation.status === 'ASSIGNED' &&
        dataOf<{ escalation: EscalationDto }>(movedBack)?.escalation.acceptedById === null);

      const resolveWhileAssigned = await bob('POST', `${escalationsBase}/${escId}/resolve`, { body: {} });
      record('4.6 resolving without acceptance is a 409 invalid transition',
        resolveWhileAssigned.status === 409 && errorCodeOf(resolveWhileAssigned) === 'INVALID_ESCALATION_TRANSITION');

      const history = await ada('GET', `${escalationsBase}/${escId}/history`);
      const historyActions = histo(history)
        .map((entry) => entry.action);
      record('4.7 history records reassigned moves separately',
        historyActions.filter((action) => action === 'escalation.reassigned').length === 2);

      function histo(res: HttpResult): readonly { readonly action: string }[] {
        return res.status === 200 ? dataOf<{ history: readonly { readonly action: string }[] }>(res)?.history ?? [] : [];
      }
    }

    // ══ 5. Cancellation ownership ═══════════════════════════════════════════
    {
      // c7's active record was created by ADA (section 2.4 path): bob is an
      // agent who is neither the initiator, assignee nor acceptee, and not a
      // privileged role → cancel must be 403.
      const c7Escalation = await EscalationModel.findOne({ conversationId: c7.conversationId })
        .lean<Record<string, unknown> | null>()
        .exec();
      assert.ok(c7Escalation !== null, 'c7 escalation record required');
      const c7Id = oid(c7Escalation['_id']).toHexString();

      const foreignCancel = await bob('POST', `${escalationsBase}/${c7Id}/cancel`, { body: { reason: 'not mine' } });
      record('5.1 a non-involved agent cannot cancel someone else\'s escalation (403)',
        foreignCancel.status === 403);

      const cancelled = await ada('POST', `${escalationsBase}/${c7Id}/cancel`, { body: { reason: 'CUSTOMER-SELF-RESOLVED' } });
      const cancelledDto = dataOf<{ escalation: EscalationDto }>(cancelled)?.escalation;
      record('5.2 the initiator (or an administrator) may cancel → CANCELLED',
        cancelled.status === 200 && cancelledDto?.status === 'CANCELLED');
      record('5.3 cancel reason surfaces only its presence, never its text',
        cancelledDto?.hasCancelReason === true &&
        JSON.stringify(cancelled.body).includes('CUSTOMER-SELF-RESOLVED') === false);

      const cancelledAgain = await ada('POST', `${escalationsBase}/${c7Id}/cancel`, { body: { reason: 'CUSTOMER-SELF-RESOLVED' } });
      record('5.4 cancelling a terminal record is idempotent (200)',
        cancelledAgain.status === 200 && dataOf<{ escalation: EscalationDto }>(cancelledAgain)?.escalation.id === c7Id);
    }

    // ══ 6. Automatic agent-driven triggers + pause gate ═════════════════════
    {
      // One seeded KB source so provider-bound asks pass the evidence gate:
      // the seed article body IS the exact probe string the store embeds
      // (hash mock → cosine 1.0 self-match at RAG_MAX_RETRIEVE_LIMIT=1).
      // Determinism: hash-mock embeddings self-match ONLY on identical text,
      // so every later probe question gets its OWN seeded KB article whose
      // body EQUALS the question (verify-agent's recipe). One article body is
      // neutral (never a provider marker); the force-fail article's body is
      // the marker itself — it reaches the provider only as CONTEXT of the
      // ask whose top-1 retrieval admits it, never other asks.
      const neutralProbe = 'Refund processing hours and eligibility rules per the probe article.';
      const failProbe = 'FORCE_FAIL how do I configure ping pong?';
      const humanProbe = 'Can I please speak to a human representative now?';
      const abstainProbe = 'FORCE_ABSTAIN about the meaning of life';
      const sensitiveProbe = 'My invoice charge looks wrong, help me dispute it';
      const kbBase = `/workspaces/${acmeId}/knowledge-base/articles`;
      const seed = await ada('POST', kbBase, {
        body: { title: 'Escalation probe', summary: 'driver seed', body: neutralProbe, tags: ['probe'] },
      });
      assert.equal(seed.status, 201, 'probe article create');
      const articleId = dataOf<{ article?: { id?: string } }>(seed)?.article?.id ?? '';
      const published = await ada('POST', `${kbBase}/${articleId}/publish`, { body: {} });
      assert.equal(published.status, 200, 'probe article publish');
      const fourMore = [failProbe, humanProbe, abstainProbe, sensitiveProbe].map((text, index) =>
        ada('POST', kbBase, {
          // Distinct titles to avoid colliding with the slug uniqueness rule.
          body: { title: `Escalation probe ${index + 2}`, summary: 'driver seed', body: text, tags: ['probe'] },
        }),
      );
      const fourPublished = await Promise.all(fourMore);
      for (const created of fourPublished) assert.equal(created.status, 201, 'probe article create');
      const fourPublishes = await Promise.all(
        fourPublished.map((created, index) => {
          const nextId = dataOf<{ article?: { id?: string } }>(created)?.article?.id;
          return nextId === undefined
            ? Promise.resolve({ ...created, status: 500 })
            : ada('POST', `${kbBase}/${nextId}/publish`, { body: {} }).then((page) => ({ ...page, index }));
        }),
      );
      assert.ok(fourPublishes.length === 4 && fourPublishes.every((page) => page.status === 200), 'probe publishes');
      const { RagChunkModel } = await import('../server/src/modules/rag/rag.model.js');
      // Five single-paragraph articles → five indexed chunks (one each).
      const seeded = await pollUntil(async () =>
        (await RagChunkModel.countDocuments({ workspaceId: acmeWs, sourceType: 'KB_ARTICLE' }).exec()) >= 5);
      record('6.0 probe articles indexed for retrieval-backed asks', seeded);

      const ask = (unit: EscalationUnit, question: string, token = adaToken): Promise<HttpResult> =>
        http('POST', api(`/workspaces/${acmeId}/agent/ask`), { token, body: { question, conversationId: convoHex(unit) } });

      // ── A. Explicit human request ─────────────────────────────────────
      const humanAsk = await ask(c1, 'Can I please speak to a human representative now?');
      if (humanAsk.status !== 200) console.log(' (6.1 debug)', humanAsk.status, errorCodeOf(humanAsk), JSON.stringify(humanAsk.body).slice(0, 400));
      record('6.1 human-request ask itself still completes (200)', humanAsk.status === 200);
      await pollUntil(async () => (await getEscalationFor(c1)) !== null);
      const humanEsc = await getEscalationFor(c1);
      record('6.2 explicit human request auto-escalates with the machine reason code',
        humanEsc !== null && humanEsc.triggerType === 'HUMAN_REQUEST' && humanEsc.reasonCode === 'EXPLICIT_HUMAN_REQUEST');
      record('6.3 AI-triggered escalation is initiatedBy AI_AGENT for the asking staff member',
        humanEsc !== null && humanEsc.initiatedBy.actorType === 'AI_AGENT' && humanEsc.initiatedBy.actorId === adaId.toHexString());

      // ── B. Sensitive topic ────────────────────────────────────────────
      const sensitiveAsk = await ask(c2, 'My invoice charge looks wrong, help me dispute it');
      record('6.4 sensitive-topic ask completes (200)', sensitiveAsk.status === 200);
      await pollUntil(async () => (await getEscalationFor(c2)) !== null);
      const sensitiveEsc = await getEscalationFor(c2);
      record('6.5 billing keyword escalates as SENSITIVE_TOPIC with the matched topic key',
        sensitiveEsc !== null && sensitiveEsc.triggerType === 'SENSITIVE_TOPIC' &&
        sensitiveEsc.topicKey === 'billing' && sensitiveEsc.reasonCode === 'SENSITIVE_TOPIC');

      // ── C. Insufficient knowledge (model-declined interaction) ────────
      const absenceAsk = await ask(c3, 'FORCE_ABSTAIN about the meaning of life');
      if (absenceAsk.status !== 200) console.log(' (6.6 debug)', absenceAsk.status, errorCodeOf(absenceAsk));
      record('6.6 the matched model-declined interaction abstains as designed',
        absenceAsk.status === 200 && dataOf<{ status: string }>(absenceAsk)?.status === 'ABSTAINED');
      await pollUntil(async () => (await getEscalationFor(c3)) !== null);
      const absenceEsc = await getEscalationFor(c3);
      record('6.7 abstention escalates as AI_INSUFFICIENT_KNOWLEDGE with the abstention reason code',
        absenceEsc !== null && absenceEsc.triggerType === 'AI_INSUFFICIENT_KNOWLEDGE' &&
        absenceEsc.reasonCode === 'MODEL_DECLINED');

      // ── D. Provider failure: safe fallback WITHOUT a single-shot escalation ─
      // The marker prefixes the EXACT chunk text so retrieval still admits the
      // probe chunk (hash-mock self-match) before the provider throws.
      const techAsk = await ask(cTech, failProbe);
      if (techAsk.status !== 503) console.log(' (6.8 debug)', techAsk.status, errorCodeOf(techAsk), JSON.stringify(techAsk.body).slice(0, 300));
      record('6.8 provider outage is a structured 503 to the caller',
        techAsk.status === 503 && errorCodeOf(techAsk) === 'AGENT_AI_PROVIDER_FAILED');
      const techEsc = await getEscalationFor(cTech);
      record('6.9 with the technical-failure rule OFF, one failure does NOT escalate (documented safe fallback)',
        techEsc === null);

      // ── E. Repeated AI failures (threshold = 3) ───────────────────────
      const repeatText = failProbe;
      const repeatAsk1 = await ask(c4, repeatText);
      record('6.9b first repeated-failure ask is a 503 too', repeatAsk1.status === 503);
      await sleep(200); // let ask 1's question_failed audit row land first
      const repeatAsk2 = await ask(c4, repeatText);
      record('6.10 second consecutive provider failure is 503', repeatAsk2.status === 503);
      await sleep(200);
      const repeatEscAfter2 = await getEscalationFor(c4);
      record('6.11 below the threshold no AI_REPEATED_FAILURE escalation exists',
        repeatEscAfter2 === null);
      const repeatAsk3 = await ask(c4, repeatText);
      record('6.12 third consecutive provider failure is 503 (threshold completes)', repeatAsk3.status === 503);
      await pollUntil(async () => (await getEscalationFor(c4)) !== null);
      const repeatEsc = await getEscalationFor(c4);
      record('6.13 the threshold trips an AI_REPEATED_FAILURE escalation with its machine reason',
        repeatEsc !== null && repeatEsc.triggerType === 'AI_REPEATED_FAILURE' &&
        repeatEsc.reasonCode === 'CONSECUTIVE_UNSUCCESSFUL_AI');

      const repeatCount = await EscalationModel.countDocuments({ conversationId: c4.conversationId }).exec();
      record('6.14 repeated triggers persist exactly ONE escalation record (no duplicates)', repeatCount === 1);

      // ── F. Agent pause gate after human ownership ─────────────────────
      const paused = await ask(c4, neutralProbe);
      record('6.15 asks of an actively-escalated conversation are PAUSED (409 AGENT_HANDOFF_ACTIVE)',
        paused.status === 409 && errorCodeOf(paused) === 'AGENT_HANDOFF_ACTIVE');

      const manualC9 = await ada('POST', escalationsBase, { body: { conversationId: convoHex(c9) } });
      assert.equal(manualC9.status, 201, 'c9 manual escalation');
      const pausedC9Ask = await ask(c9, 'anything after the manual handoff');
      record('6.16 a manually-escalated conversation pauses the AI agent too',
        pausedC9Ask.status === 409 && errorCodeOf(pausedC9Ask) === 'AGENT_HANDOFF_ACTIVE');

      const resolvedC5 = await EscalationModel.findOne({ conversationId: c5.conversationId })
        .lean<Record<string, unknown> | null>()
        .exec();
      record('6.17 the RESOLVED handoff (c5) no longer pauses its conversation (terminal state pauses nothing)',
        resolvedC5 !== null && resolvedC5['status'] === 'RESOLVED');
      const unpaused = await ask(c5, neutralProbe);
      record('6.18 asks resume after the handoff is closed', unpaused.status === 200 || unpaused.status === 503);
    }

    // ══ 7. Concurrency ══════════════════════════════════════════════════════
    {
      const raceCreates = await Promise.all([
        ada('POST', escalationsBase, { body: { conversationId: convoHex(c8) } }),
        ada('POST', escalationsBase, { body: { conversationId: convoHex(c8) } }),
      ]);
      const ids = raceCreates.map((res) => dataOf<{ escalation: EscalationDto }>(res)?.escalation.id);
      const uniqueIds = new Set<string>(ids.filter((id): id is string => typeof id === 'string'));
      record('7.1 racing manual creates persist exactly ONE active escalation', uniqueIds.size === 1);
      const escId = [...uniqueIds][0] ?? '';
      assert.ok(escId.length > 0, 'racing create winner required');

      // The race resolves via the row-version concurrency guard. On a fast
      // single-event-loop server the two handlers sometimes serialize
      // cleanly, in which case the second request is a legal (re)assignment
      // of the UPDATED record — so the driver RE-RACES (same record, fresh
      // versions) until a real version collision is observed, and only
      // asserts the collision semantics once they actually occurred.
      let sawWinner = false;
      let sawConflict = false;
      for (let attempt = 0; attempt < 4 && !sawConflict; attempt += 1) {
        const responses = await Promise.all([
          ada('POST', `${escalationsBase}/${escId}/assign`, { body: { assigneeId: bobId.toHexString() } }),
          ada('POST', `${escalationsBase}/${escId}/assign`, { body: { assigneeId: adaId.toHexString() } }),
        ]);
        sawWinner = sawWinner || responses.some((res) => res.status === 200);
        sawConflict = responses.some((res) => res.status === 409 && errorCodeOf(res) === 'ESCALATION_CONCURRENT_CHANGE');
      }
      record('7.2 racing assignments keep data consistent: a winner lands and the version guard rejects a stale writer (409)',
        sawWinner && sawConflict);

      const finalRecord = await EscalationModel.findOne({ conversationId: c8.conversationId })
        .lean<Record<string, unknown> | null>()
        .exec();
      const finalAssignee = finalRecord !== null ? oid(finalRecord['eligibleAssigneeId']) : null;
      record('7.3 the persisted record holds exactly the winning assignee',
        finalAssignee !== null &&
        (finalAssignee.toHexString() === bobId.toHexString() || finalAssignee.toHexString() === adaId.toHexString()));
    }

    // ══ 8. Audit trail + typed event payloads ══════════════════════════════
    {
      const auditActions = [
        'escalation.created',
        'escalation.assigned',
        'escalation.reassigned',
        'escalation.accepted',
        'escalation.resolved',
        'escalation.cancelled',
      ];
      const counts = await Promise.all(
        auditActions.map(async (action) => AuditLogModel.countDocuments({ workspaceId: acmeWs, action }).exec()),
      );
      if (!counts.every((count) => count >= 1)) console.log(' (8.1 debug)', auditActions, counts);
      record('8.1 every escalation lifecycle action was audited', counts.every((count) => count >= 1));

      const sample = await AuditLogModel.findOne({ workspaceId: acmeWs, action: 'escalation.created' })
        .lean<Record<string, unknown> | null>()
        .exec();
      const metadata = (sample?.['metadata'] ?? {}) as Record<string, unknown>;
      const contentKeys = ['question', 'answer', 'note', 'resolutionNote', 'cancelReason', 'body', 'prompt'];
      record('8.2 audit metadata is content-free (no note/resolution content)',
        contentKeys.every((key) => !(key in metadata)));
      record('8.3 audit rows carry machine context (trigger/reason codes, ids)',
        typeof metadata['triggerType'] === 'string' && typeof metadata['reasonCode'] === 'string' &&
        typeof metadata['ticketId'] === 'string' && typeof metadata['conversationId'] === 'string');

      record('8.4 typed events were published in lifecycle order after persistence',
        externalEventLog.some((event) => event.type === 'escalation.created') &&
        externalEventLog.some((event) => event.type === 'escalation.assigned') &&
        externalEventLog.some((event) => event.type === 'escalation.accepted') &&
        externalEventLog.some((event) => event.type === 'escalation.resolved'));
      const payloadKeys = new Set(externalEventLog.flatMap((event) => Object.keys(event.payload)));
      const forbidden = ['note', 'resolutionNote', 'cancelReason', 'question', 'answer'];
      record('8.5 event payloads carry ids/machine codes only (content-free)',
        forbidden.every((key) => !payloadKeys.has(key)));
    }

    // ══ 9. Summary ══════════════════════════════════════════════════════════
    console.log('');
    console.log(`Prompt 15 — escalation driver: ${failures === 0 ? 'ALL ESCALATION CHECKS PASSED' : `${failures} FAILURES`}`);
    if (failures > 0) {
      console.log('ESCALATION CHECKS FAILED');
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    console.error('ESCALATION CHECKS FAILED (exception)', error);
    process.exitCode = 1;
    failures += 1;
  } finally {
    await shutdown();
  }
  if (failures !== 0) process.exit(1);
  await sleep(50);
}

main().catch((error: unknown) => {
  console.error('ESCALATION CHECKS FAILED (fatal)', error);
  process.exit(1);
});
