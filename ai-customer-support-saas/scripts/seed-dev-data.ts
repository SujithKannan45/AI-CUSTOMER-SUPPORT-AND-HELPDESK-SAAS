/**
 * Development-only seed data (CLI wrapper).
 *
 * NEVER run in production: the implementation refuses to act when MONGODB_URI
 * points anywhere but localhost, and every credential it writes is a publicly
 * known throwaway ("dev-password-123"). It exists so manual UI work in later
 * phases starts from realistic data — it is not a fixture or factory for tests.
 *
 * The seeding itself lives in `scripts/dev-seed.ts` so `verify-seed.ts` can
 * run the identical code path against an isolated database.
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

const DEFAULT_DEV_URI = 'mongodb://127.0.0.1:27777/ai_support_saas';

async function main(): Promise<void> {
  // env.config.ts freezes process.env at module-evaluation time, so the URI
  // must be settled BEFORE any server module is imported (seedDevDatabase
  // imports them dynamically for exactly this reason).
  const { DEV_PASSWORD, seedDevDatabase } = await import('./dev-seed.js');
  const uri = process.env['MONGODB_URI'] ?? DEFAULT_DEV_URI;

  const result = await seedDevDatabase({
    uri,
    onProgress: (message) => {
      // eslint-disable-next-line no-console
      console.log(message);
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `Done. Dev logins use password "${DEV_PASSWORD}" (throwaway) for: ${result.emails.join(', ')}`,
  );
  if (result.repairedPasswords > 0 || result.repairedOwners > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `Repaired legacy seed data: ${result.repairedPasswords} password hash(es), ${result.repairedOwners} workspace owner reference(s).`,
    );
  }
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
