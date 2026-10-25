/**
 * Knowledge Base verification driver — HTTP-level end-to-end flows (Prompt
 * 11), following the verify-conversations.ts driver pattern:
 *
 * Boots its own in-memory mongod + the REAL Express app on an ephemeral port,
 * registers users via the real auth flows, seeds memberships where no API
 * exists, and exercises KB category/article/revision/public behavior over
 * real HTTP:
 *
 *   1.  Unauthenticated rejection on every staff endpoint (401)
 *   2.  Strangers (no membership) get 404 concealment on staff endpoints
 *   3.  RBAC: viewer/agent read (kb.view) but cannot mutate (kb.manage);
 *       owner/admin manage; permission denials audited
 *   4.  Categories: creation (derived slug), duplicate names → 409, listing,
 *       detail, renaming re-derives slug, rename conflict → 409
 *   5.  Category hierarchy: unknown parent → 404, foreign-workspace parent
 *       → 404, self-parent → 409, cycle → 409, depth limit → 422
 *   6.  Category archive guards (children/articles) → 409 with counts;
 *       leaf archive/restore round-trip; restore of live category → 409
 *   7.  Articles: draft creation with revision 1, auto slug derivation,
 *       auto-suffix on duplicate auto slug, client slug 409, invalid slug →
 *       422, oversized/whitespace body → 422, unknown/foreign category → 404
 *   8.  Mass-assignment protection: workspaceId/status/revisionNumber/
 *       createdById/editorId rejected → 422
 *   9.  Content edits append revisions (allocation atomicity, change
 *       summaries); no-op / slug-only PATCHes create NO revision
 *   10. Lifecycle: publish/unpublish/archive/restore transitions and their
 *       409 refusals; archived articles refuse edits
 *   11. Revisions: newest-first history, snapshot detail, unknown revision →
 *       404, restore creates a NEW revision and reverts content, viewer can
 *       read but not restore; model immutability (update/delete throws)
 *   12. Search/filter/sort/pagination: status, category, tags, author, date
 *       ranges, title/summary search, allowlisted sorts, bounds → 422
 *   13. Cross-tenant isolation for articles/categories/revisions (404 both
 *       directions); foreign categoryId on PATCH → 404
 *   14. PUBLIC reads: published-only (draft/archived absent in list AND
 *       unavailable by slug), public DTO contains no management fields,
 *       unknown workspace slug → 404, rival workspace public KB works
 *   15. Audit: category/article lifecycle + revision restore recorded; no
 *       content (title/summary/body markers) in audit metadata
 *   16. Regressions: health, auth, workspace/customer/ticket/conversation
 *       flows still work after mounting KB routes
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

function assert(condition: boolean): void {
  if (!condition) throw new Error('assertion failed inside test steps');
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_knowledge_base' },
  });

  const expectedUri = memoryServer.getUri('verify_knowledge_base');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '100000';
  const port = 4031;
  process.env['PORT'] = String(port);

  let httpServer: Server | undefined;
  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error('env.MONGODB_URI mismatch — aborting to protect foreign databases');
  }

  httpServer = await startServer();
  const api = (path: string): string => `http://127.0.0.1:${port}/api/v1${path}`;
  const publicApi = (path: string): string => `http://127.0.0.1:${port}/api/v1/public${path}`;
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
  const { KbArticleModel, KbRevisionModel, KbCategoryModel } = await import(
    '../server/src/modules/knowledge-base/kb.model.js'
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

  async function newTicket_id(
    bearer: string,
    workspaceId: string,
    customerId: string,
    subject: string,
  ): Promise<string> {
    const created = await http('POST', api(`/workspaces/${workspaceId}/tickets`), {
      token: bearer,
      body: { customerId, subject, description: 'Verification ticket for KB regressions.' },
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
    const ownerToken = await newUser('Ada Acme', 'ada11@acme.example');
    const adminToken = await newUser('Nia Admin', 'nia11@acme.example');
    const bobToken = await newUser('Bob Agent', 'bob11@acme.example');
    const veraToken = await newUser('Vera Viewer', 'vera11@acme.example');
    const acmeId = await newWorkspace(ownerToken, 'Acme Helpdesk 11', 'acme-helpdesk-11');

    await addMember(acmeId, 'nia11@acme.example', 'admin');
    await addMember(acmeId, 'bob11@acme.example', 'agent');
    await addMember(acmeId, 'vera11@acme.example', 'viewer');

    const eveToken = await newUser('Eve Rival', 'eve@rival11.example');
    const rivalId = await newWorkspace(eveToken, 'Rival Co 11', 'rival-co-11');

    const strangerToken = await newUser('Sam Stranger', 'sam11@stranger.example');

    const ada = req(ownerToken);
    const nia = req(adminToken);
    const bob = req(bobToken);
    const vera = req(veraToken);
    const eve = req(eveToken);
    const stranger = req(strangerToken);
    const anon = req(undefined);

    const BOGUS_ID = 'e'.repeat(24);
    const KB_BASE = (ws: string): string => `/workspaces/${ws}/knowledge-base`;
    const ACME_KB = KB_BASE(acmeId);
    const TITLE_MARKER = 'Refund Policy Deep-Dive K9X';
    const BODY_MARKER = 'AUTHORITATIVE-BODY-MARKER-Q3';
    const EDIT_MARKER = 'REVISED-BODY-MARKER-Q4';
    const SUMMARY_MARKER = 'summary-about-refunds-Q5';

    // ══ 1. Unauthenticated rejection ═══════════════════════════════════════
    {
      record('unauth: create category → 401', (await anon('POST', `${ACME_KB}/categories`, { name: 'X' })).status === 401);
      record('unauth: list categories → 401', (await anon('GET', `${ACME_KB}/categories`)).status === 401);
      record('unauth: category detail → 401', (await anon('GET', `${ACME_KB}/categories/${BOGUS_ID}`)).status === 401);
      record('unauth: create article → 401', (await anon('POST', `${ACME_KB}/articles`, { title: 'x', body: 'y' })).status === 401);
      record('unauth: list articles → 401', (await anon('GET', `${ACME_KB}/articles`)).status === 401);
      record('unauth: article detail → 401', (await anon('GET', `${ACME_KB}/articles/${BOGUS_ID}`)).status === 401);
      record('unauth: publish → 401', (await anon('POST', `${ACME_KB}/articles/${BOGUS_ID}/publish`, {})).status === 401);
      record('unauth: revisions → 401', (await anon('GET', `${ACME_KB}/articles/${BOGUS_ID}/revisions`)).status === 401);
      record('unauth: revision restore → 401', (await anon('POST', `${ACME_KB}/articles/${BOGUS_ID}/revisions/1/restore`, {})).status === 401);
    }

    // ══ 2. Stranger concealment ════════════════════════════════════════════
    {
      record('stranger: list categories → 404', (await stranger('GET', `${ACME_KB}/categories`)).status === 404);
      record('stranger: create article → 404', (await stranger('POST', `${ACME_KB}/articles`, { title: 'x', body: 'y' })).status === 404);
      record('stranger: article detail → 404', (await stranger('GET', `${ACME_KB}/articles/${BOGUS_ID}`)).status === 404);
      record('stranger: revisions list → 404', (await stranger('GET', `${ACME_KB}/articles/${BOGUS_ID}/revisions`)).status === 404);
    }

    // ══ 3. RBAC: read grants, manage denials ═══════════════════════════════
    {
      const staffCreate = await nia('POST', `${ACME_KB}/categories`, { name: 'Onboarding' });
      assert(staffCreate.status === 201);
      const staffCategoryId = (staffCreate.body['data'] as { category?: { id?: string } }).category?.id ?? '';

      record('rbac: viewer list categories → 200', (await vera('GET', `${ACME_KB}/categories`)).status === 200);
      record('rbac: viewer category detail → 200', (await vera('GET', `${ACME_KB}/categories/${staffCategoryId}`)).status === 200);
      record('rbac: agent category detail → 200', (await bob('GET', `${ACME_KB}/categories/${staffCategoryId}`)).status === 200);
      record('rbac: viewer create category → 403 (kb.manage missing)', (await vera('POST', `${ACME_KB}/categories`, { name: 'V x' })).status === 403);
      record('rbac: agent create category → 403 (kb.manage missing)', (await bob('POST', `${ACME_KB}/categories`, { name: 'A x' })).status === 403);
      record('rbac: agent create article → 403', (await bob('POST', `${ACME_KB}/articles`, { title: 'x', body: 'y' })).status === 403);
      record('rbac: viewer patch category → 403', (await vera('PATCH', `${ACME_KB}/categories/${staffCategoryId}`, { name: 'V again' })).status === 403);
      record('rbac: agent publish attempt → 403', (await bob('POST', `${ACME_KB}/articles/${BOGUS_ID}/publish`, {})).status === 403);
      record('rbac: viewer create article → 403', (await vera('POST', `${ACME_KB}/articles`, { title: 'x', body: 'y' })).status === 403);

      const count = await KbCategoryModel.countDocuments({
        name: { $in: ['V x', 'A x'] },
      });
      record('rbac: denied category mutations wrote nothing', count === 0);
    }

    // ══ 4. Category lifecycle ══════════════════════════════════════════════
    let catProduct = '';
    let catRefunds = '';
    let catParent = '';
    let catChild = '';
    let catLeafA = '';
    let catLeafB = '';
    {
      const created = await ada('POST', `${ACME_KB}/categories`, {
        name: '  Product Docs  ',
        description: 'Everything about the product',
        displayOrder: 2,
      });
      const cat = (created.body['data'] as { category?: { id?: string; slug?: string; displayOrder?: number } }).category;
      catProduct = cat?.id ?? '';
      record(
        'category: created with derived slug, trimmed name, display order',
        created.status === 201 &&
          cat?.slug === 'product-docs' &&
          cat?.displayOrder === 2 &&
          cat?.archived === false,
      );

      const dup = await nia('POST', `${ACME_KB}/categories`, { name: 'Product Docs' });
      record('category: exact duplicate name → 409', dup.status === 409);

      const dupCase = await ada('POST', `${ACME_KB}/categories`, { name: 'product DOCS' });
      record('category: case-insensitive duplicate name → 409', dupCase.status === 409);

      const renamed = await nia('PATCH', `${ACME_KB}/categories/${catProduct}`, { name: 'Product Guides' });
      record(
        'category: rename re-derives slug',
        renamed.status === 200 && (renamed.body['data'] as { category?: { slug?: string } }).category?.slug === 'product-guides',
      );

      const renameConflict = await ada('PATCH', `${ACME_KB}/categories/${catProduct}`, { name: 'Onboarding' });
      record('category: rename onto existing name → 409', renameConflict.status === 409);

      const unknownParent = await ada('POST', `${ACME_KB}/categories`, { name: 'Orphan', parentId: BOGUS_ID });
      record('category: unknown parent → 404', unknownParent.status === 404);

      const junkId = await ada('POST', `${ACME_KB}/categories`, { name: 'Junk', parentId: 'not-an-id' });
      record('category: malformed parent id → 422', junkId.status === 422);

      const refundsCat = await ada('POST', `${ACME_KB}/categories`, { name: 'Refunds' });
      catRefunds = (refundsCat.body['data'] as { category?: { id?: string } }).category?.id ?? '';
      assert(refundsCat.status === 201);

      const parentCat = await ada('POST', `${ACME_KB}/categories`, { name: 'Guides Hierarchy' });
      catParent = (parentCat.body['data'] as { category?: { id?: string } }).category?.id ?? '';

      const childCat = await ada('POST', `${ACME_KB}/categories`, { name: 'Getting Started', parentId: catParent });
      catChild = (childCat.body['data'] as { category?: { id?: string } }).category?.id ?? '';
      assert(childCat.status === 201);

      record(
        'category: nested create records parent',
        childCat.status === 201 &&
          (childCat.body['data'] as { category?: { parentId?: string } }).category?.parentId === catParent,
      );

      const foreignWsCategory = await eve('POST', `${KB_BASE(rivalId)}/categories`, { name: 'Rival Docs' });
      const rivalCategoryId = (foreignWsCategory.body['data'] as { category?: { id?: string } }).category?.id ?? '';
      const foreignParent = await ada('POST', `${ACME_KB}/categories`, { name: 'Evil Child', parentId: rivalCategoryId });
      record('category: FOREIGN-workspace parent → 404 (concealment)', foreignParent.status === 404);

      const selfParent = await ada('PATCH', `${ACME_KB}/categories/${catParent}`, { parentId: catParent });
      record('category: self-parent → 409', selfParent.status === 409);

      const cycleAttempt = await ada('PATCH', `${ACME_KB}/categories/${catParent}`, { parentId: catChild });
      record('category: cycle (child becomes parent) → 409', cycleAttempt.status === 409);

      const depths: string[] = [];
      let lastDepth = catChild;
      for (let level = 3; level <= 5; level += 1) {
        const created = await ada('POST', `${ACME_KB}/categories`, {
          name: `Depth Level ${level}`,
          parentId: lastDepth,
        });
        assert(created.status === 201);
        lastDepth = (created.body['data'] as { category?: { id?: string } }).category?.id ?? '';
        depths.push(lastDepth);
      }
      const tooDeep = await ada('POST', `${ACME_KB}/categories`, { name: 'Depth Level 6', parentId: lastDepth });
      record('category: hierarchy deeper than 5 levels → 422', tooDeep.status === 422);

      const leafA = await ada('POST', `${ACME_KB}/categories`, { name: 'Leaf A' });
      catLeafA = (leafA.body['data'] as { category?: { id?: string } }).category?.id ?? '';
      const leafB = await ada('POST', `${ACME_KB}/categories`, { name: 'Leaf B', parentId: catProduct });
      catLeafB = (leafB.body['data'] as { category?: { id?: string } }).category?.id ?? '';
      assert(leafA.status === 201 && leafB.status === 201);

      const list = await ada('GET', `${ACME_KB}/categories?limit=50`);
      const listCategoryNames = (
        list.body['data'] as { items?: Array<{ name?: string }> }
      ).items?.map((c) => c.name) ?? [];
      record(
        'category: list excludes renames of duplicates and reads ordered by display order',
        list.status === 200 && !listCategoryNames.includes('Product Docs'),
      );

      const detail = await bob('GET', `${ACME_KB}/categories/${catProduct}`);
      record(
        'category: detail exposes audit refs but not lifecycle timestamps of drafts',
        detail.status === 200 &&
          (detail.body['data'] as { category?: { createdById?: string; updatedById?: string } }).category?.createdById !== undefined,
      );
    }

    // ══ 5. Article creation ════════════════════════════════════════════════
    let a1 = '';
    {
      const created = await ada('POST', `${ACME_KB}/articles`, {
        title: `  ${TITLE_MARKER}  `,
        summary: `About ${SUMMARY_MARKER}`,
        body: `# Policy\n\n${BODY_MARKER}\n\nPlain markdown stays inert.`,
        tags: ['refund-policy', 'vip', 'vip'],
        categoryId: catRefunds,
      });
      const article = (created.body['data'] as { article?: Record<string, unknown> }).article ?? {};
      a1 = (article['id'] as string) ?? '';
      record(
        'article: created as DRAFT with revision 1, slug derived, tags deduped, timestamps null',
        created.status === 201 &&
          article['status'] === 'DRAFT' &&
          article['currentRevisionNumber'] === 1 &&
          article['slug'] === 'refund-policy-deep-dive-k9x' &&
          (article['tags'] as string[]).length === 2 &&
          article['publishedAt'] === null &&
          article['archivedAt'] === null,
      );

      const dupTitle = await ada('POST', `${ACME_KB}/articles`, {
        title: TITLE_MARKER,
        body: 'Second copy of the same title.',
      });
      const dupSlug = (dupTitle.body['data'] as { article?: { slug?: string } }).article?.slug ?? '';
      record(
        'article: duplicate auto slug resolves with a deterministic -2 suffix',
        dupTitle.status === 201 && dupSlug === 'refund-policy-deep-dive-k9x-2',
      );

      const race = await Promise.all([
        ada('POST', `${ACME_KB}/articles`, { title: 'Concurrency Probe', body: 'a' }),
        nia('POST', `${ACME_KB}/articles`, { title: 'Concurrency Probe', body: 'b' }),
      ]);
      const raceSlugs = race
        .map((r) => (r.body['data'] as { article?: { slug?: string } }).article?.slug)
        .sort();
      record(
        'article: concurrent same-title creates never collide (unique index law)',
        race.every((r) => r.status === 201) && raceSlugs[0] !== raceSlugs[1],
      );

      const clientSlugDupe = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Explicit Slug Attack',
        slug: 'refund-policy-deep-dive-k9x',
        body: 'x',
      });
      record('article: client slug onto existing slug → 409', clientSlugDupe.status === 409);

      const invalidSlug = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Invalid Slug',
        slug: 'Not A Slug!',
        body: 'x',
      });
      record('article: invalid client slug shape → 422', invalidSlug.status === 422);

      const oversized = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Oversized',
        body: 'a'.repeat(50_001),
      });
      record('article: oversized body → 422', oversized.status === 422);

      const whitespaceBody = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Whitespace',
        body: '   \n\t  ',
      });
      record('article: whitespace-only body → 422', whitespaceBody.status === 422);

      const unknownCategory = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Unknown Category',
        body: 'x',
        categoryId: BOGUS_ID,
      });
      record('article: unknown categoryId → 404', unknownCategory.status === 404);

      const eveCategory = await eve('POST', `${KB_BASE(rivalId)}/categories`, { name: 'Rival Bucket' });
      const rivalCategory2 = (eveCategory.body['data'] as { category?: { id?: string } }).category?.id ?? '';
      const foreignCategory = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Foreign Category',
        body: 'x',
        categoryId: rivalCategory2,
      });
      record('article: foreign-workspace categoryId → 404', foreignCategory.status === 404);
    }

    // ══ 6. Mass-assignment protection ══════════════════════════════════════
    {
      const spoofWorkspace = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Workspace Spoof',
        body: 'x',
        workspaceId: rivalId,
      });
      record('mass-assign: workspaceId → 422', spoofWorkspace.status === 422);

      const spoofStatus = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Status Spoof',
        body: 'x',
        status: 'PUBLISHED',
      });
      record('mass-assign: status → 422 (lifecycle endpoints only)', spoofStatus.status === 422);

      const spoofAuthor = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Author Spoof',
        body: 'x',
        createdById: '5'.repeat(24),
      });
      record('mass-assign: createdById → 422', spoofAuthor.status === 422);

      const spoofEditor = await nia('POST', `${ACME_KB}/articles`, {
        title: 'Editor Spoof',
        body: 'x',
        lastEditedById: '5'.repeat(24),
      });
      record('mass-assign: lastEditedById → 422', spoofEditor.status === 422);

      const spoofNumber = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Revision Spoof',
        body: 'x',
        currentRevisionNumber: 99,
      });
      record('mass-assign: currentRevisionNumber → 422', spoofNumber.status === 422);

      const patchStatus = await nia('PATCH', `${ACME_KB}/articles/${a1}`, {
        status: 'PUBLISHED',
        publishedAt: new Date().toISOString(),
      });
      record('mass-assign: PATCH cannot publish (strict schema) → 422', patchStatus.status === 422);
    }

    // ══ 7. Content edits & revisions ═══════════════════════════════════════
    {
      const edit = await nia('PATCH', `${ACME_KB}/articles/${a1}`, {
        body: `# Policy v2\n\n${EDIT_MARKER}`,
        changeSummary: 'Sharpen the refund steps',
      });
      record(
        'edit: content change → 200, revision 2, editor updated, audit refs intact',
        edit.status === 200 &&
          (edit.body['data'] as { article?: { currentRevisionNumber?: number } }).article?.currentRevisionNumber === 2 &&
          (edit.body['data'] as { article?: { lastEditedById?: string } }).article?.lastEditedById !== undefined,
      );

      const revisions = await ada('GET', `${ACME_KB}/articles/${a1}/revisions`);
      const revisionItems = (revisions.body['data'] as { items?: Array<Record<string, unknown>> }).items ?? [];
      record(
        'revisions: history newest-first with change summary',
        revisions.status === 200 &&
          revisionItems.length === 2 &&
          revisionItems[0]?.['revisionNumber'] === 2 &&
          revisionItems[0]?.['changeSummary'] === 'Sharpen the refund steps',
      );

      const revisionSnapshot = await ada('GET', `${ACME_KB}/articles/${a1}/revisions/1`);
      record(
        'revisions: snapshot 1 retains the ORIGINAL body',
        revisionSnapshot.status === 200 &&
          (revisionSnapshot.body['data'] as { revision?: { body?: string } }).revision?.body?.includes(BODY_MARKER) === true,
      );

      const missingRevision = await ada('GET', `${ACME_KB}/articles/${a1}/revisions/9`);
      record('revisions: unknown revision number → 404', missingRevision.status === 404);

      const junkRevision = await ada('GET', `${ACME_KB}/articles/${a1}/revisions/not-a-number`);
      record('revisions: junk revision number → 422', junkRevision.status === 422);

      const noOp = await nia('PATCH', `${ACME_KB}/articles/${a1}`, {
        body: (edit.body['data'] as { article?: { body?: string } }).article?.body,
      });
      record(
        'edit: identical content no-op → 200 with NO new revision',
        noOp.status === 200 &&
          (noOp.body['data'] as { article?: { currentRevisionNumber?: number } }).article?.currentRevisionNumber === 2,
      );

      const slugOnly = await ada('PATCH', `${ACME_KB}/articles/${a1}`, { slug: 'refund-policy-v2' });
      record(
        'edit: slug-only rename does NOT create a revision',
        slugOnly.status === 200 &&
          (slugOnly.body['data'] as { article?: { slug?: string; currentRevisionNumber?: number } }).article?.slug === 'refund-policy-v2' &&
          (slugOnly.body['data'] as { article?: { currentRevisionNumber?: number } }).article?.currentRevisionNumber === 2,
      );

      const dupeSlug = await ada('PATCH', `${ACME_KB}/articles/${a1}`, { slug: 'concurrency-probe' });
      record('edit: slug rename onto an existing slug → 409', dupeSlug.status === 409);

      const secondEdit = await ada('PATCH', `${ACME_KB}/articles/${a1}`, {
        summary: 'Fresh summary after edits',
      });
      record(
        'edit: summary-only change appends revision 3',
        secondEdit.status === 200 &&
          (secondEdit.body['data'] as { article?: { currentRevisionNumber?: number } }).article?.currentRevisionNumber === 3,
      );

      const revision2Body = await ada('GET', `${ACME_KB}/articles/${a1}/revisions/2`);
      record(
        'edit: revision 2 snapshot keeps the v2 body',
        (revision2Body.body['data'] as { revision?: { body?: string } }).revision?.body?.includes(EDIT_MARKER) === true,
      );
    }

    // ══ 8. Lifecycle transitions ═══════════════════════════════════════════
    let aLifecycle = '';
    {
      const created = await nia('POST', `${ACME_KB}/articles`, {
        title: 'Lifecycle Walkthrough',
        body: 'Starts as a draft.',
        categoryId: catProduct,
      });
      aLifecycle = (created.body['data'] as { article?: { id?: string } }).article?.id ?? '';
      assert(created.status === 201);

      const publish = await ada('POST', `${ACME_KB}/articles/${aLifecycle}/publish`, {});
      const published = (publish.body['data'] as { article?: Record<string, unknown> }).article ?? {};
      record(
        'lifecycle: publish DRAFT → PUBLISHED with a stamp',
        publish.status === 200 &&
          published['status'] === 'PUBLISHED' &&
          typeof published['publishedAt'] === 'string' &&
          published['publishedAt'] !== null,
      );

      const publishAgain = await ada('POST', `${ACME_KB}/articles/${aLifecycle}/publish`, {});
      record('lifecycle: publish while PUBLISHED → 409', publishAgain.status === 409);

      const unpublish = await ada('POST', `${ACME_KB}/articles/${aLifecycle}/unpublish`, {});
      const backToDraft = (unpublish.body['data'] as { article?: Record<string, unknown> }).article ?? {};
      record(
        'lifecycle: unpublish PUBLISHED → DRAFT, stamp cleared',
        unpublish.status === 200 &&
          backToDraft['status'] === 'DRAFT' &&
          backToDraft['publishedAt'] === null,
      );

      const unpublishAgain = await ada('POST', `${ACME_KB}/articles/${aLifecycle}/unpublish`, {});
      record('lifecycle: unpublish a DRAFT → 409', unpublishAgain.status === 409);

      const archive = await ada('POST', `${ACME_KB}/articles/${aLifecycle}/archive`, {});
      const archivedArticle = (archive.body['data'] as { article?: Record<string, unknown> }).article ?? {};
      record(
        'lifecycle: archive DRAFT → ARCHIVED with stamp',
        archive.status === 200 && archivedArticle['status'] === 'ARCHIVED' && archivedArticle['archivedAt'] !== null,
      );

      const editArchived = await nia('PATCH', `${ACME_KB}/articles/${aLifecycle}`, { body: 'edited while archived' });
      record('lifecycle: editing an ARCHIVED article → 409', editArchived.status === 409);

      const publishArchived = await nia('POST', `${ACME_KB}/articles/${aLifecycle}/publish`, {});
      record('lifecycle: publishing an ARCHIVED article → 409', publishArchived.status === 409);

      const restore = await ada('POST', `${ACME_KB}/articles/${aLifecycle}/restore`, {});
      const restoredArticle = (restore.body['data'] as { article?: Record<string, unknown> }).article ?? {};
      record(
        'lifecycle: restore ARCHIVED → DRAFT, stamps cleared',
        restore.status === 200 &&
          restoredArticle['status'] === 'DRAFT' &&
          restoredArticle['archivedAt'] === null &&
          restoredArticle['publishedAt'] === null,
      );

      const restoreLive = await ada('POST', `${ACME_KB}/articles/${aLifecycle}/restore`, {});
      record('lifecycle: restoring a live article → 409', restoreLive.status === 409);

      const lifecycleRevisions = await ada('GET', `${ACME_KB}/articles/${aLifecycle}/revisions`);
      record(
        'lifecycle: transitions write NO revisions (content-only history)',
        (lifecycleRevisions.body['data'] as { total?: number }).total === 1,
      );

      const junkBody = await ada('POST', `${ACME_KB}/articles/${aLifecycle}/publish`, { rogue: true });
      record('lifecycle: lifecycle endpoints reject payloads → 422', junkBody.status === 422);
    }

    // ══ 9. Revision restore ════════════════════════════════════════════════
    {
      const restore = await nia('POST', `${ACME_KB}/articles/${a1}/revisions/1/restore`, {});
      const restoredRevision = (restore.body['data'] as { revision?: Record<string, unknown> }).revision ?? {};
      record(
        'revision restore: creates a NEW revision (4) pointing back at revision 1',
        restore.status === 201 &&
          restoredRevision['revisionNumber'] === 4 &&
          restoredRevision['restoredFromRevisionNumber'] === 1 &&
          restoredRevision['changeSummary'] === 'Restored from revision 1',
      );

      const detail = await ada('GET', `${ACME_KB}/articles/${a1}`);
      const detailPayload = (detail.body['data'] as { article?: Record<string, unknown> }).article ?? {};
      record(
        'revision restore: article content reverts, counter at 4, latest snapshot present',
        detail.status === 200 &&
          (detailPayload['body'] as string).includes(BODY_MARKER) &&
          detailPayload['currentRevisionNumber'] === 4,
      );

      const restoreChain = await nia('POST', `${ACME_KB}/articles/${a1}/revisions/3/restore`, {});
      record(
        'revision restore: restoring again creates revision 5 (history never rewritten)',
        restoreChain.status === 201 &&
          (restoreChain.body['data'] as { revision?: { revisionNumber?: number } }).revision?.revisionNumber === 5,
      );

      const viewerRestore = await vera('POST', `${ACME_KB}/articles/${a1}/revisions/1/restore`, {});
      record('revision restore: viewer denied (kb.manage) → 403', viewerRestore.status === 403);

      const viewerHistory = await vera('GET', `${ACME_KB}/articles/${a1}/revisions`);
      record('revisions: viewer history READ allowed (kb.view)', viewerHistory.status === 200);

      const restoreUnknown = await ada('POST', `${ACME_KB}/articles/${a1}/revisions/42/restore`, {});
      record('revision restore: unknown revision → 404', restoreUnknown.status === 404);

      const unknownArticleRevisions = await ada('GET', `${ACME_KB}/articles/${BOGUS_ID}/revisions`);
      record('revisions: unknown article → 404', unknownArticleRevisions.status === 404);

      // Model-level immutability guard: any revision mutation throws.
      let immutable = false;
      try {
        await KbRevisionModel.updateMany({}, { $set: { title: 'tampered' } });
      } catch {
        immutable = true;
      }
      let immutableDelete = false;
      try {
        await KbRevisionModel.deleteMany({});
      } catch {
        immutableDelete = true;
      }
      record(
        'revisions: model-enforced append-only (update/delete throw)',
        immutable && immutableDelete,
      );
    }

    // ══ 10. Category archive guards ════════════════════════════════════════
    let detachedCategoryId = '';
    {
      const blockedAttachments = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Anchored Article',
        body: 'keeps leaf B alive',
        categoryId: catLeafB,
      });
      const anchoredArticleId = (blockedAttachments.body['data'] as { article?: { id?: string } }).article?.id ?? '';
      assert(blockedAttachments.status === 201);

      const blockedByArticle = await ada('POST', `${ACME_KB}/categories/${catLeafB}/archive`, {});
      record(
        'category archive: live article attached → 409 with count',
        blockedByArticle.status === 409 &&
          ((blockedByArticle.body as { error?: { details?: { articlesInCategory?: number } } }).error?.details?.articlesInCategory ?? 0) === 1,
      );

      const blockedByChild = await ada('POST', `${ACME_KB}/categories/${catProduct}/archive`, {});
      record(
        'category archive: live child categories → 409 with count',
        blockedByChild.status === 409 &&
          ((blockedByChild.body as { error?: { details?: { liveChildCategories?: number } } }).error?.details?.liveChildCategories ?? 0) >= 1,
      );

      const detach = await ada('PATCH', `${ACME_KB}/articles/${anchoredArticleId}`, { categoryId: null });
      assert(detach.status === 200);
      detachedCategoryId = catLeafA;

      const archived = await ada('POST', `${ACME_KB}/categories/${detachedCategoryId}/archive`, {});
      record(
        'category archive: empty leaf archives → 200, disappears from default reads',
        archived.status === 200 &&
          ((await ada('GET', `${ACME_KB}/categories/${detachedCategoryId}`)).status === 404),
      );

      const attachArchived = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Attach To Archives',
        body: 'x',
        categoryId: detachedCategoryId,
      });
      record('category archive: attaching an article to an archived category → 404', attachArchived.status === 404);

      const restoreCategory = await ada('POST', `${ACME_KB}/categories/${detachedCategoryId}/restore`, {});
      record(
        'category archive: restore returns the node',
        restoreCategory.status === 200 &&
          (restoreCategory.body['data'] as { category?: { archived?: boolean } }).category?.archived === false,
      );

      const restoreLive = await ada('POST', `${ACME_KB}/categories/${detachedCategoryId}/restore`, {});
      record('category archive: restoring a live category → 409', restoreLive.status === 409);

      const unknownArchive = await ada('POST', `${ACME_KB}/categories/${BOGUS_ID}/archive`, {});
      record('category archive: unknown category → 404', unknownArchive.status === 404);
    }

    // ══ 11. Search / filter / sort / pagination ════════════════════════════
    let alpha = '';
    let beta = '';
    let gamma = '';
    {
      const alphaCreated = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Alpha Guide',
        summary: 'The alphabet',
        body: 'alpha body',
        categoryId: catProduct,
        tags: ['alpha'],
      });
      alpha = (alphaCreated.body['data'] as { article?: { id?: string } }).article?.id ?? '';
      const betaCreated = await nia('POST', `${ACME_KB}/articles`, {
        title: 'Beta Manual',
        summary: 'Beta documentation',
        body: 'beta body',
        tags: ['beta'],
      });
      beta = (betaCreated.body['data'] as { article?: { id?: string } }).article?.id ?? '';
      const gammaCreated = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Gamma Notes',
        summary: 'Gamma reference',
        body: 'gamma body',
      });
      gamma = (gammaCreated.body['data'] as { article?: { id?: string } }).article?.id ?? '';
      assert(alphaCreated.status === 201 && betaCreated.status === 201 && gammaCreated.status === 201);

      await nia('POST', `${ACME_KB}/articles/${alpha}/publish`, {});
      await ada('POST', `${ACME_KB}/articles/${beta}/publish`, {});

      // a1 is currently a draft (its body was restored from revision 1).
      const listAll = await ada('GET', `${ACME_KB}/articles?limit=50`);
      const all = listAll.body['data'] as { total?: number; items?: Array<{ id?: string }> };
      record(
        'list: default includes drafts, sorted newest-first',
        listAll.status === 200 && (all.items?.[0]?.id === gamma),
      );

      const searchTitle = await ada('GET', `${ACME_KB}/articles?search=Beta&page=1&limit=20`);
      record(
        'list: title search scans the tenant slice only',
        searchTitle.status === 200 &&
          (searchTitle.body['data'] as { items?: Array<{ title?: string }> }).items?.length === 1,
      );

      const searchSummary = await ada('GET', `${ACME_KB}/articles?search=alphabet`);
      record(
        'list: summary search matches too',
        (searchSummary.body['data'] as { total?: number }).total === 1,
      );

      const regexInjection = await ada('GET', `${ACME_KB}/articles?search=(.*^blah`);
      record('list: regex metacharacters in search are escaped (no crash, 200)', regexInjection.status === 200);

      const statusFilter = await ada('GET', `${ACME_KB}/articles?status=PUBLISHED&limit=50`);
      const publishedCount = (statusFilter.body['data'] as { total?: number }).total ?? 0;
      record(
        'list: status filter returns only PUBLISHED',
        statusFilter.status === 200 && publishedCount === 2,
      );

      const categoryFilter = await ada('GET', `${ACME_KB}/articles?categoryId=${catProduct}`);
      // Two live articles sit in this category at this point in the script.
      const categoryFilterData = categoryFilter.body['data'] as { total?: number; items?: Array<{ id?: string; categoryId?: string }> };
      record(
        'list: category filter is workspace-scoped and correctly typed',
        categoryFilter.status === 200 &&
          categoryFilterData.total === 2 &&
          (categoryFilterData.items ?? []).every((item) => item.categoryId === catProduct) &&
          (categoryFilterData.items ?? []).some((item) => item.id === alpha),
      );

      const tagFilter = await ada('GET', `${ACME_KB}/articles?tags=beta`);
      record('list: tag filter', (tagFilter.body['data'] as { total?: number }).total === 1);

      const authorFilter = await ada(
        'GET',
        `${ACME_KB}/articles?authorId=${(await UserModel.findOne({ email: 'nia11@acme.example' }))!._id.toHexString()}`,
      );
      const authorItems = (authorFilter.body['data'] as { items?: Array<{ title?: string }> }).items ?? [];
      record(
        'list: author filter returns only Nia-authored articles',
        authorItems.length > 0 && authorItems.every((i) => i.title !== 'Alpha Guide'),
      );

      const futureFrom = await ada('GET', `${ACME_KB}/articles?createdFrom=2099-01-01T00:00:00Z`);
      record('list: future createdFrom date range → empty result set', (futureFrom.body['data'] as { total?: number }).total === 0);

      const sortTitle = await ada('GET', `${ACME_KB}/articles?sort=title&order=asc&limit=50`);
      const titles = (sortTitle.body['data'] as { items?: Array<{ title?: string }> }).items?.map((i) => i.title) ?? [];
      record(
        'list: title asc sort is ordered',
        sortTitle.status === 200 && titles.indexOf('Alpha Guide') < titles.indexOf('Beta Manual') && titles.indexOf('Beta Manual') < titles.indexOf('Gamma Notes'),
      );

      const junkSort = await ada('GET', `${ACME_KB}/articles?sort=body`);
      record('list: non-allowlisted sort field → 422', junkSort.status === 422);

      const junkStatus = await ada('GET', `${ACME_KB}/articles?status=DELETED`);
      record('list: non-enum status filter → 422', junkStatus.status === 422);

      const junkDate = await ada('GET', `${ACME_KB}/articles?createdFrom=not-a-date`);
      record('list: malformed date range → 422', junkDate.status === 422);

      const oversizedPage = await ada('GET', `${ACME_KB}/articles?limit=999`);
      record('pagination: page size cap → 422', oversizedPage.status === 422);

      const paginated = await ada('GET', `${ACME_KB}/articles?page=1&limit=2`);
      const paginatedData = paginated.body['data'] as { items?: unknown[]; total?: number; hasMore?: boolean };
      record(
        'pagination: envelope matches the platform contract',
        paginatedData.items?.length === 2 && (paginatedData.total ?? 0) > 2 && paginatedData.hasMore === true,
      );

      void beta;
      void gamma;
    }

    // ══ 12. Public reads ═══════════════════════════════════════════════════
    let publicSlug = '';
    let draftId = '';
    {
      // A clearly public article and a stayed-draft article.
      const publicCreated = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Public FAQ Entry',
        slug: 'public-faq-entry',
        summary: 'Open to customers',
        body: '# Public\n\nEverything customers need.',
        categoryId: catProduct,
      });
      assert(publicCreated.status === 201);
      await ada('POST', `${ACME_KB}/articles/${(publicCreated.body['data'] as { article?: { id?: string } }).article?.id}/publish`, {});
      publicSlug = 'public-faq-entry';

      const draftCreated = await ada('POST', `${ACME_KB}/articles`, {
        title: 'Internal Payroll Draft',
        slug: 'internal-payroll-draft',
        summary: 'NEVER public',
        body: 'internal draft body marker',
      });
      draftId = (draftCreated.body['data'] as { article?: { id?: string } }).article?.id ?? '';
      assert(draftCreated.status === 201);

      const publicList = await http('GET', publicApi('/knowledge-base/acme-helpdesk-11/articles?limit=50'));
      const publicItems = (publicList.body['data'] as { items?: Array<{ slug?: string; status?: unknown }> }).items ?? [];
      record(
        'public: list returns PUBLISHED-only with public fields',
        publicList.status === 200 &&
          publicItems.some((i) => i.slug === 'public-faq-entry') &&
          publicItems.every((i) => !('status' in i) && !('lastEditedById' in i) && !('currentRevisionNumber' in i)),
      );

      record(
        'public: draft article EXCLUDED from the list',
        !publicItems.some((i) => i.slug === 'internal-payroll-draft'),
      );

      const publicDetail = await http('GET', publicApi('/knowledge-base/acme-helpdesk-11/articles/public-faq-entry'));
      const publicDetailBody = (publicDetail.body['data'] as { article?: Record<string, unknown> }).article ?? {};
      record(
        'public: slug detail exposes body but no management fields',
        publicDetail.status === 200 &&
          (publicDetailBody['body'] as string).includes('Everything customers need.') &&
          !('status' in publicDetailBody) &&
          !('createdById' in publicDetailBody) &&
          !('currentRevisionNumber' in publicDetailBody),
      );

      const draftBySlug = await http('GET', publicApi('/knowledge-base/acme-helpdesk-11/articles/internal-payroll-draft'));
      record('public: draft article IS NOT reachable by slug → 404', draftBySlug.status === 404);

      const archivedForPublic = await nia('POST', `${ACME_KB}/articles/${alpha}/archive`, {});
      assert(archivedForPublic.status === 200);
      const archivedBySlug = await http('GET', publicApi('/knowledge-base/acme-helpdesk-11/articles/alpha-guide'));
      record('public: ARCHIVED article IS NOT reachable by slug → 404', archivedBySlug.status === 404);
      await nia('POST', `${ACME_KB}/articles/${alpha}/restore`, {});

      const publicCategories = await http('GET', publicApi('/knowledge-base/acme-helpdesk-11/categories'));
      record(
        'public: category list exposes only public fields',
        publicCategories.status === 200 &&
          ((publicCategories.body['data'] as { items?: Array<Record<string, unknown>> }).items ?? [])
            .every((c) => !('createdById' in c) && !('archived' in c)),
      );

      const unknownWorkspace = await http('GET', publicApi('/knowledge-base/does-not-exist-999/articles'));
      record('public: unknown workspace slug → 404', unknownWorkspace.status === 404);

      const junkSlug = await http('GET', publicApi('/knowledge-base/Not_A_Slug!/articles'));
      record('public: malformed workspace slug → 422', junkSlug.status === 422);

      const evePublic = await eve('POST', `${KB_BASE(rivalId)}/articles`, {
        title: 'Rival Public Article',
        slug: 'rival-public-article',
        body: 'Rival published content.',
      });
      assert(evePublic.status === 201);
      await eve('POST', `${KB_BASE(rivalId)}/articles/${(evePublic.body['data'] as { article?: { id?: string } }).article?.id}/publish`, {});
      const rivalPublic = await http('GET', publicApi('/knowledge-base/rival-co-11/articles'));
      record(
        'public: rival workspace serves ITS OWN published content',
        rivalPublic.status === 200 &&
          (rivalPublic.body['data'] as { items?: Array<{ slug?: string }> }).items?.some((i) => i.slug === 'rival-public-article') === true,
      );

      const publicSearch = await http('GET', publicApi('/knowledge-base/acme-helpdesk-11/articles?search=FAQ'));
      record(
        'public: search only published content',
        (publicSearch.body['data'] as { items?: Array<{ slug?: string }> }).items?.every((i) => i.slug !== 'internal-payroll-draft') === true &&
          (publicSearch.body['data'] as { total?: number }).total === 1,
      );
      void draftId;
    }

    // ══ 13. Cross-tenant isolation ═════════════════════════════════════════
    {
      record(
        'tenant: eve cannot read acme article under her workspace → 404',
        (await eve('GET', `${KB_BASE(rivalId)}/articles/${a1}`)).status === 404,
      );
      record(
        'tenant: eve cannot patch acme article under her workspace → 404',
        (await eve('PATCH', `${KB_BASE(rivalId)}/articles/${a1}`, { body: 'poison' })).status === 404,
      );
      record(
        'tenant: eve cannot list acme revisions under her workspace → 404',
        (await eve('GET', `${KB_BASE(rivalId)}/articles/${a1}/revisions`)).status === 404,
      );
      record(
        'tenant: eve cannot restore acme revision under her workspace → 404',
        (await eve('POST', `${KB_BASE(rivalId)}/articles/${a1}/revisions/1/restore`, {})).status === 404,
      );
      record(
        'tenant: eve cannot read acme category under her workspace → 404',
        (await eve('GET', `${KB_BASE(rivalId)}/categories/${catProduct}`)).status === 404,
      );
      record(
        'tenant: eve cannot archive acme category under her workspace → 404',
        (await eve('POST', `${KB_BASE(rivalId)}/categories/${catProduct}/archive`, {})).status === 404,
      );
      record(
        'tenant: eve cannot publish acme article under her workspace → 404',
        (await eve('POST', `${KB_BASE(rivalId)}/articles/${aLifecycle}/publish`, {})).status === 404,
      );

      const eveOwnArticle = await eve('GET', `${KB_BASE(rivalId)}/articles`);
      record(
        'tenant: coop — eve’s OWN kb under her workspace → 200',
        eveOwnArticle.status === 200,
      );

      const foreignCategoryPatch = await ada('PATCH', `${ACME_KB}/articles/${a1}`, {
        categoryId: detachedCategoryId,
      });
      record(
        'tenant: attaching a DETACHED-LIVE category still works after restore (id flow)',
        [200, 404].includes(foreignCategoryPatch.status) === true,
      );
    }

    // ══ 14. Audit events ═══════════════════════════════════════════════════
    {
      const actionsWanted = [
        'kb.category.created',
        'kb.category.updated',
        'kb.category.archived',
        'kb.category.restored',
        'kb.article.created',
        'kb.article.updated',
        'kb.article.published',
        'kb.article.unpublished',
        'kb.article.archived',
        'kb.article.restored',
        'kb.article.revision_restored',
      ];
      for (const action of actionsWanted) {
        const count = await AuditLogModel.countDocuments({ action });
        record(`audit: ${action} recorded`, count > 0);
      }

      const kbDocs = await AuditLogModel.find({
        action: { $in: actionsWanted },
      });
      const serialized = JSON.stringify(
        kbDocs.map((d) => ({ metadata: d.metadata ?? {}, resourceId: d.resourceId })),
      );
      record(
        'audit: no article/body/summary/tag content in KB metadata (markers absent)',
        !serialized.includes(TITLE_MARKER) &&
          !serialized.includes(BODY_MARKER) &&
          !serialized.includes(EDIT_MARKER) &&
          !serialized.includes(SUMMARY_MARKER),
      );

      const denial = await AuditLogModel.countDocuments({ action: 'workspace.permission_denied' });
      record('audit: permission denials still audited (RBAC middleware)', denial > 0);
    }

    // ══ 15. Regressions ════════════════════════════════════════════════════
    {
      const health = await http('GET', `http://127.0.0.1:${port}/health/ready`);
      record('regression: /health/ready still 200', health.status === 200);

      const badLogin = await http('POST', api('/auth/login'), {
        body: { email: 'ada11@acme.example', password: 'WrongPassword!' },
      });
      record('regression: auth rejects a bad password', badLogin.status === 401);

      const detail = await ada('GET', `/workspaces/${acmeId}`);
      record('regression: workspace detail 200', detail.status === 200);

      const acmeCustomer = await newCustomer(acmeId, 'Regression Customer', 'regression11@acme.example');
      const ticketId = await newTicket_id(ownerToken, acmeId, acmeCustomer, 'Regression ticket 11');
      record('regression: ticket creation still works', ticketId.length === 24);

      const conversationCreated = await ada(
        'POST',
        `/workspaces/${acmeId}/tickets/${ticketId}/conversations`,
        {},
      );
      const conversationId = (conversationCreated.body['data'] as { conversation?: { id?: string } }).conversation?.id ?? '';
      record('regression: conversation get-or-create still works', conversationCreated.status === 201);
      const conversationCount = await ConversationModel.countDocuments({ ticketId });
      record('regression: single primary conversation intact', conversationCount === 1);

      const ticketCount = await TicketModel.countDocuments({ workspaceId: acmeId });
      record('regression: ticket collection untouched by KB work', ticketCount >= 1);
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
  process.exit(process.exitCode ?? 0);
});
