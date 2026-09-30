/**
 * Real-signal graceful-shutdown verification driver.
 *
 * Boots the REAL server in-process (same `startServer()` the production
 * entry point runs — real app, real database connection, real signal
 * handlers) and then emits SIGBREAK/SIGTERM through Node's event system so
 * the registered handler executes exactly as the OS would trigger it.
 *
 * Cross-process signal delivery is not reliably scriptable on Windows
 * (`process.kill` = TerminateProcess there), so this validates the handler
 * path in-process: same code, same listeners, same teardown sequence.
 * Asserts: handler ran, teardown completed, port drained, process exits 0.
 */
import type { Server } from 'node:http';

async function main(): Promise<void> {
  const { startServer } = await import('../server/src/server.js');
  const { isDatabaseConnected } = await import('../server/src/database/database.js');

  let gracefulExit: number | null = null;
  const realExit = process.exit.bind(process);
  process.exit = ((code?: number) => {
    if (gracefulExit === null) gracefulExit = code ?? 0;
    // Keep the driver alive so assertions below still run.
    return undefined as never;
  }) as typeof process.exit;

  const httpServer: Server = await startServer();
  // eslint-disable-next-line no-console
  console.log('PASS  real server booted (startServer)');

  // Wait until the listener is accepting connections, like a health probe.
  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const tick = (): void => {
      if (httpServer.listening) return resolve();
      if (++attempts > 50) return reject(new Error('server never listened'));
      setTimeout(tick, 100);
    };
    tick();
  });

  const signal = process.env.SIGNAL_ENV ?? 'SIGBREAK';
  process.emit(signal);

  // The handler runs asynchronously; give the event loop the ticks it needs.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const teardownRan = !isDatabaseConnected() && !httpServer.listening;
  // eslint-disable-next-line no-console
  console.log(`${teardownRan ? 'PASS' : 'FAIL'}  ${signal} handler executed full teardown (db disconnected: ${String(!isDatabaseConnected())}, port drained: ${String(!httpServer.listening)})`);
  // eslint-disable-next-line no-console
  console.log(`${gracefulExit === 0 ? 'PASS' : 'FAIL'}  handler requested graceful exit 0 (got ${String(gracefulExit)})`);

  process.exit = realExit;
  process.exit(teardownRan && gracefulExit === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('VERIFY-SIGNAL-SHUTDOWN failed:', error);
  process.exit(1);
});
