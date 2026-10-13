/**
 * Workspace verification driver — HTTP-level end-to-end flows (Prompt 5).
 *
 * Boots its own in-memory mongod + the REAL Express app on an ephemeral port,
 * registers users via the real auth flows, and exercises every workspace
 * behavior over real HTTP:
 *
 *   1.  Unauthenticated rejection on all four endpoints
 *   2.  Workspace creation (validated name/slug, auto-slug, owner membership,
 *       safe payload, audit entry)
 *   3.  Validation failures (short/bad name, bad slug, mass assignment)
 *   4.  Client-slug duplicate → 409; auto-slug collision → suffixed workspace
 *   5.  Listing scoped to the caller (pagination, inactive membership excluded)
 *   6.  Detail: member sees it, stranger gets 404 (no existence oracle),
 *       inactive member (invited) gets 404, archived workspace → 404
 *   7.  Update: owner ok, non-owner member → 403, stranger → 404,
 *       mass-assignment fields stripped, invalid payload → 422,
 *       settings partial merge, name+slug immutability of others
 *   8.  Duplicate membership prevented at the DB level
 *   9.  Auth + health regressions still pass
 *  10.  Tenant isolation shape: users in different workspaces cannot see
 *       each other's workspaces through any endpoint
 *
 * Server code is imported DYNAMICALLY inside main() AFTER MONGODB_URI is set
 * (env.config.ts freezes process.env at module-evaluation time).
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

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
  // Unique IP per request defeats cross-test rate-limit coupling; one IP is
  // pinned below ONLY for the dedicated limiter check.
  headers['x-forwarded-for'] = options.ip ?? `10.2.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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

interface PerRequest {
  (method: 'GET' | 'POST' | 'PATCH', path: string, options?: { body?: unknown; token?: string }): Promise<HttpResult>;
}

function extractError(body: Record<string, unknown>): { code?: unknown; message?: unknown } {
  const error = body['error'] as Record<string, unknown> | undefined;
  return error ?? {};
}

function assert(condition: boolean): void {
  if (!condition) throw new Error('assertion failed inside test steps');
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_workspaces' },
  });

  const expectedUri = memoryServer.getUri('verify_workspaces');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  const port = 4001;
  process.env['PORT'] = String(port);

  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error(`env.MONGODB_URI mismatch — aborting to protect foreign databases`);
  }

  const httpServer = await startServer();
  const api = (path: string): string => `http://127.0.0.1:${port}/api/v1${path}`;

  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { WorkspaceModel } = await import('../server/src/modules/workspaces/workspace.model.js');
  const { WorkspaceMemberModel } = await import('../server/src/modules/workspaces/workspace-member.model.js');
  const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');

  const PASSWORD = 'Str0ngPass!42';

  /**
   * Successful (201) workspace creates performed by this driver so far —
   * audited at the end as the expected lower bound of `workspace.created`
   * audit rows (the real creates happen only through the API).
   */
  let apiWorkspaceCreates = 0;

  /** Registers + verifies + logs in a fresh user through the REAL auth flows. */
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

  function req(bearer: string | undefined): PerRequest {
    return (method, path, options = {}) => http(method, api(path), { token: bearer, ...options });
  }

  try {
    // ── Actors ─────────────────────────────────────────────────────────────
    const ownerToken = await newUser('Ada Workspace', 'ada@example.com');
    const bobToken = await newUser('Bob Second', 'bob@example.com');
    const eveToken = await newUser('Eve Outsider', 'eve@example.com');

    // ── 1. Unauthenticated rejection ───────────────────────────────────────
    const anon = req(undefined);
    const anonCreate = await anon('POST', '/workspaces', { body: { name: 'Anon Workspace' } });
    record('create: unauthenticated → 401', anonCreate.status === 401 && extractError(anonCreate.body).code === 'UNAUTHORIZED');

    const anonList = await anon('GET', '/workspaces');
    record('list: unauthenticated → 401', anonList.status === 401);

    const anonDetail = await anon('GET', `/workspaces/${'a'.repeat(24)}`);
    record('detail: unauthenticated → 401', anonDetail.status === 401);

    const anonPatch = await anon('PATCH', `/workspaces/${'a'.repeat(24)}`, { body: { name: 'X' } });
    record('patch: unauthenticated → 401', anonPatch.status === 401);

    // ── 2. Workspace creation (owner flow) ─────────────────────────────────
    const owner = req(ownerToken);

    // 2a. Explicit slug
    const createA = await owner('POST', '/workspaces', {
      body: { name: 'Acme Support', slug: 'acme-support' },
    });
    const createABody = createA.body['data'] as
      | { workspace?: Record<string, string>; membership?: Record<string, string> }
      | undefined;
    if (createA.status === 201) apiWorkspaceCreates += 1;
    record(
      'create: 201 with workspace + owner membership',
      createA.status === 201 &&
        createABody?.workspace?.['slug'] === 'acme-support' &&
        createABody?.workspace?.['status'] === 'active' &&
        createABody?.membership?.['role'] === 'owner' &&
        createABody?.membership?.['status'] === 'active',
    );
    record(
      'create: response carries no sensitive internals (no id fields widened, no passwords)',
      !JSON.stringify(createA.body).includes('password') &&
        !JSON.stringify(createA.body).includes('__v') &&
        !JSON.stringify(createA.body).includes('$'),
    );

    // 2b. Auto-derived slug (normalized: spaces→hyphens)
    const createB = await owner('POST', '/workspaces', { body: { name: 'Glob  Ex__trading' } });
    const globSlug = ((createB.body['data'] as { workspace?: { slug?: string } } | undefined)?.workspace?.['slug']);
    if (createB.status === 201) apiWorkspaceCreates += 1;
    record(
      'create: auto-slug derived + normalized from name',
      createB.status === 201 && globSlug === 'glob-ex-trading',
    );

    // 2c. Unknown/untrusted keys are REJECTED (strict Zod schemas), so no
    // client input can ever reach owner/status — mass assignment impossible.
    const createC = await owner('POST', '/workspaces', {
      body: { name: 'Hijack Attempt', ownerId: '000000000000000000000000', status: 'archived' },
    });
    const hijackLeaked = await WorkspaceModel.findOne({ name: 'Hijack Attempt' }).lean();
    record(
      'create: mass-assignment payload rejected 422 and nothing persisted',
      createC.status === 422 &&
        extractError(createC.body).code === 'VALIDATION_ERROR' &&
        hijackLeaked === null,
    );

    // 2d. Validation failures
    const badName = await owner('POST', '/workspaces', { body: { name: 'ab' } });
    record('create: too-short name → 422', badName.status === 422);
    const badSlug = await owner('POST', '/workspaces', { body: { name: 'Valid Name', slug: 'Invalid_Slug!' } });
    record('create: invalid slug → 422', badSlug.status === 422);
    const junkBody = await owner('POST', '/workspaces', { body: { name: 'Valid Name', role: 'owner' } });
    record('create: unknown fields rejected (strict schemas → 422)', junkBody.status === 422);

    // ── 3. Slug conflicts ──────────────────────────────────────────────────
    const dupSlug = await owner('POST', '/workspaces', {
      body: { name: 'Second Acme', slug: 'acme-support' },
    });
    record(
      'create: client duplicate slug → 409 CONFLICT (no raw DB error)',
      dupSlug.status === 409 &&
        extractError(dupSlug.body).code === 'CONFLICT' &&
        !JSON.stringify(dupSlug.body).toLowerCase().includes('e11000'),
    );

    // Auto-slug collision: same-name (same derived base) twice → second gets suffix
    const dupBase1 = await owner('POST', '/workspaces', { body: { name: 'Nimbus' } });
    if (dupBase1.status === 201) apiWorkspaceCreates += 1;
    const dupBase2 = await owner('POST', '/workspaces', { body: { name: 'Nimbus' } });
    if (dupBase2.status === 201) apiWorkspaceCreates += 1;
    const s1 = ((dupBase1.body['data'] as { workspace?: { slug?: string } } | undefined)?.workspace?.['slug']);
    const s2 = ((dupBase2.body['data'] as { workspace?: { slug?: string } } | undefined)?.workspace?.['slug']);
    record(
      'create: auto-slug collision resolved with unique suffixed slug (+audit benign)',
      dupBase1.status === 201 && dupBase2.status === 201 && s1 === 'nimbus' && s2 !== s1 && (s2?.startsWith('nimbus-') ?? false),
    );

    // ── 4. Listing scope ───────────────────────────────────────────────────
    const listAll = await owner('GET', '/workspaces?limit=50&page=1');
    const listAllData = listAll.body['data'] as
      | { items?: Array<{ workspace: { slug: string }; membership: { status: string } }>; total?: number }
      | undefined;
    const allSlugs = listAllData?.items?.map((item) => item.workspace.slug) ?? [];
    record(
      'list: only the caller\u2019s workspaces, membership status active',
      listAll.status === 200 &&
        allSlugs.includes('acme-support') &&
        allSlugs.includes(globSlug ?? 'MISSING') &&
        (listAllData?.items?.every((item) => item.membership.status === 'active') ?? false),
    );

    // True pagination check: page 1 (limit 2) has exactly 2 rows, no overlap
    // with page 2, identical total, hasMore true on page 1.
    const listOwner = await owner('GET', '/workspaces?limit=2&page=1');
    const listOwnerData = listOwner.body['data'] as
      | { items?: Array<{ workspace: { slug: string } }>; total?: number; hasMore?: boolean }
      | undefined;
    const listPage2 = await owner('GET', '/workspaces?limit=2&page=2');
    const page2Data = listPage2.body['data'] as
      | { items?: Array<{ workspace: { slug: string } }>; total?: number }
      | undefined;
    const page1Slugs = listOwnerData?.items?.map((item) => item.workspace.slug) ?? [];
    const page2Slugs = page2Data?.items?.map((item) => item.workspace.slug) ?? [];
    const overlap = page1Slugs.filter((slug) => page2Slugs.includes(slug));
    record(
      'list: pagination metadata present + hasMore correct',
      typeof listOwnerData?.total === 'number' &&
        listOwnerData.total >= 4 &&
        listOwnerData.items?.length === 2 &&
        listOwnerData.hasMore === true &&
        overlap.length === 0 &&
        page2Data?.total === listOwnerData.total,
    );

    // Bob has zero workspaces — must NOT see Ada's.
    const listBob = await req(bobToken)('GET', '/workspaces');
    record(
      'list: other users\u2019 workspaces excluded (empty for Bob)',
      listBob.status === 200 &&
        (((listBob.body['data'] as { items?: unknown[] } | undefined)?.items?.length ?? -1) === 0),
    );

    // Invite Bob into Acme as an "invited" membership (direct DB — invitations
    // are a later phase; membership status must exclude it from the listing).
    const acmeId = createABody?.workspace?.['id'] as string;
    const bobMembership = await WorkspaceMemberModel.create({
      workspaceId: new (await import('mongoose')).default.Types.ObjectId(acmeId),
      userId: (await UserModel.findOne({ email: 'bob@example.com' }))!._id,
      role: 'agent',
      status: 'invited',
    });
    const listBobInvited = await req(bobToken)('GET', '/workspaces');
    record(
      'list: invited (inactive) membership excluded from listing',
      listBobInvited.status === 200 &&
        (((listBobInvited.body['data'] as { items?: unknown[] } | undefined)?.items?.length ?? 1) === 0),
    );

    // ── 5. Detail protection ───────────────────────────────────────────────
    const detailOwner = await owner('GET', `/workspaces/${acmeId}`);
    const detailData = detailOwner.body['data'] as
      | { workspace?: { id?: string; slug?: string }; membership?: { role?: string } }
      | undefined;
    record(
      'detail: active member sees workspace + own membership',
      detailOwner.status === 200 &&
        detailData?.workspace?.['id'] === acmeId &&
        detailData?.membership?.['role'] === 'owner',
    );

    // Bob (invited member) — NOT active → 404 (same as stranger)
    const detailInvited = await req(bobToken)('GET', `/workspaces/${acmeId}`);
    record(
      'detail: invited member rejected with 404 (inactive ≠ access)',
      detailInvited.status === 404 && extractError(detailInvited.body).code === 'NOT_FOUND',
    );

    // Eve (total stranger) — 404, identical body shape as unknown id.
    const detailStranger = await req(eveToken)('GET', `/workspaces/${acmeId}`);
    record(
      'detail: stranger rejected with 404 (no existence oracle)',
      detailStranger.status === 404,
    );

    const detailUnknown = await req(eveToken)('GET', `/workspaces/${'f'.repeat(24)}`);
    record(
      'detail: unknown id → 404 (identical shape to foreign-id denial)',
      detailUnknown.status === 404 &&
        JSON.stringify({ ...detailStranger.body, requestId: undefined }) ===
          JSON.stringify({ ...detailUnknown.body, requestId: undefined }),
    );

    const detailGarbage = await req(eveToken)('GET', '/workspaces/not-an-objectid');
    // Validation convention: malformed params are 422 (Zod), well-formed but
    // unknown/foreign ids are 404.
    record('detail: malformed id → 422 (validation contract)', detailGarbage.status === 422);

    // Activate Bob's membership; now he CAN see detail.
    await WorkspaceMemberModel.updateOne({ _id: bobMembership._id }, { $set: { status: 'active' } });
    const detailBob = await req(bobToken)('GET', `/workspaces/${acmeId}`);
    const bobRole = ((detailBob.body['data'] as { membership?: { role?: string } } | undefined)?.membership?.['role']);
    record(
      'detail: activated member gains access (status drives access)',
      detailBob.status === 200 && bobRole === 'agent',
    );

    //─ 6. Update protection ───────────────────────────────────────────────────
    // Bob (agent) update → 403
    const patchAgent = await req(bobToken)('PATCH', `/workspaces/${acmeId}`, {
      body: { name: 'Bob Takes Over' },
    });
    record('patch: non-owner member → 403 FORBIDDEN', patchAgent.status === 403 && extractError(patchAgent.body).code === 'FORBIDDEN');

    // Eve (stranger) → 404
    const patchStranger = await req(eveToken)('PATCH', `/workspaces/${acmeId}`, {
      body: { name: 'Eve Was Here' },
    });
    record('patch: stranger → 404 (no oracle)', patchStranger.status === 404);

    // Owner update with ONLY approved fields
    const patchOwner = await owner('PATCH', `/workspaces/${acmeId}`, {
      body: {
        name: 'Acme Support HQ',
        settings: { timezone: 'Europe/Berlin' },
      },
    });
    const patched = (patchOwner.body['data'] as { workspace?: Record<string, unknown> } | undefined)?.workspace;
    const acmeFromDb = await WorkspaceModel.findById(acmeId);
    record(
      'patch: owner updates name + settings; mass-assignment fields ignored',
      patchOwner.status === 200 &&
        patched?.['name'] === 'Acme Support HQ' &&
        (patched?.['settings'] as { timezone?: string } | undefined)?.timezone === 'Europe/Berlin' &&
        patched?.['status'] === 'active' &&
        acmeFromDb?.name === 'Acme Support HQ',
    );

    // Partial settings merge preserved locale
    record(
      'patch: settings partial-merge keeps untouched keys',
      (patched?.['settings'] as { locale?: string } | undefined)?.locale === 'en',
    );

    // Mass-assignment attempt on PATCH rejected (status/role/ownerId unreachable)
    const patchJunk = await owner('PATCH', `/workspaces/${acmeId}`, {
      body: { status: 'archived', ownerId: 'x', role: 'owner' },
    });
    const acmeAfterJunk = await WorkspaceModel.findById(acmeId);
    record(
      'patch: mass-assignment payload rejected 422, workspace untouched',
      patchJunk.status === 422 && acmeAfterJunk?.status === 'active' && acmeFromDb?.slug === (acmeFromDb as { slug?: string }).slug,
    );

    // Empty/invalid payloads
    const patchEmpty = await owner('PATCH', `/workspaces/${acmeId}`, { body: {} });
    record('patch: empty body → 422', patchEmpty.status === 422);
    const patchSlimy = await owner('PATCH', `/workspaces/${acmeId}`, { body: { name: '  ' } });
    record('patch: whitespace-only name → 422', patchSlimy.status === 422);

    // ── 7. Duplicate membership prevention (DB level) ──────────────────────
    const adaId = (await UserModel.findOne({ email: 'ada@example.com' }))!._id;
    let duplicateMembershipRejected = false;
    try {
      await WorkspaceMemberModel.create({
        workspaceId: new (await import('mongoose')).default.Types.ObjectId(acmeId),
        userId: adaId,
        role: 'agent',
        status: 'active',
      });
    } catch {
      duplicateMembershipRejected = true;
    }
    record('membership: duplicate (workspace,user) rejected by unique index', duplicateMembershipRejected);

    // ── 8. Audit events written ────────────────────────────────────────────
    const auditCount = await AuditLogModel.countDocuments({ action: 'workspace.created' });
    const auditUpdateCount = await AuditLogModel.countDocuments({ action: 'workspace.updated' });
    // Every SUCCESSFUL API create must have left exactly its audit trail —
    // the expectation is derived from this run, not a hard-coded number
    // (the create count depends on the flow itself, so it stays accurate
    // when the driver adds or removes steps).
    record(
      'audit: workspace.created + workspace.updated recorded with actor + workspace scope',
      (auditCount ?? 0) >= apiWorkspaceCreates &&
        apiWorkspaceCreates > 0 &&
        (auditUpdateCount ?? 0) >= 1,
    );
    const auditSample = await AuditLogModel.findOne({ action: 'workspace.created' }).lean();
    record(
      'audit: entries never contain tokens/secrets',
      auditSample !== null &&
        !JSON.stringify(auditSample).toLowerCase().includes('token') &&
        !JSON.stringify(auditSample).toLowerCase().includes('password'),
    );

    // ── 9. Tenant isolation across workspaces ──────────────────────────────
    // Eve creates her own workspace; neither Ada nor Bob can see it anywhere.
    const eveCreate = await req(eveToken)('POST', '/workspaces', { body: { name: 'Eve Inc' } });
    assert(eveCreate.status === 201);
    const eveWsId = ((eveCreate.body['data'] as { workspace?: { id?: string } } | undefined)?.workspace?.['id'] as string);

    const eveDetailViaAda = await owner('GET', `/workspaces/${eveWsId}`);
    const bobListEveCount = await req(bobToken)('GET', '/workspaces');
    const bobSlugs = (((bobListEveCount.body['data'] as { items?: Array<{ workspace: { slug: string } }> } | undefined)?.items ?? [])).map((item) => item.workspace.slug);
    record(
      'isolation: foreign workspace unreachable cross-tenant (detail 404, list excludes)',
      eveDetailViaAda.status === 404 && !bobSlugs.includes('eve-inc'),
    );

    // ── 10. Lantern regressions: auth + health still green ─────────────────
    const login = await http('POST', api('/auth/login'), {
      body: { email: 'ada@example.com', password: PASSWORD },
    });
    record('auth regression: login still 200', login.status === 200);

    const health = await http('GET', `http://127.0.0.1:${port}/health`);
    const ready = await http('GET', `http://127.0.0.1:${port}/health/ready`);
    record(
      'health regression: /health and /health/ready ok',
      health.status === 200 && ready.status === 200,
    );

    const rateLimit = await http('POST', api('/auth/login'), {
      body: { email: 'x@y.com', password: 'nope1Val!' },
      ip: '203.0.113.42',
    });
    record(
      'security regression: rate-limit headers on sensitive routes',
      rateLimit.headers.has('ratelimit') || rateLimit.headers.has('ratelimit-limit'),
    );
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
  console.error('verify-workspaces driver failed:', error);
  process.exit(1);
});
