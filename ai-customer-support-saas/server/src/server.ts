import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createApp } from './app.js';
import { env } from './config/env.config.js';
import { registerShutdownHook, runShutdownHooks } from './core/lifecycle/shutdown-registry.js';
import { logger } from './core/logger/logger.js';
import { connectDatabase, disconnectDatabase } from './database/database.js';

/**
 * Boot sequence: fail fast if the database is unreachable (a support SaaS
 * cannot serve meaningful traffic without it), then open the HTTP listener.
 *
 * The HTTP server is created explicitly so the real-time layer can attach to
 * the same listener later without a second port, and it is registered with
 * the shutdown registry for clean teardown.
 *
 * Exported (rather than run implicitly) so integration drivers and future
 * tests can boot the real server in-process; the main-module guard below
 * keeps direct execution identical to before.
 */
export async function startServer(): Promise<Server> {
  const app = createApp();

  await connectDatabase();

  const httpServer: Server = app.listen(env.PORT, () => {
    logger.info(`API listening on port ${env.PORT} [${env.NODE_ENV}]`);
  });

  registerShutdownHook(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });
  registerShutdownHook(disconnectDatabase);

  let isShuttingDown = false;
  const shutdown = (signal: string): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`${signal} received — shutting down gracefully`);

    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    void (async () => {
      try {
        await runShutdownHooks();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // CTRL_BREAK on Windows — keeps `docker stop`/console breaks graceful in dev.
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  // A rejected promise after shutdown has started is a bug, not noise —
  // escalate it instead of logging-and-continuing forever.
  process.on('unhandledRejection', (reason) => {
    if (isShuttingDown) {
      process.exit(1);
    }
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception — terminating');
    process.exit(1);
  });

  return httpServer;
}

/** Runs only when this module is the process entry point. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer().catch((error: unknown) => {
    // Fail-safe: an unreachable database or invalid config must terminate the
    // process so orchestrators restart it, never leave it half-alive.
    logger.fatal({ err: error }, 'Boot failed — exiting');
    process.exit(1);
  });
}
