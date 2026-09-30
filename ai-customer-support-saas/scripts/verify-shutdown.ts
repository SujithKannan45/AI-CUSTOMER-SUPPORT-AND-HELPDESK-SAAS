/**
 * Graceful-shutdown verification driver.
 *
 * Exercises the same code path as `server.ts` — real `connectDatabase()`,
 * real `registerShutdownHook` + `runShutdownHooks()` — without needing an
 * HTTP client, so shutdown behavior is verifiable in any environment.
 * Exits 0 when the database disconnects cleanly, 1 otherwise.
 */
async function main(): Promise<void> {
  const { connectDatabase, disconnectDatabase, isDatabaseConnected } = await import(
    '../server/src/database/database.js'
  );
  const { registerShutdownHook, runShutdownHooks } = await import(
    '../server/src/core/lifecycle/shutdown-registry.js'
  );

  await connectDatabase();
  // eslint-disable-next-line no-console
  console.log(`VERIFY-SHUTDOWN connected=${String(isDatabaseConnected())}`);

  registerShutdownHook(disconnectDatabase);
  await runShutdownHooks();

  const clean = !isDatabaseConnected();
  // eslint-disable-next-line no-console
  console.log(`VERIFY-SHUTDOWN disconnected=${String(clean)}`);
  process.exit(clean ? 0 : 1);
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('VERIFY-SHUTDOWN failed:', error);
  process.exit(1);
});
