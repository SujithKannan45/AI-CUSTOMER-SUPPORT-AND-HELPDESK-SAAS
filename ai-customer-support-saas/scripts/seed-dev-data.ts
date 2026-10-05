/**
 * Development-only seed data.
 *
 * NEVER run in production: the script refuses to act when MONGODB_URI points
 * anywhere but localhost, and every credential it writes is a publicly known
 * throwaway ("dev-password-123"). It exists so manual UI work in later phases
 * starts from realistic data — it is not a fixture or factory for tests.
 *
 * Usage:
 *   npm run db:memory &        # in-memory Mongo on :27777 (dev only)
 *   npm run seed:dev           # seeds it
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadEnv } from 'dotenv';

// Load server/.env so MONGODB_URI behaves exactly like the real server boot.
// Resolved from process.cwd() (not import.meta.url) so the script type-checks
// and runs identically whether tsx treats it as ESM or CJS.
const envPath = path.resolve(process.cwd(), 'server', '.env');
if (existsSync(envPath)) {
  loadEnv({ path: envPath });
}

// NOTE: server modules are imported DYNAMICALLY inside main(), AFTER the
// target URI is settled — env.config.ts freezes process.env at
// module-evaluation time (same bootstrap rule as scripts/verify-models.ts).

/**
 * Bcrypt hash of the throwaway password "dev-password-123". Public by design:
 * it only ever lands in a development database guarded by the localhost check
 * below. Prompt 4's auth service will replace this with a real hashing call.
 */
const DEV_PASSWORD_HASH =
  '$2b$12$C6IzEQvNkQTBGcRrH0kG1.5pCj0UeXVLOVdxgKKu5WkTk6vQioJNK';

interface SeedUserSpec {
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'agent';
}

interface SeedWorkspaceSpec {
  name: string;
  slug: string;
  users: SeedUserSpec[];
}

const SEED_PLAN: SeedWorkspaceSpec[] = [
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

const SEED_CUSTOMERS: Array<{ slug: string; name: string; email?: string; tags: string[] }> = [
  { slug: 'acme-support', name: 'Mara Klein', email: 'mara@example.com', tags: ['vip'] },
  { slug: 'acme-support', name: 'John Roe', email: 'john@example.com', tags: [] },
  { slug: 'acme-support', name: 'Chat Visitor #1042', tags: ['chat-widget'] },
  { slug: 'globex-helpdesk', name: 'Mara Klein', email: 'mara@example.com', tags: [] },
];

/** Lowercased host of the configured MONGODB_URI (for the dev-only guard). */
function mongoHost(uri: string): string {
  try {
    return new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname;
  } catch {
    return uri;
  }
}

/** Idempotent: seeding twice leaves the same logical dataset (upserts). */
async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27777/ai_support_saas';
  const host = mongoHost(uri);
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to seed: MONGODB_URI host "${host}" is not localhost.`);
    process.exit(1);
  }

  // env.config.ts freezes process.env at module-evaluation time, so the URI
  // must be settled BEFORE any server module is imported.
  process.env['MONGODB_URI'] = uri;
  process.env['PORT'] = '8000';

  const mongoose = (await import('mongoose')).default;
  const { env } = await import('../server/src/config/env.config.js');
  const { connectDatabase, disconnectDatabase } = await import(
    '../server/src/database/database.js'
  );
  const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
  const { CustomerModel } = await import('../server/src/modules/customers/customer.model.js');
  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { WorkspaceMemberModel } = await import(
    '../server/src/modules/workspaces/workspace-member.model.js'
  );
  const { WorkspaceModel } = await import('../server/src/modules/workspaces/workspace.model.js');

  if (env.MONGODB_URI !== uri) {
    throw new Error(
      `env.MONGODB_URI (${env.MONGODB_URI}) does not match the requested seed target (${uri})`,
    );
  }

  await connectDatabase();

  const userIdByEmail = new Map<string, string>();

  for (const workspaceSpec of SEED_PLAN) {
    const workspace = await WorkspaceModel.findOneAndUpdate(
      { slug: workspaceSpec.slug },
      { $setOnInsert: { name: workspaceSpec.name, slug: workspaceSpec.slug, status: 'active' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    for (const userSpec of workspaceSpec.users) {
      const user = await UserModel.findOneAndUpdate(
        { email: userSpec.email },
        {
          $setOnInsert: {
            name: userSpec.name,
            email: userSpec.email,
            passwordHash: DEV_PASSWORD_HASH,
            status: 'active',
            emailVerified: true,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      userIdByEmail.set(userSpec.email, user._id.toString());

      await WorkspaceMemberModel.findOneAndUpdate(
        { workspaceId: workspace._id, userId: user._id },
        {
          $setOnInsert: {
            workspaceId: workspace._id,
            userId: user._id,
            role: userSpec.role,
            status: 'active',
            joinedAt: new Date(),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    for (const customerSpec of SEED_CUSTOMERS.filter((c) => c.slug === workspaceSpec.slug)) {
      const owner = await WorkspaceMemberModel.findOne({
        workspaceId: workspace._id,
        role: 'owner',
      });
      const customer = await CustomerModel.findOneAndUpdate(
        { workspaceId: workspace._id, name: customerSpec.name },
        {
          $setOnInsert: {
            workspaceId: workspace._id,
            name: customerSpec.name,
            email: customerSpec.email,
            status: 'active',
            tags: customerSpec.tags,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      await AuditLogModel.create({
        workspaceId: workspace._id,
        actorId: owner?.userId ?? null,
        action: 'customer.imported',
        resourceType: 'customer',
        resourceId: customer._id.toHexString(),
        metadata: { source: 'dev-seed' },
        ip: '127.0.0.1',
        userAgent: 'seed-dev-data/1.0',
      });
    }

    // eslint-disable-next-line no-console
    console.log(`Seeded workspace "${workspaceSpec.name}" (${workspaceSpec.slug})`);
  }

  await disconnectDatabase();
  // eslint-disable-next-line no-console
  console.log(
    `Done. Dev logins use password "dev-password-123" (throwaway) for: ${[...userIdByEmail.keys()].join(', ')}`,
  );
}

void main();
