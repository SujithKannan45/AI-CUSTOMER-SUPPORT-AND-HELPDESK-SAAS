/**
 * Development seed — the reusable implementation behind `npm run seed:dev`.
 *
 * Extracted from the CLI wrapper (`seed-dev-data.ts`) so the regression driver
 * (`verify-seed.ts`) runs the EXACT same code path against an isolated
 * database instead of re-implementing seeding.
 *
 * Two rules this module exists to honour (both were violated by the first
 * version of the seed, see docs/architecture.md):
 *
 *  1. Passwords are hashed by the AUTH MODULE, never by a baked-in literal.
 *     `hashPassword()` is the same bcrypt cost-12 call registration uses, so a
 *     seeded account verifies exactly like a real one. The plaintext
 *     `DEV_PASSWORD` exists only in this dev-only file and is never persisted.
 *  2. A workspace is created with its `ownerId`. The workspace schema requires
 *     it; the first seed wrote workspaces without it (findOneAndUpdate does
 *     not run `required` validators), which made `GET /workspaces` throw when
 *     the DTO mapping read `ownerId.toHexString()`. The owner user is
 *     therefore upserted FIRST, then referenced by the workspace, and legacy
 *     owner-less documents are backfilled by idempotent update.
 *
 * Safety: every entry point refuses to run unless the target host is
 * localhost, and the accounts/credentials are publicly known throwaways.
 */
/** Documented, throwaway development password. Never used outside local dev. */
export const DEV_PASSWORD = 'dev-password-123';

export interface SeedUserSpec {
  readonly name: string;
  readonly email: string;
  readonly role: 'owner' | 'admin' | 'agent';
}

export interface SeedWorkspaceSpec {
  readonly name: string;
  readonly slug: string;
  readonly users: readonly SeedUserSpec[];
}

/** The complete development dataset — two tenants, four accounts. */
export const SEED_PLAN: readonly SeedWorkspaceSpec[] = [
  {
    name: 'Acme Support',
    slug: 'acme-support',
    users: [
      { name: 'Ada Owner', email: 'ada@acme.test', role: 'owner' },
      { name: 'Grant Admin', email: 'grant@acme.test', role: 'admin' },
      { name: 'Abe Agent', email: 'abe@acme.test', role: 'agent' },
    ],
  },
  {
    name: 'Globex Helpdesk',
    slug: 'globex-helpdesk',
    users: [{ name: 'Nia Owner', email: 'nia@globex.test', role: 'owner' }],
  },
];

export interface SeedCustomerSpec {
  readonly slug: string;
  readonly name: string;
  readonly email?: string;
  readonly tags: readonly string[];
}

export const SEED_CUSTOMERS: readonly SeedCustomerSpec[] = [
  { slug: 'acme-support', name: 'Mara Klein', email: 'mara@example.com', tags: ['vip'] },
  { slug: 'acme-support', name: 'John Roe', email: 'john@example.com', tags: [] },
  { slug: 'acme-support', name: 'Chat Visitor #1042', tags: ['chat-widget'] },
  { slug: 'globex-helpdesk', name: 'Mara Klein', email: 'mara@example.com', tags: [] },
];

export interface SeedOptions {
  /** Absolute MongoDB URI. Must point at localhost (dev-only guard). */
  readonly uri: string;
  /** Progress sink (CLI logs; the verifier stays quiet). */
  readonly onProgress?: (message: string) => void;
}

export interface SeededWorkspace {
  readonly slug: string;
  readonly name: string;
  readonly ownerId: string;
  readonly ownerEmail: string;
}

export interface SeedResult {
  readonly workspaces: readonly SeededWorkspace[];
  readonly emails: readonly string[];
  /** True when at least one stored hash had to be rewritten (legacy repair). */
  readonly repairedPasswords: number;
  /** True when at least one workspace had a missing ownerId repaired. */
  readonly repairedOwners: number;
}

/** Lowercased host of a MongoDB URI (for the dev-only guard). */
export function mongoHost(uri: string): string {
  try {
    return new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname;
  } catch {
    return uri;
  }
}

/** Throws unless the URI targets the local machine. */
export function assertLocalSeedTarget(uri: string): void {
  const host = mongoHost(uri);
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Refusing to seed: MONGODB_URI host "${host}" is not localhost.`);
  }
}

/**
 * Seeds the development dataset. Idempotent: running it twice converges on the
 * same users, memberships, workspaces and customers, and repairs documents
 * created by the earlier (defective) seed.
 *
 * Server modules are imported DYNAMICALLY so `env.config.ts` (which freezes
 * `process.env` at module-evaluation time) reads the URI this call settled —
 * the same bootstrap rule as `scripts/verify-models.ts`.
 */
export async function seedDevDatabase(options: SeedOptions): Promise<SeedResult> {
  const { uri, onProgress = () => undefined } = options;
  assertLocalSeedTarget(uri);

  const previousUri = process.env['MONGODB_URI'];
  const previousPort = process.env['PORT'];
  process.env['MONGODB_URI'] = uri;
  // The seed never binds a port, but env.config.ts refuses to load without a
  // positive one (a developer .env may set PORT=0 to mean "any"). Keep a
  // usable value already present (the verifier pins its own port) and fall back
  // to the documented dev port otherwise.
  const portIsUsable = /^\d+$/.test(previousPort ?? '') && Number(previousPort) > 0;
  process.env['PORT'] = portIsUsable ? (previousPort as string) : '8000';

  const { connectDatabase, disconnectDatabase } = await import(
    '../server/src/database/database.js'
  );
  const { env } = await import('../server/src/config/env.config.js');

  if (env.MONGODB_URI !== uri) {
    throw new Error(
      `env.MONGODB_URI (${env.MONGODB_URI}) does not match the requested seed target (${uri})`,
    );
  }

  // Imported dynamically for the same bootstrap reason: auth.tokens.ts reads
  // env.config.ts (which freezes PORT/JWT settings at module-evaluation time).
  const { hashPassword, verifyPassword } = await import(
    '../server/src/modules/auth/auth.tokens.js'
  );
  const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
  const { CustomerModel } = await import('../server/src/modules/customers/customer.model.js');
  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { WorkspaceMemberModel } = await import(
    '../server/src/modules/workspaces/workspace-member.model.js'
  );
  const { WorkspaceModel } = await import('../server/src/modules/workspaces/workspace.model.js');

  // One bcrypt hash (cost 12, the auth module's configuration) reused by every
  // seeded account: the password is identical and cost dominates runtime.
  const passwordHash = await hashPassword(DEV_PASSWORD);

  const emails: string[] = [];
  const workspaces: SeededWorkspace[] = [];
  let repairedPasswords = 0;
  let repairedOwners = 0;

  await connectDatabase();

  try {
    /** Finds or creates one dev user and guarantees the documented password. */
    async function ensureUser(spec: SeedUserSpec): Promise<{ id: string }> {
      const existing = await UserModel.findOne({ email: spec.email });
      if (existing === null) {
        const created = await UserModel.create({
          name: spec.name,
          email: spec.email,
          passwordHash,
          status: 'active',
          emailVerified: true,
        });
        emails.push(spec.email);
        return { id: created._id.toString() };
      }

      // `passwordHash` is `select: false`, so it must be requested explicitly.
      const withSecret = await UserModel.findById(existing._id).select('+passwordHash');
      const stored = withSecret?.passwordHash;
      const usable = await verifyPassword(DEV_PASSWORD, stored);
      if (!usable) {
        // Repair accounts created by the earlier seed (hash for a different
        // password) — only for the known development accounts.
        await UserModel.updateOne(
          { _id: existing._id },
          { $set: { passwordHash, status: 'active', emailVerified: true } },
        );
        repairedPasswords += 1;
      }
      emails.push(spec.email);
      return { id: existing._id.toString() };
    }

    for (const workspaceSpec of SEED_PLAN) {
      const ownerSpec = workspaceSpec.users.find((user) => user.role === 'owner');
      if (ownerSpec === undefined) {
        throw new Error(`Seed plan for "${workspaceSpec.slug}" has no owner account`);
      }

      // Owner FIRST: the workspace document references it.
      const owner = await ensureUser(ownerSpec);

      const workspace = await WorkspaceModel.findOneAndUpdate(
        { slug: workspaceSpec.slug },
        {
          $setOnInsert: {
            name: workspaceSpec.name,
            slug: workspaceSpec.slug,
            status: 'active',
            ownerId: owner.id,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      if (workspace === null) {
        throw new Error(`Workspace "${workspaceSpec.slug}" could not be upserted`);
      }

      // Backfill for workspaces created by the pre-fix seed, which omitted
      // `ownerId`. Guarded so a valid, existing owner is never overwritten.
      const backfill = await WorkspaceModel.updateOne(
        { _id: workspace._id, $or: [{ ownerId: { $exists: false } }, { ownerId: null }] },
        { $set: { ownerId: owner.id } },
      );
      if (backfill.modifiedCount > 0) {
        repairedOwners += 1;
      }

      for (const userSpec of workspaceSpec.users) {
        const user = userSpec.email === ownerSpec.email ? owner : await ensureUser(userSpec);

        await WorkspaceMemberModel.findOneAndUpdate(
          { workspaceId: workspace._id, userId: user.id },
          {
            $setOnInsert: {
              workspaceId: workspace._id,
              userId: user.id,
              role: userSpec.role,
              status: 'active',
              joinedAt: new Date(),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      }

      for (const customerSpec of SEED_CUSTOMERS.filter((c) => c.slug === workspaceSpec.slug)) {
        const existed = await CustomerModel.exists({
          workspaceId: workspace._id,
          name: customerSpec.name,
        });

        const customer = await CustomerModel.findOneAndUpdate(
          { workspaceId: workspace._id, name: customerSpec.name },
          {
            $setOnInsert: {
              workspaceId: workspace._id,
              name: customerSpec.name,
              email: customerSpec.email,
              status: 'active',
              tags: [...customerSpec.tags],
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        if (customer === null) continue;

        // Audited once per imported customer — a repeat seed must not append
        // duplicate import entries.
        if (existed === null) {
          await AuditLogModel.create({
            workspaceId: workspace._id,
            actorId: owner.id,
            action: 'customer.imported',
            resourceType: 'customer',
            resourceId: customer._id.toHexString(),
            metadata: { source: 'dev-seed' },
            ip: '127.0.0.1',
            userAgent: 'seed-dev-data/1.0',
          });
        }
      }

      workspaces.push({
        slug: workspaceSpec.slug,
        name: workspaceSpec.name,
        ownerId: owner.id,
        ownerEmail: ownerSpec.email,
      });
      onProgress(`Seeded workspace "${workspaceSpec.name}" (${workspaceSpec.slug})`);
    }
  } finally {
    await disconnectDatabase();
    if (previousUri === undefined) delete process.env['MONGODB_URI'];
    else process.env['MONGODB_URI'] = previousUri;
    if (previousPort === undefined) delete process.env['PORT'];
  }

  return { workspaces, emails, repairedPasswords, repairedOwners };
}
