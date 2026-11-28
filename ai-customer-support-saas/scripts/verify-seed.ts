/**
 * Development-seed verification driver.
 *
 * Regression coverage for the two defects found during Prompt 22 browser
 * verification — the documented dev password not matching the stored bcrypt
 * hash, and seeded workspaces missing `ownerId` (which made `GET /workspaces`
 * throw). Boots its own in-memory mongod + the REAL Express app, then:
 *
 *   1.  runs `seedDevDatabase()` twice (idempotency) and asserts stored state
 *   2.  simulates BOTH legacy defects and proves the seed repairs them
 *   3.  over real HTTP: the documented account logs in, a wrong password is
 *       rejected, `GET /workspaces` returns the owned workspace with a valid
 *       owner, and tenant isolation still holds for the second tenant
 *
 * Exit code 0 only when every check passes. Server code is imported
 * DYNAMICALLY after MONGODB_URI is set (env.config.ts freezes process.env at
 * module-evaluation time — the Prompt 3 lesson).
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
}

async function http(
  method: 'GET' | 'POST',
  url: string,
  options: { body?: unknown; token?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
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

interface WorkspaceListBody {
  items?: Array<{
    workspace?: { id?: string; slug?: string; ownerId?: string };
    membership?: { role?: string };
  }>;
  total?: number;
}

interface LoginBody {
  data?: { tokens?: { accessToken?: string } };
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_seed' },
  });

  const expectedUri = memoryServer.getUri('verify_seed');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  const port = 3997;
  process.env['PORT'] = String(port);

  const { DEV_PASSWORD, seedDevDatabase } = await import('./dev-seed.js');
  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');

  if (env.MONGODB_URI !== expectedUri) {
    throw new Error(
      `env.MONGODB_URI (${env.MONGODB_URI}) does not match the verification mongod (${expectedUri}) — aborting to protect foreign databases`,
    );
  }

  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { WorkspaceModel } = await import('../server/src/modules/workspaces/workspace.model.js');
  const { WorkspaceMemberModel } = await import(
    '../server/src/modules/workspaces/workspace-member.model.js'
  );
  const { verifyPassword } = await import('../server/src/modules/auth/auth.tokens.js');
  // `seedDevDatabase` disconnects when it finishes (its CLI contract), so the
  // driver re-opens the connection for its own assertions.
  const { connectDatabase } = await import('../server/src/database/database.js');

  let httpServer: Awaited<ReturnType<typeof startServer>> | null = null;

  try {
    // ── 1. First seed ──────────────────────────────────────────────────────
    const first = await seedDevDatabase({ uri: expectedUri });
    await connectDatabase();
    record(
      'seed: creates both development workspaces',
      first.workspaces.length === 2 && first.emails.length === 4,
    );
    record('seed: first run repairs nothing (clean database)', first.repairedPasswords === 0 && first.repairedOwners === 0);

    const seededUsers = await UserModel.find({}).select('+passwordHash');
    const everyPasswordWorks = await Promise.all(
      seededUsers.map((user) => verifyPassword(DEV_PASSWORD, user.passwordHash)),
    );
    record(
      'seed: every seeded account verifies the documented password',
      seededUsers.length === 4 && everyPasswordWorks.every((ok) => ok),
    );

    const wrongPassword = await verifyPassword('dev-password-124', seededUsers[0]?.passwordHash);
    record('seed: an incorrect password does not verify', wrongPassword === false);

    const rawUsers = await UserModel.collection.find({}).toArray();
    record(
      'seed: no plaintext password is persisted',
      !JSON.stringify(rawUsers).includes(DEV_PASSWORD),
    );
    record(
      'seed: stored hashes use the auth module bcrypt format',
      rawUsers.every((doc) => typeof doc['passwordHash'] === 'string' && doc['passwordHash'].startsWith('$2')),
    );

    const workspaces = await WorkspaceModel.find({});
    record(
      'seed: every workspace has an ownerId',
      workspaces.length === 2 && workspaces.every((workspace) => workspace.ownerId !== null && workspace.ownerId !== undefined),
    );

    const ownerRows = await WorkspaceMemberModel.find({ role: 'owner' });
    record('seed: exactly one owner membership per workspace', ownerRows.length === 2);

    const ownerMatches = workspaces.every((workspace) =>
      ownerRows.some(
        (row) =>
          row.workspaceId.equals(workspace._id) && row.userId.equals(workspace.ownerId),
      ),
    );
    record('seed: workspace.ownerId equals its owner membership user', ownerMatches);

    const countsAfterFirst = {
      users: await UserModel.countDocuments({}),
      workspaces: await WorkspaceModel.countDocuments({}),
      members: await WorkspaceMemberModel.countDocuments({}),
    };

    // ── 2. Simulate BOTH legacy defects, then re-seed ──────────────────────
    const acme = workspaces.find((workspace) => workspace.slug === 'acme-support');
    const globex = workspaces.find((workspace) => workspace.slug === 'globex-helpdesk');
    if (acme === undefined || globex === undefined) throw new Error('seed did not create both workspaces');

    await WorkspaceModel.collection.updateOne(
      { _id: globex._id },
      { $unset: { ownerId: '' } },
    );
    const ada = await UserModel.findOne({ email: 'ada@acme.test' }).select('+passwordHash');
    if (ada === null) throw new Error('seed did not create ada@acme.test');
    // The exact defect: a hash for some OTHER password.
    const foreignHash = (await import('bcryptjs')).default.hashSync('some-other-password', 12);
    await UserModel.collection.updateOne({ _id: ada._id }, { $set: { passwordHash: foreignHash } });

    const legacyOwnerless = await WorkspaceModel.collection.findOne({ _id: globex._id });
    const legacyLoginBroken = await verifyPassword(DEV_PASSWORD, foreignHash);
    record(
      'legacy simulation: ownerId removed and password hash replaced',
      legacyOwnerless !== null && legacyOwnerless['ownerId'] === undefined && legacyLoginBroken === false,
    );

    const second = await seedDevDatabase({ uri: expectedUri });
    await connectDatabase();
    record(
      'seed: second run repairs the legacy defects it finds',
      second.repairedOwners === 1 && second.repairedPasswords === 1,
    );

    const repairedGlobex = await WorkspaceModel.findOne({ slug: 'globex-helpdesk' });
    record(
      'seed: missing ownerId backfilled with the owner account',
      repairedGlobex !== null && repairedGlobex.ownerId.toString() === second.workspaces.find((w) => w.slug === 'globex-helpdesk')?.ownerId,
    );

    const repairedAda = await UserModel.findOne({ email: 'ada@acme.test' }).select('+passwordHash');
    record(
      'seed: legacy password hash replaced with one matching the documented password',
      repairedAda !== null && (await verifyPassword(DEV_PASSWORD, repairedAda.passwordHash)),
    );

    const countsAfterSecond = {
      users: await UserModel.countDocuments({}),
      workspaces: await WorkspaceModel.countDocuments({}),
      members: await WorkspaceMemberModel.countDocuments({}),
    };
    record(
      'seed: idempotent — no duplicate users, workspaces or memberships',
      countsAfterFirst.users === countsAfterSecond.users &&
        countsAfterFirst.workspaces === countsAfterSecond.workspaces &&
        countsAfterFirst.members === countsAfterSecond.members,
    );

    // ── 3. Real HTTP against the booted app ────────────────────────────────
    httpServer = await startServer();
    const base = `http://127.0.0.1:${port}/api/v1`;

    const login = await http('POST', `${base}/auth/login`, {
      body: { email: 'ada@acme.test', password: DEV_PASSWORD },
    });
    const issued = (login.body as LoginBody).data?.tokens?.accessToken;
    const accessToken = typeof issued === 'string' ? issued : '';
    record(
      'http: documented development account authenticates',
      login.status === 200 && accessToken.split('.').length === 3,
    );

    const loginWrong = await http('POST', `${base}/auth/login`, {
      body: { email: 'ada@acme.test', password: 'dev-password-999' },
    });
    record('http: an incorrect password is rejected → 401', loginWrong.status === 401);

    const listNoAuth = await http('GET', `${base}/workspaces`);
    record('http: GET /workspaces without a token → 401', listNoAuth.status === 401);

    const list = await http('GET', `${base}/workspaces`, { token: accessToken });
    const listBody = (list.body as { data?: WorkspaceListBody }).data ?? {};
    const items = listBody.items ?? [];
    record('http: GET /workspaces succeeds for the seeded owner', list.status === 200);
    record(
      'http: the owner sees exactly their own workspace with a valid ownerId',
      items.length === 1 &&
        items[0]?.workspace?.slug === 'acme-support' &&
        items[0]?.workspace?.ownerId === acme.ownerId.toString() &&
        items[0]?.membership?.role === 'owner',
    );
    record(
      'http: workspace payload contains no credential material',
      !JSON.stringify(list.body).includes('$2') && !JSON.stringify(list.body).includes(DEV_PASSWORD),
    );

    // Tenant isolation unchanged: the second owner sees only Globex, and a
    // foreign workspace id is concealed (404), not forbidden.
    const niaLogin = await http('POST', `${base}/auth/login`, {
      body: { email: 'nia@globex.test', password: DEV_PASSWORD },
    });
    const niaToken = (niaLogin.body as LoginBody).data?.tokens?.accessToken;
    const niaList = await http('GET', `${base}/workspaces`, {
      token: typeof niaToken === 'string' ? niaToken : '',
    });
    const niaItems = ((niaList.body as { data?: WorkspaceListBody }).data?.items ?? []);
    record(
      'http: second tenant sees only its own workspace',
      niaList.status === 200 && niaItems.length === 1 && niaItems[0]?.workspace?.slug === 'globex-helpdesk',
    );

    const foreignDetail = await http(
      'GET',
      `${base}/workspaces/${globex._id.toString()}`,
      { token: accessToken },
    );
    record('http: foreign workspace detail is concealed → 404', foreignDetail.status === 404);

    const ownDetail = await http('GET', `${base}/workspaces/${acme._id.toString()}`, {
      token: accessToken,
    });
    record(
      'http: own workspace detail returns the owner reference',
      ownDetail.status === 200 &&
        (ownDetail.body as { data?: { workspace?: { ownerId?: string } } }).data?.workspace?.ownerId ===
          acme.ownerId.toString(),
    );
  } finally {
    if (httpServer !== null) {
      await new Promise<void>((resolve) => {
        if (httpServer === null) return resolve();
        httpServer.close(() => {
          resolve();
        });
      });
    }
    const { disconnectDatabase } = await import('../server/src/database/database.js');
    await disconnectDatabase();
    await memoryServer.stop();
  }

  const failed = checks.filter((check) => !check.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('verify-seed driver failed:', error);
  process.exit(1);
});
