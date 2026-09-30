/**
 * Development fallback database.
 *
 * NOT a test rig and NOT for production: when Docker is unavailable, this
 * starts a real MongoDB binary (managed by mongodb-memory-server) bound to
 * 127.0.0.1 so the API can run with `MONGODB_URI=mongodb://127.0.0.1:<port>`
 * for local verification. Data is ephemeral and dies with the process.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 27777, dbName: 'ai_support_saas' },
  });

  // eslint-disable-next-line no-console
  console.log(`DEV-MONGO ${memoryServer.getUri()}`);

  const shutdown = (): void => {
    void memoryServer.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
