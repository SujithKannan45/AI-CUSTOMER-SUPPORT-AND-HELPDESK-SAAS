/**
 * Model verification driver — runs the core models against a REAL MongoDB.
 *
 * Boots its own in-memory mongod (the same managed binary used by
 * scripts/dev-db.ts) on an ephemeral port, connects through the production
 * `connectDatabase()` path, and asserts:
 *
 *   1. all five models register under their expected collections,
 *   2. schema validation rejects bad data (email, slug, role),
 *   3. user emails are globally unique,
 *   4. customer emails are unique PER WORKSPACE while the same email is legal
 *      in two different workspaces (the core tenancy guarantee),
 *   5. (workspaceId, userId) membership uniqueness and the single-owner
 *      partial unique index,
 *   6. the Workspace slug is unique and immutable,
 *   7. sensitive fields are select:false and opt-in only,
 *   8. soft delete: default reads exclude, WITH_DELETED includes, email reuse,
 *   9. tenant helpers (tenantFilter / assertTenantScope) behave,
 *  10. AuditLog is append-only: update / bulkWrite / doc-edit / delete throw,
 *  11. the named compound indexes exist on the real server.
 *
 * Exit code 0 only when every check passes.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

// NOTE: server modules are imported DYNAMICALLY inside main(), AFTER the
// target database is configured. env.config.ts validates and freezes
// process.env at module-evaluation time, so any static import of server code
// would pin the connection to the default URI before this script can point
// it at the in-memory mongod.

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

async function expectFailure(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_models' },
  });

  // Set BEFORE importing server code (see file-top note). PORT is pinned
  // because host shells may export a placeholder value.
  process.env['MONGODB_URI'] = memoryServer.getUri('verify_models');
  process.env['PORT'] = '8000';

  const mongoose = (await import('mongoose')).default;
  const { env } = await import('../server/src/config/env.config.js');
  const { connectDatabase, disconnectDatabase } = await import(
    '../server/src/database/database.js'
  );
  const { AppError } = await import('../server/src/core/errors/app-error.js');
  const { assertTenantScope, tenantFilter } = await import('../server/src/database/tenant.js');
  const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
  const { CustomerModel, WITH_DELETED } = await import(
    '../server/src/modules/customers/customer.model.js'
  );
  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { WorkspaceMemberModel } = await import(
    '../server/src/modules/workspaces/workspace-member.model.js'
  );
  const { WorkspaceModel } = await import('../server/src/modules/workspaces/workspace.model.js');
  const { hasAtLeastRole, WORKSPACE_ROLES } = await import(
    '../server/src/modules/workspaces/workspace.types.js'
  );

  // Prove the config froze the RIGHT database — this is exactly the failure
  // mode that once pointed the driver at a local MongoDB service (27017).
  const expectedUri = memoryServer.getUri('verify_models');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error(
      `env.MONGODB_URI (${env.MONGODB_URI}) does not match the verification mongod (${expectedUri}) — aborting to protect foreign databases`,
    );
  }

  await connectDatabase();

  // Wait for autoIndex to finish BEFORE any writes, otherwise unique-index
  // assertions race the background index builds.
  await Promise.all([
    UserModel.init(),
    WorkspaceModel.init(),
    WorkspaceMemberModel.init(),
    CustomerModel.init(),
    AuditLogModel.init(),
  ]);

  // -- 1. Models register under expected collections --------------------------
  const expectedCollections = [
    'users',
    'workspaces',
    'workspace_members',
    'customers',
    'audit_logs',
  ];
  record(
    'five models registered under expected collection names',
    expectedCollections.every((name) => mongoose.connection.collections[name] !== undefined),
  );

  // -- Seed users --------------------------------------------------------------
  const alice = await UserModel.create({
    name: 'Alice Owner',
    email: 'alice@example.com',
    passwordHash: '$2b$12$C6IzEQvNkQTBGcRrH0kG1.5pCj0UeXVLOVdxgKKu5WkTk6vQioJNK',
  });
  const bob = await UserModel.create({ name: 'Bob Agent', email: 'bob@example.com' });

  // select:false applies to QUERIES: re-fetch instead of trusting the
  // in-memory document returned by create().
  const aliceFromDb = await UserModel.findById(alice._id);
  record(
    'passwordHash and tokenVersion absent from default queries (select:false)',
    aliceFromDb !== null &&
      !('passwordHash' in aliceFromDb.toObject()) &&
      !('tokenVersion' in aliceFromDb.toObject()),
  );
  const withHash = await UserModel.findById(alice._id).select('+passwordHash');
  record('passwordHash opt-in via +passwordHash', withHash?.passwordHash !== undefined);

  // -- 2. Schema validation rejects bad data ----------------------------------
  record(
    'invalid user email rejected at schema level',
    await expectFailure(() => UserModel.create({ name: 'Bad', email: 'not-an-email' })),
  );
  record(
    'invalid workspace slug rejected at schema level',
    await expectFailure(() =>
      WorkspaceModel.create({ name: 'Bad Slug', slug: 'Bad_Slug!', ownerId: alice._id }),
    ),
  );
  record(
    'invalid membership role rejected at schema level',
    await expectFailure(() =>
      WorkspaceMemberModel.create({
        workspaceId: new mongoose.Types.ObjectId(),
        userId: alice._id,
        role: 'superadmin',
      }),
    ),
  );
  record(
    'role vocabulary is exactly owner/admin/agent',
    WORKSPACE_ROLES.length === 3 &&
      hasAtLeastRole('admin', 'agent') &&
      !hasAtLeastRole('agent', 'admin'),
  );

  // -- 3. Global user-email uniqueness -----------------------------------------
  record(
    'duplicate user email rejected globally',
    await expectFailure(() => UserModel.create({ name: 'Clone', email: 'alice@example.com' })),
  );

  // -- 4. Workspaces: slug uniqueness + immutability ---------------------------
  const wsA = await WorkspaceModel.create({
    name: 'Workspace A',
    slug: 'acme',
    ownerId: alice._id,
  });
  const wsB = await WorkspaceModel.create({
    name: 'Workspace B',
    slug: 'globex',
    ownerId: alice._id,
  });
  record(
    'duplicate workspace slug rejected',
    await expectFailure(() =>
      WorkspaceModel.create({ name: 'Another Acme', slug: 'acme', ownerId: alice._id }),
    ),
  );
  // Mongoose enforces immutability by silently discarding the new value on
  // save(); the guarantee to verify is that the PERSISTED slug never changes.
  wsA.set('slug', 'renamed');
  await wsA.save();
  const afterRenameAttempt = await WorkspaceModel.findById(wsA._id);
  record(
    'workspace slug immutable (save cannot change it)',
    afterRenameAttempt?.slug === 'acme',
  );

  // -- 5. Membership uniqueness + single owner ---------------------------------
  const ownerMembership = await WorkspaceMemberModel.create({
    workspaceId: wsA._id,
    userId: alice._id,
    role: 'owner',
  });
  record(
    'second owner in same workspace rejected (partial unique index)',
    await expectFailure(() =>
      WorkspaceMemberModel.create({ workspaceId: wsA._id, userId: bob._id, role: 'owner' }),
    ),
  );
  record(
    'same owner allowed in a DIFFERENT workspace (tenancy correctness)',
    await WorkspaceMemberModel.create({
      workspaceId: wsB._id,
      userId: alice._id,
      role: 'owner',
    }).then(
      () => true,
      () => false,
    ),
  );
  record(
    'duplicate membership (workspace,user) rejected',
    await expectFailure(() =>
      WorkspaceMemberModel.create({ workspaceId: wsA._id, userId: alice._id, role: 'agent' }),
    ),
  );
  await WorkspaceMemberModel.create({ workspaceId: wsA._id, userId: bob._id, role: 'agent' });
  record(
    'tenantFilter hits exactly one workspace membership',
    (await WorkspaceMemberModel.countDocuments({ ...tenantFilter(wsA._id), userId: bob._id })) === 1,
  );
  await WorkspaceMemberModel.deleteOne({ _id: ownerMembership._id });

  // -- 6. Customer per-workspace email uniqueness ------------------------------
  const shared = 'shared@example.com';
  const custA = await CustomerModel.create({
    workspaceId: wsA._id,
    name: 'Shared Customer',
    email: shared,
  });
  await CustomerModel.create({ workspaceId: wsB._id, name: 'Shared Customer', email: shared });
  record(
    'same customer email allowed in two workspaces (tenant isolation)',
    (await CustomerModel.countDocuments({ email: shared })) === 2,
  );
  record(
    'duplicate email WITHIN a workspace rejected (case-insensitive)',
    await expectFailure(() =>
      CustomerModel.create({ workspaceId: wsA._id, name: 'Dupe', email: shared.toUpperCase() }),
    ),
  );
  await CustomerModel.create({ workspaceId: wsA._id, name: 'Anonymous Visitor' });
  await CustomerModel.create({ workspaceId: wsA._id, name: 'Second Anonymous' });
  record(
    'multiple email-less customers coexist (partial unique index)',
    (await CustomerModel.countDocuments({
      ...tenantFilter(wsA._id),
      email: { $exists: false },
    })) === 2,
  );

  // -- 7. Soft delete semantics -------------------------------------------------
  await custA.softDelete();
  record(
    'soft-deleted customer email becomes reusable',
    await CustomerModel.create({ workspaceId: wsA._id, name: 'Reclaimed', email: shared }).then(
      () => true,
      () => false,
    ),
  );
  record(
    'default queries exclude soft-deleted customers',
    (await CustomerModel.countDocuments({ ...tenantFilter(wsA._id) })) === 3,
  );
  record(
    'WITH_DELETED scope includes the soft-deleted customer',
    (await CustomerModel.countDocuments({ ...tenantFilter(wsA._id) }, WITH_DELETED)) === 4,
  );

  // -- 8. Tenant helpers ---------------------------------------------------------
  let scopeThrew = false;
  try {
    assertTenantScope({ name: 'no tenant here' });
  } catch (error) {
    scopeThrew = error instanceof AppError && error.code === 'TENANT_SCOPE_VIOLATION';
  }
  record('assertTenantScope rejects unscoped filters', scopeThrew);
  const built = tenantFilter('64b000000000000000000000');
  record(
    'tenantFilter converts strings to ObjectId',
    built.workspaceId instanceof mongoose.Types.ObjectId,
  );

  // -- 9. AuditLog immutability --------------------------------------------------
  const entry = await AuditLogModel.create({
    workspaceId: wsA._id,
    actorId: alice._id,
    action: 'member.added',
    resourceType: 'member',
    resourceId: bob._id.toHexString(),
    metadata: { role: 'agent' },
    ip: '203.0.113.9',
    userAgent: 'verify-models/1.0',
  });
  record(
    'audit updateOne rejected',
    await expectFailure(() =>
      AuditLogModel.updateOne({ _id: entry._id }, { $set: { action: 'member.removed' } }),
    ),
  );
  record(
    'audit bulkWrite rejected',
    await expectFailure(() =>
      AuditLogModel.bulkWrite([
        { updateOne: { filter: { _id: entry._id }, update: { $set: { action: 'x' } } } },
      ]),
    ),
  );
  entry.set('action', 'tampered');
  record('audit document edit rejected', await expectFailure(() => entry.save()));
  record(
    'audit deleteOne rejected',
    await expectFailure(() => AuditLogModel.deleteOne({ _id: entry._id })),
  );
  const savedEntry = await AuditLogModel.findById(entry._id);
  record(
    'audit entries have no updatedAt (single timestamp)',
    savedEntry !== null && !('updatedAt' in savedEntry.toObject()),
  );

  // -- 10. Named indexes exist on the real server --------------------------------
  const customerIndexes = await CustomerModel.collection.listIndexes().toArray();
  const customerIndexNames = customerIndexes.map((index) => String(index['name']));
  record(
    'customer compound indexes exist on the server',
    [
      'uniq_customer_email_per_workspace',
      'idx_customers_by_status',
      'idx_customers_by_created',
      'idx_customers_by_updated',
    ].every((name) => customerIndexNames.includes(name)),
  );
  const memberIndexes = await WorkspaceMemberModel.collection.listIndexes().toArray();
  record(
    'single-owner partial unique index exists on the server',
    memberIndexes.some(
      (index) =>
        String(index['name']) === 'uniq_owner_per_workspace' &&
        index['partialFilterExpression'] !== undefined,
    ),
  );

  await disconnectDatabase();
  await memoryServer.stop();

  const failed = checks.filter((check) => !check.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('VERIFY-MODELS FATAL', error);
  process.exit(1);
});
