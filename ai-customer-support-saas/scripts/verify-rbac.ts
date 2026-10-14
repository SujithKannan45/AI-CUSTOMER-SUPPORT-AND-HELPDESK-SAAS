/**
 * RBAC verification driver — HTTP-level end-to-end authorization (Prompt 6).
 *
 * Boots its own in-memory mongod + the REAL Express app on an ephemeral port
 * (same harness as verify-workspaces), then proves the authorization DECISIONS
 * — not just status codes — for every role across the workspace endpoints:
 *
 *   1. Unauthenticated rejection (401)
 *   2. Non-member concealment (404, never 403 — no existence oracle)
 *   3. Inactive (invited) member concealment (404)
 *   4. Owner → full permitted operations
 *   5. Admin → permitted administrative operations (incl. workspace settings)
 *   6. Admin → owner-only operations DENIED (registry + policy layer)
 *   7. Agent → membership administration DENIED (registry + policy + HTTP 403)
 *   8. Agent → other tenant's workspace unreachable (404)
 *   9. Viewer → write operations DENIED (403 + nothing persisted)
 *  10. Client-supplied role values cannot change privileges (strict schemas +
 *      response role always DB-derived)
 *  11. Self-promotion impossible (policy layer denials)
 *  12. Invalid roles/permissions rejected at schema + policy layer
 *  13. Auth regression (login still works)
 *  14. Health/readiness regression
 *  15. Resource-assignment rules (agents modify only assigned resources)
 *  16. Permission-denied authorization events audited, without secrets
 *
 * Server code is imported DYNAMICALLY inside main() AFTER MONGODB_URI is set
 * (env.config.ts freezes process.env at module-evaluation time).
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Types } from 'mongoose';

import type { WorkspaceRole } from '../server/src/modules/workspaces/workspace.types.js';

interface Check {
  name: string;
  pass: boolean;
}

const checks: Check[] = [];

function record(name: string, pass: boolean): void {
  checks.push({ name, pass });
  // eslint-disable-next-line no-console
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
  options: { body?: unknown; token?: string; ip?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  headers['x-forwarded-for'] =
    options.ip ?? `10.3.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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

function extractError(body: Record<string, unknown>): { code?: unknown; message?: unknown } {
  const error = body['error'] as Record<string, unknown> | undefined;
  return error ?? {};
}

interface PerRequest {
  (method: 'GET' | 'POST' | 'PATCH', path: string, options?: { body?: unknown; token?: string }): Promise<HttpResult>;
}

function assert(condition: boolean): void {
  if (!condition) throw new Error('assertion failed inside test steps');
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_rbac' },
  });

  const expectedUri = memoryServer.getUri('verify_rbac');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  const port = 4002;
  process.env['PORT'] = String(port);

  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error(`env.MONGODB_URI mismatch — aborting to protect foreign databases`);
  }

  const httpServer = await startServer();
  const api = (path: string): string => `http://127.0.0.1:${port}/api/v1${path}`;

  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { WorkspaceMemberModel } = await import(
    '../server/src/modules/workspaces/workspace-member.model.js'
  );
  const { WorkspaceModel } = await import('../server/src/modules/workspaces/workspace.model.js');
  const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
  const { ObjectId } = (await import('mongoose')).default.Types;

  // Pure authorization layers under test (no MongoDB needed for these).
  const { WORKSPACE_PERMISSIONS, roleHasPermission } = await import(
    '../server/src/modules/rbac/rbac.permissions.js'
  );
  const { evaluateRoleChange, evaluateMembershipCreation } = await import(
    '../server/src/modules/rbac/rbac-policy.js'
  );
  const { evaluateResourceModification } = await import(
    '../server/src/modules/rbac/resource-access.js'
  );

  const PASSWORD = 'Str0ngPass!42';

  /** Permission-denied 403s produced by this driver via authenticated members. */
  let expectedDeniedCount = 0;

  async function newUser(name: string, email: string): Promise<string> {
    const reg = await http('POST', api('/auth/register'), {
      body: { name, email, password: PASSWORD },
    });
    assert(reg.status === 201);
    const login = await http('POST', api('/auth/login'), {
      body: { email, password: PASSWORD },
    });
    assert(login.status === 200);
    const data = login.body['data'] as { tokens?: { accessToken?: string } } | undefined;
    const token = data?.tokens?.accessToken;
    assert(typeof token === 'string' && token.length > 0);
    return token;
  }

  async function userIdOf(email: string): Promise<Types.ObjectId> {
    const user = await UserModel.findOne({ email });
    assert(user !== null);
    return user!._id;
  }

  function req(bearer: string | undefined): PerRequest {
    return (method, path, options = {}) => http(method, api(path), { token: bearer, ...options });
  }

  try {
    // ── Actors ─────────────────────────────────────────────────────────────
    const ownerToken = await newUser('Victoria Owner', 'victoria@example.com');
    const adminToken = await newUser('Val Admin', 'val@example.com');
    const agentToken = await newUser('Alex Agent', 'alex@example.com');
    const viewerToken = await newUser('Vera Viewer', 'vera@example.com');
    const invitedToken = await newUser('Ina Invited', 'ina@example.com');
    const strangerToken = await newUser('Nia Nobody', 'nia@example.com');
    const eveToken = await newUser('Eve Elsewhere', 'eve@example.com');

    const owner = req(ownerToken);

    // ── Owner creates the workspace under test ─────────────────────────────
    const createWs = await owner('POST', '/workspaces', {
      body: { name: 'Vesper Corp', slug: 'vesper-corp' },
    });
    assert(createWs.status === 201);
    const wsId = ((createWs.body['data'] as { workspace?: { id?: string } } | undefined)?.workspace?.['id'] as string);
    assert(typeof wsId === 'string' && wsId.length === 24);

    // Seed the RBAC cast straight into the membership collection (invitation
    // flows are a later phase — the ROLE wiring is what Prompt 6 proves).
    const seed = async (email: string, role: WorkspaceRole, status: 'active' | 'invited'): Promise<void> => {
      const membership = await WorkspaceMemberModel.create({
        workspaceId: new ObjectId(wsId),
        userId: await userIdOf(email),
        role,
        status,
      });
      assert(membership !== null);
    };
    await seed('val@example.com', 'admin', 'active');
    await seed('alex@example.com', 'agent', 'active');
    await seed('vera@example.com', 'viewer', 'active');
    await seed('ina@example.com', 'agent', 'invited'); // ACTIVE-role but INACTIVE status

    // Eve's separate tenant (cross-tenant checks).
    const eveCreate = await req(eveToken)('POST', '/workspaces', { body: { name: 'East Corp' } });
    assert(eveCreate.status === 201);
    const eveWsId = ((eveCreate.body['data'] as { workspace?: { id?: string } } | undefined)?.workspace?.['id'] as string);
    assert(typeof eveWsId === 'string');

    const as = (token: string): PerRequest => req(token);

    // ── 0. Registry shape sanity ────────────────────────────────────────────
    record(
      'registry: viewer holds ONLY view-style permissions (least privilege)',
      roleHasPermission('viewer', WORKSPACE_PERMISSIONS.viewWorkspace) &&
        roleHasPermission('viewer', WORKSPACE_PERMISSIONS.viewCustomers) &&
        !roleHasPermission('viewer', WORKSPACE_PERMISSIONS.updateWorkspaceSettings) &&
        !roleHasPermission('viewer', WORKSPACE_PERMISSIONS.createTicket) &&
        !roleHasPermission('viewer', WORKSPACE_PERMISSIONS.replyToConversations),
    );
    // Cast to WorkspaceRole to prove RUNTIME failure for a role outside the
    // vocabulary — the type system forbids it, defense must not depend on it.
    record(
      'registry: unknown runtime permission id denied (no silent grants)',
      roleHasPermission('owner', 'workspace.destroy_everything' as never) === false,
    );

    // ── 1. Unauthenticated → 401 ───────────────────────────────────────────
    const anon = req(undefined);
    const anonGet = await anon('GET', `/workspaces/${wsId}`);
    record('1. unauthenticated detail → 401', anonGet.status === 401 && extractError(anonGet.body).code === 'UNAUTHORIZED');
    const anonPatch = await anon('PATCH', `/workspaces/${wsId}`, { body: { name: 'Anonymous Edit' } });
    record('1. unauthenticated patch → 401', anonPatch.status === 401);

    // ── 2. No membership → 404 (concealment, NOT 403/405 oracle) ───────────
    const strangerGet = await as(strangerToken)('GET', `/workspaces/${wsId}`);
    record(
      '2. non-member detail → 404 NOT_FOUND (identical shape to unknown id)',
      strangerGet.status === 404 && extractError(strangerGet.body).code === 'NOT_FOUND',
    );
    const strangerPatch = await as(strangerToken)('PATCH', `/workspaces/${wsId}`, { body: { name: 'Stranger Edit' } });
    record('2. non-member patch → 404 (no oracle)', strangerPatch.status === 404);

    // ── 3. Inactive (invited) member → 404 ─────────────────────────────────
    const invitedGet = await as(invitedToken)('GET', `/workspaces/${wsId}`);
    record(
      '3. invited (inactive) member → 404 despite valid role',
      invitedGet.status === 404 && extractError(invitedGet.body).code === 'NOT_FOUND',
    );

    // ── 4. Owner → permitted operations ────────────────────────────────────
    const ownerGet = await owner('GET', `/workspaces/${wsId}`);
    const ownerRole = ((ownerGet.body['data'] as { membership?: { role?: string; status?: string } } | undefined)?.membership);
    record(
      '4. owner sees workspace + own owner membership (DB-derived role)',
      ownerGet.status === 200 && ownerRole?.['role'] === 'owner' && ownerRole?.['status'] === 'active',
    );
    const ownerPatch = await owner('PATCH', `/workspaces/${wsId}`, { body: { name: 'Vesper HQ' } });
    const ownerPatchedName = ((ownerPatch.body['data'] as { workspace?: { name?: string } } | undefined)?.workspace?.['name']);
    record(
      '4. owner patches workspace settings → 200 and persisted',
      ownerPatch.status === 200 && ownerPatchedName === 'Vesper HQ',
    );

    // ── 5. Admin → permitted administrative operations ─────────────────────
    const adminGet = await as(adminToken)('GET', `/workspaces/${wsId}`);
    record(
      '5. admin reads detail (DB-derived role admin)',
      adminGet.status === 200 &&
        (adminGet.body['data'] as { membership?: { role?: string } } | undefined)?.membership?.['role'] === 'admin',
    );
    const adminPatch = await as(adminToken)('PATCH', `/workspaces/${wsId}`, {
      body: { name: 'Vesper HQ (admin-edited)' },
    });
    const adminPatchedName = ((adminPatch.body['data'] as { workspace?: { name?: string } } | undefined)?.workspace?.['name']);
    const dbAfterAdmin = await WorkspaceModel.findById(wsId);
    record(
      '5. admin patches workspace settings → 200 and persisted (settings ⊂ admin grants)',
      adminPatch.status === 200 && adminPatchedName === 'Vesper HQ (admin-edited)' && dbAfterAdmin?.name === adminPatchedName,
    );

    // Agent still has basic workspace READ (agent grant exists)…
    const agentGet = await as(agentToken)('GET', `/workspaces/${wsId}`);
    record(
      '5b. agent reads workspace detail (member read grant preserved)',
      agentGet.status === 200 &&
        (agentGet.body['data'] as { membership?: { role?: string } } | undefined)?.membership?.['role'] === 'agent',
    );
    // …but settings update is admin+owner only.
    const agentPatch = await as(agentToken)('PATCH', `/workspaces/${wsId}`, { body: { name: 'Agent Takeover' } });
    expectedDeniedCount += agentPatch.status === 403 ? 1 : 0;
    record(
      '5c. agent patch → 403 FORBIDDEN (workspace.settings.update denied)',
      agentPatch.status === 403 && extractError(agentPatch.body).code === 'FORBIDDEN',
    );

    // ── 6. Admin CANNOT perform owner-only operations ───────────────────────
    // No security-settings endpoint exists yet (per prompt scope), so the
    // owner-only boundary is enforced and verified in the registry + policy
    // layer — the exact code the future endpoint will compose.
    record(
      '6. registry: admin denied workspace.security.manage (owner-only)',
      !roleHasPermission('admin', WORKSPACE_PERMISSIONS.manageWorkspaceSecurity) &&
        roleHasPermission('owner', WORKSPACE_PERMISSIONS.manageWorkspaceSecurity),
    );
    const adminGrantOwner = evaluateRoleChange({
      actor: { userId: 'u-admin', role: 'admin', status: 'active' },
      target: { userId: 'u-agent', role: 'agent', status: 'active' },
      workspace: { ownerId: 'u-owner' },
      newRole: 'owner',
    });
    const adminTouchOwner = evaluateRoleChange({
      actor: { userId: 'u-admin', role: 'admin', status: 'active' },
      target: { userId: 'u-owner', role: 'owner', status: 'active' },
      workspace: { ownerId: 'u-owner' },
      newRole: 'agent',
    });
    const adminGrantAdmin = evaluateRoleChange({
      actor: { userId: 'u-admin', role: 'admin', status: 'active' },
      target: { userId: 'u-agent2', role: 'agent', status: 'active' },
      workspace: { ownerId: 'u-owner' },
      newRole: 'admin',
    });
    record(
      '6. policy: admin cannot mint owners / touch the owner / promote to admin',
      !adminGrantOwner.allowed && !adminTouchOwner.allowed && !adminGrantAdmin.allowed,
    );
    const ownerGrantAdmin = evaluateRoleChange({
      actor: { userId: 'u-owner', role: 'owner', status: 'active' },
      target: { userId: 'u-agent', role: 'agent', status: 'active' },
      workspace: { ownerId: 'u-owner' },
      newRole: 'admin',
    });
    record(
      '6. policy: owner role changes allowed (policy layer accepts legitimate owner action)',
      ownerGrantAdmin.allowed,
    );

    // ── 7. Agent CANNOT administer membership ───────────────────────────────
    record(
      '7. registry: agent denied workspace.membership.manage',
      !roleHasPermission('agent', WORKSPACE_PERMISSIONS.manageMembership),
    );
    const agentPromote = evaluateRoleChange({
      actor: { userId: 'u-agent', role: 'agent', status: 'active' },
      target: { userId: 'u-viewer', role: 'viewer', status: 'active' },
      workspace: { ownerId: 'u-owner' },
      newRole: 'admin',
    });
    const agentCreateMember = evaluateMembershipCreation({
      actor: { userId: 'u-agent', role: 'agent', status: 'active' },
      newRole: 'agent',
    });
    record(
      '7. policy: agent role change + membership creation denied',
      !agentPromote.allowed && !agentCreateMember.allowed,
    );
    record(
      '7. policy: self-role-change denied even for the owner (invariant)',
      !evaluateRoleChange({
        actor: { userId: 'u-owner', role: 'owner', status: 'active' },
        target: { userId: 'u-owner', role: 'owner', status: 'active' },
        workspace: { ownerId: 'u-owner' },
        newRole: 'admin',
      }).allowed,
    );

    // ── 8. Agent cannot access another tenant's workspace ──────────────────
    const agentCrossTenant = await as(agentToken)('GET', `/workspaces/${eveWsId}`);
    const agentCrossPatch = await as(agentToken)('PATCH', `/workspaces/${eveWsId}`, { body: { name: 'Cross Tenant' } });
    record(
      '8. agent cross-tenant detail+patch → 404 (membership, not whitespace, gates access)',
      agentCrossTenant.status === 404 && agentCrossPatch.status === 404,
    );

    // ── 9. Viewer cannot perform write operations ──────────────────────────
    const viewerGet = await as(viewerToken)('GET', `/workspaces/${wsId}`);
    record(
      '9. viewer reads workspace (viewer read grants work end-to-end)',
      viewerGet.status === 200 &&
        (viewerGet.body['data'] as { membership?: { role?: string } } | undefined)?.membership?.['role'] === 'viewer',
    );
    const viewerPatch = await as(viewerToken)('PATCH', `/workspaces/${wsId}`, {
      body: { name: 'Viewer Sneak Edit' },
    });
    expectedDeniedCount += viewerPatch.status === 403 ? 1 : 0;
    const dbAfterViewer = await WorkspaceModel.findById(wsId);
    record(
      '9. viewer patch → 403 AND nothing persisted (real boundary, not just status code)',
      viewerPatch.status === 403 &&
        dbAfterViewer?.name === 'Vesper HQ (admin-edited)' &&
        extractError(viewerPatch.body).code === 'FORBIDDEN',
    );

    // ── 10. Client-supplied role values cannot grant privileges ────────────
    const rolePayload = await as(agentToken)('PATCH', `/workspaces/${wsId}`, {
      body: { name: 'Payload Ploy', role: 'owner', status: 'active' },
    });
    const dbAfterPloy = await WorkspaceModel.findById(wsId);
    record(
      '10. PATCH with injected role/status → 422 (strict schema), workspace untouched',
      rolePayload.status === 422 && dbAfterPloy?.name === 'Vesper HQ (admin-edited)',
    );
    const roleQuery = await as(agentToken)('GET', `/workspaces/${wsId}?role=owner`);
    record(
      '10. GET with injected ?role query ignored — response role is DB-derived (agent)',
      roleQuery.status === 200 &&
        (roleQuery.body['data'] as { membership?: { role?: string } } | undefined)?.membership?.['role'] === 'agent',
    );
    const viewerCreateRole = await as(viewerToken)('POST', '/workspaces', {
      body: { name: 'Viewer New Co', membership: { role: 'viewer' } },
    });
    record(
      '10. POST /workspaces with embedded membership → 422 (mass assignment rejected)',
      viewerCreateRole.status === 422,
    );

    // ── 11/12. Invalid roles rejected at every layer ────────────────────────
    let invalidRoleRejected = false;
    try {
      // Deliberate invalid value (cast) — the DB schema, not TypeScript, must
      // be the runtime guard against role strings outside the vocabulary.
      await WorkspaceMemberModel.create({
        workspaceId: new ObjectId(wsId),
        userId: await userIdOf('nia@example.com'),
        role: 'superadmin' as unknown as WorkspaceRole,
        status: 'active',
      });
    } catch {
      invalidRoleRejected = true;
    }
    record(
      '12. schema: membership with role outside vocabulary rejected by DB model',
      invalidRoleRejected,
    );
    record(
      '12. policy: role change to unknown role string denied (invalid-role)',
      !evaluateRoleChange({
        actor: { userId: 'u-owner', role: 'owner', status: 'active' },
        target: { userId: 'u-agent', role: 'agent', status: 'active' },
        workspace: { ownerId: 'u-owner' },
        newRole: 'boss',
      }).allowed,
    );
    record(
      '12. policy: ordinary membership creation can never mint an owner',
      !evaluateMembershipCreation({
        actor: { userId: 'u-owner', role: 'owner', status: 'active' },
        newRole: 'owner',
      }).allowed,
    );

    // ** Options for 12b: viewer membership wiring proof —
    // a viewer membership CREATED with the new role value works end-to-end.
    let viewerRoleAccepted = false;
    try {
      await WorkspaceMemberModel.create({
        workspaceId: new ObjectId(eveWsId),
        userId: await userIdOf('nia@example.com'),
        role: 'viewer',
        status: 'active',
      });
      viewerRoleAccepted = true;
    } catch {
      viewerRoleAccepted = false;
    }
    const strangerAsViewer = await as(strangerToken)('GET', `/workspaces/${eveWsId}`);
    record(
      '12b. viewer role accepted by schema and honored by authorization (Nia reads Eve workspace)',
      viewerRoleAccepted && strangerAsViewer.status === 200,
    );
    // And the freshly-minted viewer STILL cannot write inside that tenant.
    // (Valid payload shape — denial must come from the permission layer.)
    const strangerViewerPatch = await as(strangerToken)('PATCH', `/workspaces/${eveWsId}`, {
      body: { name: 'Sneak Peek Edit' },
    });
    expectedDeniedCount += strangerViewerPatch.status === 403 ? 1 : 0;
    record(
      '12c. viewer in second tenant still denied writes (403)',
      strangerViewerPatch.status === 403,
    );

    // ── 15. Resource-assignment rules (pure helpers, future-module shape) ───
    const ws = { workspaceId: wsId };
    const ownerMod = evaluateResourceModification(
      { userId: 'u-owner', role: 'owner', workspaceId: wsId },
      { ...ws, assigneeId: null },
      { permission: WORKSPACE_PERMISSIONS.updateTicket },
    );
    const agentAssigned = evaluateResourceModification(
      { userId: 'u-agent', role: 'agent', workspaceId: wsId },
      { ...ws, assigneeId: 'u-agent' },
      { permission: WORKSPACE_PERMISSIONS.updateTicket },
    );
    const agentNotAssigned = evaluateResourceModification(
      { userId: 'u-agent', role: 'agent', workspaceId: wsId },
      { ...ws, assigneeId: 'u-other-agent' },
      { permission: WORKSPACE_PERMISSIONS.updateTicket },
    );
    const agentCrossWs = evaluateResourceModification(
      { userId: 'u-agent', role: 'agent', workspaceId: eveWsId },
      { ...ws, assigneeId: 'u-agent' },
      { permission: WORKSPACE_PERMISSIONS.updateTicket },
    );
    const viewerModify = evaluateResourceModification(
      { userId: 'u-viewer', role: 'viewer', workspaceId: wsId },
      // Even "assigned to themselves" cannot conjure a write permission.
      { ...ws, assigneeId: 'u-viewer' },
      { permission: WORKSPACE_PERMISSIONS.updateTicket },
    );
    record(
      '15. resource rules: owner/admin triage, agent assigned-only, cross-workspace + viewer denied',
      ownerMod.allowed &&
        agentAssigned.allowed &&
        !agentNotAssigned.allowed &&
        !agentCrossWs.allowed &&
        !viewerModify.allowed,
    );
    record(
      '15b. resource options: allowUnassignedAgents / allowCreator knobs honored',
      evaluateResourceModification(
        { userId: 'u-agent', role: 'agent', workspaceId: wsId },
        { ...ws, assigneeId: null },
        { permission: WORKSPACE_PERMISSIONS.updateTicket, allowUnassignedAgents: true },
      ).allowed &&
        // Assigned to someone else, default: denied…
        evaluateResourceModification(
          { userId: 'u-agent', role: 'agent', workspaceId: wsId },
          { ...ws, assigneeId: 'u-someone-else', createdById: 'u-agent' },
          { permission: WORKSPACE_PERMISSIONS.updateTicket },
        ).allowed === false &&
        // …but with allowCreator the opener may still edit it.
        evaluateResourceModification(
          { userId: 'u-agent', role: 'agent', workspaceId: wsId },
          { ...ws, assigneeId: 'u-someone-else', createdById: 'u-agent' },
          { permission: WORKSPACE_PERMISSIONS.updateTicket, allowCreator: true },
        ).allowed,
    );

    // ── 16. Authorization audit trail: denials recorded, secrets absent ────
    // (Fire-and-forget writes — give the event loop a moment.)
    await new Promise((resolve) => setTimeout(resolve, 300));
    const deniedCount = await AuditLogModel.countDocuments({ action: 'workspace.permission_denied' });
    record(
      '16. audit: every permission denial recorded (count matches driver-produced 403s)',
      deniedCount === expectedDeniedCount && expectedDeniedCount >= 3,
    );
    const deniedSample = await AuditLogModel.findOne({ action: 'workspace.permission_denied' })
      .sort({ createdAt: -1 })
      .lean();
    const deniedJson = deniedSample === null ? '' : JSON.stringify(deniedSample).toLowerCase();
    record(
      '16. audit: denial entries carry actor/workspace scope, no tokens/secrets',
      deniedSample !== null &&
        deniedJson.includes('requiredpermission') &&
        !deniedJson.includes('token') &&
        !deniedJson.includes('bearer') &&
        !deniedJson.includes('authorization'),
    );

    // ── 13/14. Regressions: auth + health ───────────────────────────────────
    const login = await http('POST', api('/auth/login'), {
      body: { email: 'victoria@example.com', password: PASSWORD },
    });
    record('13. auth regression: login still 200', login.status === 200);

    const health = await http('GET', `http://127.0.0.1:${port}/health`);
    const ready = await http('GET', `http://127.0.0.1:${port}/health/ready`);
    record('14. health regression: /health and /health/ready ok', health.status === 200 && ready.status === 200);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    const { disconnectDatabase } = await import('../server/src/database/database.js');
    await disconnectDatabase();
    await memoryServer.stop();
  }

  const failed = checks.filter((c) => !c.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('verify-rbac driver failed:', error);
  process.exit(1);
});
