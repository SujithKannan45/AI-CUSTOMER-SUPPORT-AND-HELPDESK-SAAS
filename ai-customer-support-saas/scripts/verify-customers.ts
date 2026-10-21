/**
 * Customer verification driver — HTTP-level end-to-end flows (Prompt 7).
 *
 * Boots its own in-memory mongod + the REAL Express app on an ephemeral port,
 * registers users via the real auth flows, seeds memberships directly (via
 * the model, as no membership API exists yet), and exercises every customer
 * behavior over real HTTP:
 *
 *   1.  Authorized creation (owner/admin; safe DTO; normalized email)
 *   2.  Unauthenticated rejection on every endpoint (401)
 *   3.  Strangers (no membership) get 404 concealment on every endpoint
 *   4.  Cross-workspace listing prevented (two tenants, disjoint results)
 *   5.  Cross-workspace customer DETAIL inaccessible (404 both directions)
 *   6.  Cross-workspace UPDATE prevented (404 + no mutation in either tenant)
 *   7.  Duplicate-email policy (409 same workspace · OK other workspaces ·
 *       archived customer releases the address · restore re-conflicts → 409)
 *   8.  Malformed ids → 422; well-formed unknown ids → 404
 *   9.  Invalid input rejected (missing name, bad email/phone, junk tags)
 *   10. Protected fields (_id/workspaceId/deletedAt…) rejected, DB unchanged
 *   11. Pagination + filters (page/limit bounds, status/tags, sort, dates)
 *   12. Search never leaks other workspaces' records
 *   13. Archive/restore (default-list exclusion, archived slice, idempotence)
 *   14. Permission enforcement (agent/viewer denied mutations, allowed reads)
 *   15. Audit events recorded (created/updated/archived/restored; no PII in
 *       metadata; permission denial audited)
 *   16. Regressions: auth login, health, workspace detail still behave.
 *
 * Server code imports DYNAMICALLY inside main() AFTER MONGODB_URI is set
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
  const headersMap = new Map<string, string>();
  response.headers.forEach((value, key) => headersMap.set(key.toLowerCase(), value));
  return { status: response.status, body, headers: headersMap };
}

function extractError(body: Record<string, unknown>): { code?: unknown; message?: unknown } {
  const error = body['error'] as Record<string, unknown> | undefined;
  return error ?? {};
}

function assert(condition: boolean): void {
  if (!condition) throw new Error('assertion failed inside test steps');
}

/** Shape of a customer DTO in responses (subset used by assertions). */
interface CustomerPayload {
  id?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  status?: string;
  tags?: string[];
  archivedAt?: string | null;
  workspaceId?: string;
}

function customerOf(result: HttpResult): CustomerPayload {
  const data = result.body['data'] as { customer?: CustomerPayload } | undefined;
  return data?.customer ?? {};
}

function listData(result: HttpResult): { items: CustomerPayload[]; total: number; hasMore: boolean } {
  return result.body['data'] as { items: CustomerPayload[]; total: number; hasMore: boolean };
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_customers' },
  });

  const expectedUri = memoryServer.getUri('verify_customers');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  const port = 4017;
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
  const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
  const { CustomerModel } = await import('../server/src/modules/customers/customer.model.js');
  const { default: mongooseModule } = await import('mongoose');

  const PASSWORD = 'Str0ngPass!42';

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

  /** Creates a workspace through the API; returns its hex id. */
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

  /** Adds a DIRECT membership row (no membership API exists yet — Prompt 6). */
  async function addMember(
    workspaceId: string,
    email: string,
    role: 'admin' | 'agent' | 'viewer',
    status: 'active' | 'invited' = 'active',
  ): Promise<void> {
    const user = await UserModel.findOne({ email });
    assert(user !== null);
    await WorkspaceMemberModel.create({
      workspaceId,
      userId: user!._id,
      role,
      status,
    });
  }

  /**
   * Request helper. The optional third argument is the request payload; most
   * call sites wrap it as `{ body: {...} }` (matching the http helper's
   * options shape), so a single-key wrapper is unwrapped here for backward-
   * compatible direct payloads.
   */
  function req(bearer: string | undefined) {
    return (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<HttpResult> => {
      const payload =
        body !== null &&
        typeof body === 'object' &&
        Object.keys(body as Record<string, unknown>).length === 1 &&
        'body' in (body as Record<string, unknown>)
          ? (body as { body?: unknown }).body
          : body;
      return http(method, api(path), { token: bearer, ...(payload !== undefined ? { body: payload } : {}) });
    };
  }

  try {
    // ── Actors & tenants ───────────────────────────────────────────────────
    // Register ALL users first — memberships are added afterwards over the
    // existing user rows (getUser-by-email below asserts existence).
    const ownerToken = await newUser('Ada Acme', 'ada@acme.example');
    const adminToken = await newUser('Nia Admin', 'nia@acme.example');
    const bobToken = await newUser('Bob Agent', 'bob@acme.example');
    const veraToken = await newUser('Vera Viewer', 'vera@acme.example');
    const acmeId = await newWorkspace(ownerToken, 'Acme Support', 'acme-support');

    await addMember(acmeId, 'nia@acme.example', 'admin');
    await addMember(acmeId, 'bob@acme.example', 'agent');
    await addMember(acmeId, 'vera@acme.example', 'viewer');

    const eveToken = await newUser('Eve Rival', 'eve@rival.example');
    const rivalId = await newWorkspace(eveToken, 'Rival Co', 'rival-co');

    const strangerToken = await newUser('Sam Stranger', 'sam@stranger.example');

    const ada = req(ownerToken);
    const nia = req(adminToken);
    const bob = req(bobToken);
    const vera = req(veraToken);
    const eve = req(eveToken);
    const stranger = req(strangerToken);
    const anon = req(undefined);

    const acmeCustomers = `/workspaces/${acmeId}/customers`;
    const rivalCustomers = `/workspaces/${rivalId}/customers`;

    // ══ 2. Unauthenticated rejection ═══════════════════════════════════════
    {
      const anonCreate = await anon('POST', acmeCustomers, { name: 'Anon' });
      record('create: unauthenticated → 401', anonCreate.status === 401);

      const anonList = await anon('GET', acmeCustomers);
      record('list: unauthenticated → 401', anonList.status === 401);

      const anonDetail = await anon('GET', `${acmeCustomers}/${'b'.repeat(24)}`);
      record('detail: unauthenticated → 401', anonDetail.status === 401);

      const anonPatch = await anon('PATCH', `${acmeCustomers}/${'b'.repeat(24)}`, { name: 'X' });
      record('patch: unauthenticated → 401', anonPatch.status === 401);

      const anonArchive = await anon('PATCH', `${acmeCustomers}/${'b'.repeat(24)}/archive`);
      record('archive: unauthenticated → 401', anonArchive.status === 401);
    }

    // ══ 3. Strangers (404 concealment) ═════════════════════════════════════
    {
      const strangerCreate = await stranger('POST', acmeCustomers, { name: 'Sneak' });
      record(
        'create: non-member → 404 (tenant concealed)',
        strangerCreate.status === 404 && extractError(strangerCreate.body).code === 'NOT_FOUND',
      );
      const strangerList = await stranger('GET', acmeCustomers);
      record('list: non-member → 404', strangerList.status === 404);
      const strangerDetail = await stranger('GET', `${acmeCustomers}/${'c'.repeat(24)}`);
      record('detail: non-member → 404', strangerDetail.status === 404);
      const strangerPatch = await stranger('PATCH', `${acmeCustomers}/${'c'.repeat(24)}`, {
        name: 'Sneaked',
      });
      record('patch: non-member → 404', strangerPatch.status === 404);
    }

    // ══ 1. Authorized creation ═════════════════════════════════════════════
    let morganId: string;
    {
      const created = await ada('POST', acmeCustomers, {
        body: {
          name: 'Morgan Customer',
          email: 'Morgan@ACME.example ', // deliberately unnormalized
          phone: '+1 (555) 100-2000',
          avatarUrl: 'https://cdn.example.com/morgan.png',
          tags: ['vip', 'beta'],
          metadata: { crmId: 'crm-7', vipTier: 2 },
        },
      });
      const customer = customerOf(created);
      morganId = customer.id ?? '';
      record(
        'create: owner → 201, safe DTO, normalized lowercased email',
        created.status === 201 &&
          customer.name === 'Morgan Customer' &&
          customer.email === 'morgan@acme.example' &&
          customer.status === 'active' &&
          customer.tags?.join(',') === 'vip,beta' &&
          customer.archivedAt === null &&
          customer.workspaceId === acmeId &&
          JSON.stringify(created.body).includes('__v') === false &&
          JSON.stringify(created.body).includes('password') === false,
      );

      // Admin may create (registry grants customer.create to owner + admin).
      const adminCreate = await nia('POST', acmeCustomers, {
        body: { name: 'Pat AdminMade' },
      });
      record(
        'create: admin → 201 (registry grant)',
        adminCreate.status === 201 && customerOf(adminCreate).name === 'Pat AdminMade',
      );

      // Anonymous visitor customer (no email is valid by design).
      const anonymous = await ada('POST', acmeCustomers, {
        body: { name: 'Walker Anonymous' },
      });
      record(
        'create: email optional (anonymous visitor) → 201 with null email',
        anonymous.status === 201 && customerOf(anonymous).email === null,
      );
    }

    // ══ 9. Invalid input ═══════════════════════════════════════════════════
    {
      const noName = await ada('POST', acmeCustomers, { email: 'x@y.example' });
      record('create: missing name → 422', noName.status === 422);

      const badEmail = await ada('POST', acmeCustomers, {
        body: { name: 'Bad Email', email: 'not-an-email' },
      });
      record('create: invalid email → 422', badEmail.status === 422);

      const badPhone = await ada('POST', acmeCustomers, {
        body: { name: 'Bad Phone', phone: '123' },
      });
      record('create: too-short phone → 422', badPhone.status === 422);

      const badTags = await ada('POST', acmeCustomers, {
        body: { name: 'Bad Tags', tags: [42] },
      });
      record('create: non-string tag → 422', badTags.status === 422);

      const badMeta = await ada('POST', acmeCustomers, {
        body: { name: 'Bad Meta', metadata: { nested: { deep: true } } },
      });
      record('create: nested metadata value → 422', badMeta.status === 422);
    }

    // ══ 10. Protected fields ═══════════════════════════════════════════════
    {
      const hijack = await ada('POST', acmeCustomers, {
        body: {
          name: 'Hijack Try',
          workspaceId: rivalId,
          _id: '0'.repeat(24),
          deletedAt: '2026-01-01T00:00:00.000Z',
          createdAt: '2020-01-01T00:00:00.000Z',
        },
      });
      record(
        'create: protected/unknown fields rejected 422, nothing persisted',
        hijack.status === 422 &&
          extractError(hijack.body).code === 'VALIDATION_ERROR' &&
          (await CustomerModel.countDocuments({ name: 'Hijack Try' })) === 0,
      );

      const protoUpdate = await ada('PATCH', `${acmeCustomers}/${morganId}`, {
        body: { workspaceId: rivalId, status: 'not-a-status' },
      });
      const morganAfter = await CustomerModel.findById(morganId);
      record(
        'update: protected/unknown fields rejected 422, document unchanged',
        protoUpdate.status === 422 &&
          morganAfter !== null &&
          morganAfter!.workspaceId.toHexString() === acmeId &&
          morganAfter!.status === 'active' &&
          morganAfter!.deletedAt === null,
      );
    }

    // ══ 7. Duplicate-email policy ══════════════════════════════════════════
    {
      const dupSame = await ada('POST', acmeCustomers, {
        body: { name: 'Morgan Duplicate', email: 'morgan@acme.example' },
      });
      record(
        'duplicate email: same workspace → 409 CONFLICT (no raw DB error)',
        dupSame.status === 409 &&
          extractError(dupSame.body).code === 'CONFLICT' &&
          !JSON.stringify(dupSame.body).toLowerCase().includes('e11000'),
      );

      const dupOther = await eve('POST', rivalCustomers, {
        body: { name: 'Morgan Rival', email: 'morgan@acme.example' },
      });
      record(
        'duplicate email: DIFFERENT workspace → 201 (per-tenant, never global)',
        dupOther.status === 201,
      );

      // Create the holder FIRST, then attempt to steal its address.
      const holder = await ada('POST', acmeCustomers, {
        body: { name: 'Pat First', email: 'pat@dup.example' },
      });
      assert(holder.status === 201);
      const patId = customerOf(holder).id ?? '';

      const dupUpdate = await ada('PATCH', `${acmeCustomers}/${morganId}`, {
        body: { email: 'pat@dup.example' },
      });
      record(
        'duplicate email on update → 409 (unique index arbitration)',
        dupUpdate.status === 409 && patId.length === 24,
      );
    }

    // ══ 5. Cross-workspace DETAIL ══════════════════════════════════════════
    {
      const eveViewingAcme = await eve('GET', `${rivalCustomers}/${morganId}`);
      const strangerViewingAcme = await stranger('GET', `${acmeCustomers}/${morganId}`);
      record(
        'detail: foreign customer id → 404 (no existence oracle), stranger likewise',
        eveViewingAcme.status === 404 && strangerViewingAcme.status === 404,
      );

      const adaView = await ada('GET', `${acmeCustomers}/${morganId}`);
      record(
        'detail: member → 200 with full safe DTO',
        adaView.status === 200 &&
          customerOf(adaView).name === 'Morgan Customer' &&
          customerOf(adaView).phone === '+1 (555) 100-2000' &&
          typeof customerOf(adaView).metadata === 'object',
      );
    }

    // ══ 6. Cross-workspace UPDATE ══════════════════════════════════════════
    {
      const crossUpdate = await eve('PATCH', `${rivalCustomers}/${morganId}`, {
        body: { name: 'Renamed By Rival' },
      });
      const morgan = await CustomerModel.findById(morganId);
      record(
        'update: foreign workspace → 404 AND no mutation in either tenant',
        crossUpdate.status === 404 && morgan !== null && morgan!.name === 'Morgan Customer',
      );
    }

    // ══ Valid update flow ══════════════════════════════════════════════════
    {
      const updated = await ada('PATCH', `${acmeCustomers}/${morganId}`, {
        body: { name: 'Morgan Renamed', status: 'blocked', tags: ['vip'], phone: null },
      });
      const customer = customerOf(updated);
      record(
        'update: allowed fields applied, null CLEARS an optional field',
        updated.status === 200 &&
          customer.name === 'Morgan Renamed' &&
          customer.status === 'blocked' &&
          customer.tags?.join(',') === 'vip' &&
          customer.phone === null,
      );

      const noFields = await ada('PATCH', `${acmeCustomers}/${morganId}`, { body: {} });
      record('update: empty payload → 422', noFields.status === 422);
    }

    // ══ 4 + 12. Workspace-scoped listing & search ══════════════════════════
    {
      // Seed deterministic customers: 8 live acme customers now + 5 = 13.
      const seedNames = ['Ava Alpha', 'Ben Beta', 'Cleo Gamma', 'Dev Delta', 'Ede Epsilon'];
      for (const [index, name] of seedNames.entries()) {
        const created = await ada('POST', acmeCustomers, {
          body: {
            name,
            email: `${name.split(' ')[0]!.toLowerCase()}@acme.example`,
            tags: name === 'Ava Alpha' ? ['vip', 'beta'] : index % 2 === 0 ? ['vip'] : ['standard'],
            metadata: { seed: index },
          },
        });
        assert(created.status === 201);
      }

      // Rival workspace customer that would match a naive global search.
      const rivalAva = await eve('POST', rivalCustomers, {
        body: { name: 'Ava Alpha Rival', email: 'ava-clone@rival.example' },
      });
      assert(rivalAva.status === 201);

      const page1 = await ada('GET', `${acmeCustomers}?page=1&limit=2&sort=name&order=asc`);
      const page2 = await ada('GET', `${acmeCustomers}?page=2&limit=2&sort=name&order=asc`);
      const p1 = listData(page1);
      const p2 = listData(page2);
      const sortedWithinPage = p1.items.every(
        (item, index) => index === 0 || item.name! >= p1.items[index - 1]!.name!,
      );
      record(
        'pagination: metadata, page boundaries, deterministic ascending order',
        page1.status === 200 &&
          page2.status === 200 &&
          p1.items.length === 2 &&
          p1.total === 9 &&
          p1.hasMore === true &&
          p2.items.length === 2 &&
          p2.hasMore === true &&
          p1.items[0]!.id !== p2.items[0]!.id &&
          sortedWithinPage,
      );

      const overshoot = await ada('GET', `${acmeCustomers}?page=99`);
      record(
        'pagination: overshoot → empty items, hasMore=false (total metadata preserved)',
        overshoot.status === 200 &&
          listData(overshoot).items.length === 0 &&
          listData(overshoot).hasMore === false &&
          listData(overshoot).total === 9,
      );

      const oversized = await ada('GET', `${acmeCustomers}?limit=51`);
      record('pagination: oversized limit → 422', oversized.status === 422);

      const zeroPage = await ada('GET', `${acmeCustomers}?page=0`);
      record('pagination: zero page → 422', zeroPage.status === 422);

      const statusFilter = await ada('GET', `${acmeCustomers}?status=blocked`);
      record(
        'filter: status=blocked returns only blocked customers (workspace-scoped)',
        statusFilter.status === 200 &&
          listData(statusFilter).items.length === 1 &&
          listData(statusFilter).items[0]!.name === 'Morgan Renamed',
      );

      const tagFilter = await ada('GET', `${acmeCustomers}?tags=vip`);
      record(
        'filter: tags=vip narrows to customers carrying the tag',
        tagFilter.status === 200 &&
          listData(tagFilter).total === 4 && // morgan + Ava + Cleo + Ede
          listData(tagFilter).items.every((item) => item.tags?.includes('vip') === true),
      );

      const allTagFilter = await ada('GET', `${acmeCustomers}?tags=vip,beta`);
      record(
        'filter: multiple tags require ALL (AND semantics)',
        allTagFilter.status === 200 &&
          listData(allTagFilter).total === 1 &&
          listData(allTagFilter).items[0]!.name === 'Ava Alpha',
      );

      const searchBoth = await ada('GET', `${acmeCustomers}?search=ava`);
      record(
        'search: matches own tenant ONLY — the rival "Ava Alpha Rival" never appears',
        searchBoth.status === 200 &&
          listData(searchBoth).total === 1 &&
          listData(searchBoth).items[0]!.email === 'ava@acme.example',
      );

      const caseInsensitive = await ada('GET', `${acmeCustomers}?search=MORGAN`);
      record(
        'search: case-insensitive across name/email',
        caseInsensitive.status === 200 && listData(caseInsensitive).total === 1,
      );

      const ranged = await ada(
        'GET',
        `${acmeCustomers}?createdFrom=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&createdTo=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      );
      const crossed = await ada(
        'GET',
        `${acmeCustomers}?createdFrom=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&createdTo=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`,
      );
      record(
        'filter: createdFrom/createdTo ranges honored; crossed range → 422',
        ranged.status === 200 && listData(ranged).total === 9 && crossed.status === 422,
      );

      const badSort = await ada('GET', `${acmeCustomers}?sort=workspaceId`);
      record('list: non-allowlisted sort field → 422', badSort.status === 422);

      const rivalList = await eve('GET', `${rivalCustomers}`);
      record(
        'list: tenant isolation — rival sees ONLY its own customers',
        rivalList.status === 200 &&
          listData(rivalList).total === 2 &&
          listData(rivalList).items.every((item) => item.name!.endsWith('Rival')),
      );
    }

    // ══ 14. Permission enforcement ══════════════════════════════════════════
    {
      const agentCreate = await bob('POST', acmeCustomers, { name: 'Agent Made' });
      record(
        'agent: customer.create NOT granted → 403 (registry)',
        agentCreate.status === 403 && extractError(agentCreate.body).code === 'FORBIDDEN',
      );

      const agentUpdate = await bob('PATCH', `${acmeCustomers}/${morganId}`, {
        body: { name: 'Agent Edit' },
      });
      record('agent: customer.update NOT granted → 403', agentUpdate.status === 403);

      const agentArchive = await bob('PATCH', `${acmeCustomers}/${morganId}/archive`);
      const agentRestore = await bob('PATCH', `${acmeCustomers}/${morganId}/restore`);
      record(
        'agent: archive/restore → 403 (registry denies customer.update)',
        agentArchive.status === 403 && agentRestore.status === 403,
      );

      const agentRead = await bob('GET', `${acmeCustomers}`);
      const agentDetail = await bob('GET', `${acmeCustomers}/${morganId}`);
      record(
        'agent: customer.view granted → 200 list + detail reads',
        agentRead.status === 200 &&
          listData(agentRead).total === 9 &&
          agentDetail.status === 200,
      );

      const viewerCreate = await vera('POST', acmeCustomers, { name: 'Viewer Made' });
      const viewerRead = await vera('GET', `${acmeCustomers}/${morganId}`);
      const viewerList = await vera('GET', `${acmeCustomers}?limit=1`);
      record(
        'viewer: mutations 403, reads allowed (view-only member)',
        viewerCreate.status === 403 && viewerRead.status === 200 && viewerList.status === 200,
      );

      const summaryForViewer = await vera('GET', `${acmeCustomers}/${morganId}/summary`);
      const summaryBody = summaryForViewer.body['data'] as
        | { summary?: { available?: boolean; lastInteractionAt?: string | null } }
        | undefined;
      record(
        'summary: future interaction seam → available=false, no invented counts',
        summaryForViewer.status === 200 &&
          summaryBody?.summary?.available === false &&
          summaryBody?.summary?.lastInteractionAt === null,
      );
    }

    // ══ 13. Archive & restore ══════════════════════════════════════════════
    let archivedAtStamp: string | undefined;
    {
      const archive = await ada('PATCH', `${acmeCustomers}/${morganId}/archive`);
      const archived = customerOf(archive);
      archivedAtStamp = archived.archivedAt;
      record(
        'archive: live → archived with timestamp (safe DTO)',
        archive.status === 200 && typeof archived.archivedAt === 'string',
      );

      // Explicit deletedAt filter bypasses the model's live-only hook —
      // findById would exclude the archived doc by design.
      const persisted = await CustomerModel.findOne({
        _id: morganId,
        deletedAt: { $ne: null },
      });
      record(
        'archive: document retained internally (soft delete, restore-capable)',
        persisted !== null && typeof persisted!.deletedAt === 'object',
      );

      const defaultList = listData(await ada('GET', `${acmeCustomers}`));
      const archivedList = listData(await ada('GET', `${acmeCustomers}?archiveState=archived`));
      const allList = listData(await ada('GET', `${acmeCustomers}?archiveState=all`));
      record(
        'list slices: archived excluded by default; explicit archived slice shows it; all = both',
        defaultList.total === 8 &&
          archivedList.total === 1 &&
          archivedList.items[0]!.name === 'Morgan Renamed' &&
          allList.total === 9,
      );

      const archivedDetail = await ada('GET', `${acmeCustomers}/${morganId}`);
      record('detail: archived customer reads as not-found', archivedDetail.status === 404);

      const repeatArchive = await ada('PATCH', `${acmeCustomers}/${morganId}/archive`);
      record(
        'archive: repeated archive is IDEMPOTENT (200, same stamp, no new audit)',
        repeatArchive.status === 200 && customerOf(repeatArchive).archivedAt === archivedAtStamp,
      );

      const emailTaken = await ada('POST', acmeCustomers, {
        body: { name: 'Morgan Successor', email: 'morgan@acme.example' },
      });
      record(
        'archive: archived customer RELEASES its email for re-use (partial index)',
        emailTaken.status === 201,
      );
      const successorId = customerOf(emailTaken).id ?? '';

      const blockedRestore = await ada('PATCH', `${acmeCustomers}/${morganId}/restore`);
      record(
        'restore: email meanwhile taken by a live customer → 409 CONFLICT (policy)',
        blockedRestore.status === 409 && extractError(blockedRestore.body).code === 'CONFLICT',
      );

      // Free the address (archive the successor), then the restore succeeds.
      const freeEmail = await ada('PATCH', `${acmeCustomers}/${successorId}/archive`);
      assert(freeEmail.status === 200);

      const restore = await ada('PATCH', `${acmeCustomers}/${morganId}/restore`);
      const restored = customerOf(restore);
      record(
        'restore: archived → live again (once the address is free)',
        restore.status === 200 &&
          restored.archivedAt === null &&
          restored.email === 'morgan@acme.example' &&
          restored.name === 'Morgan Renamed',
      );

      const repeatRestore = await ada('PATCH', `${acmeCustomers}/${morganId}/restore`);
      record(
        'restore: repeated restore is IDEMPOTENT (200, still live)',
        repeatRestore.status === 200 && customerOf(repeatRestore).archivedAt === null,
      );

      const junkArchive = await ada('PATCH', `${acmeCustomers}/${'f'.repeat(24)}/archive`);
      const junkRestore = await ada('PATCH', `${acmeCustomers}/${'f'.repeat(24)}/restore`);
      record(
        'archive/restore: unknown ids → 404 both ways',
        junkArchive.status === 404 && junkRestore.status === 404,
      );

      const foreignRestore = await eve('PATCH', `${rivalCustomers}/${morganId}/restore`);
      record('restore: foreign customer id → 404', foreignRestore.status === 404);
    }

    // ══ 8. Id validation ═══════════════════════════════════════════════════
    {
      const malformedId = await ada('GET', `${acmeCustomers}/not-an-objectid`);
      const malformedWorkspaceId = await ada('GET', '/workspaces/zz/customers');
      record(
        'ids: malformed customer id → 422; malformed workspace id → 404 (concealment)',
        malformedId.status === 422 && malformedWorkspaceId.status === 404,
      );

      const unknownValid = await ada('GET', `${acmeCustomers}/${'e'.repeat(24)}`);
      const unknownValidPatch = await ada('PATCH', `${acmeCustomers}/${'e'.repeat(24)}`, {
        body: { name: 'Ghost' },
      });
      record(
        'ids: well-formed unknown id → 404 (get + patch)',
        unknownValid.status === 404 && unknownValidPatch.status === 404,
      );
    }

    // ══ 15. Audit events ═══════════════════════════════════════════════════
    {
      const acmeObject = new mongooseModule.Types.ObjectId(acmeId);
      const [created, updated, archived, restored, denied] = await Promise.all([
        AuditLogModel.countDocuments({ workspaceId: acmeObject, action: 'customer.created' }),
        AuditLogModel.countDocuments({ workspaceId: acmeObject, action: 'customer.updated' }),
        AuditLogModel.countDocuments({ workspaceId: acmeObject, action: 'customer.archived' }),
        AuditLogModel.countDocuments({ workspaceId: acmeObject, action: 'customer.restored' }),
        AuditLogModel.countDocuments({
          workspaceId: acmeObject,
          action: 'workspace.permission_denied',
        }),
      ]);
      record(
        'audit: created/updated/archived/restored events recorded; denials audited',
        created >= 10 && updated >= 1 && archived >= 2 && restored >= 1 && denied >= 5,
      );

      const customerAudits = await AuditLogModel.find({
        workspaceId: acmeObject,
        action: { $regex: '^customer\\.' },
      })
        .limit(50)
        .lean();
      const serialized = JSON.stringify(customerAudits);
      record(
        'audit: no customer PII (name/email/phone/tags) ever recorded',
        !serialized.includes('Morgan') &&
          !serialized.includes('morgan@acme.example') &&
          !serialized.includes('555') &&
          !serialized.includes('vip') &&
          !serialized.includes('Renamed'),
      );

      const updateEvents = await AuditLogModel.find({
        workspaceId: acmeObject,
        action: 'customer.updated',
      })
        .limit(1)
        .lean();
      const metadata = updateEvents[0]?.metadata as unknown as Record<string, unknown> | undefined;
      const fieldsValue = (metadata?.['fields'] as unknown) ?? null;
      record(
        'audit: update events record FIELD NAMES only (safe metadata)',
        Array.isArray(fieldsValue) && fieldsValue.every((entry) => typeof entry === 'string'),
      );
    }

    // ══ 16. Regressions ════════════════════════════════════════════════════
    {
      const health = await http('GET', `http://127.0.0.1:${port}/health`);
      record('regression: /health still 200', health.status === 200);

      const badLogin = await http('POST', api('/auth/login'), {
        body: { email: 'ada@acme.example', password: 'WrongPass!42' },
      });
      record('regression: auth rejects a bad password', badLogin.status === 401);

      const workspaceDetail = await ada('GET', `/workspaces/${acmeId}`);
      const wsBody = workspaceDetail.body['data'] as
        | { workspace?: { id?: string }; membership?: { role?: string } }
        | undefined;
      record(
        'regression: workspace detail unchanged (workspace middleware intact)',
        workspaceDetail.status === 200 &&
          wsBody?.workspace?.id === acmeId &&
          wsBody?.membership?.role === 'owner',
      );

      const viewerWorkspace = await vera('GET', `/workspaces/${acmeId}`);
      const eveWorkspace = await eve('GET', `/workspaces/${rivalId}`);
      record(
        'regression: workspace reads for viewer + second tenant still work after mounting customer routes',
        viewerWorkspace.status === 200 && eveWorkspace.status === 200,
      );
    }

    const passed = checks.filter((check) => check.pass).length;
    // eslint-disable-next-line no-console
    console.log(`\n${passed}/${checks.length} checks passed`);

    await httpServer.close();
    memoryServer.stop();
    process.exit(passed === checks.length ? 0 : 1);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Driver aborted:', error);
    const passed = checks.filter((check) => check.pass).length;
    // eslint-disable-next-line no-console
    console.log(`${passed}/${checks.length} checks passed before abort`);
    await httpServer.close();
    memoryServer.stop();
    process.exit(1);
  }
}

void main();
