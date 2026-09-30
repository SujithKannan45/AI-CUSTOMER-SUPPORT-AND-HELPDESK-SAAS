import type { Server } from 'node:http';

import { createApp } from './app.js';
import { env } from './config/env.config.js';
import { logger } from './core/logger/logger.js';
import { connectDatabase, disconnectDatabase } from './database/database.js';

/**
 * Boot order: HTTP listener first (so health probes answer during startup),
 * then the database. The HTTP server is created explicitly so the real-time
 * layer can attach to the same listener later without a second port.
 */
async function bootstrap(): Promise<void> {
  const app = createApp();
  const httpServer: Server = app.listen(env.PORT, () => {
    logger.info(`API listening on port ${env.PORT} [${env.NODE_ENV}]`);
  });

  await connectDatabase();

  let isShuttingDown = false;
  const shutdown = (signal: string): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`${signal} received — shutting down gracefully`);

    httpServer.close(async () => {
      try {
        await disconnectDatabase();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      }
    });

    // Force-exit if connections do not drain in time.
    setTimeout(() => {
      logger.error('Forcing shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception — terminating');
    process.exit(1);
  });
}

void bootstrap();
