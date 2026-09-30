import mongoose from 'mongoose';

import { env } from '../config/env.config.js';
import { logger } from '../core/logger/logger.js';

const connectionOptions: mongoose.ConnectOptions = {
  // Server Selection: fail fast in dev so misconfiguration surfaces immediately.
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  // Never let an accidentally unindexed query take the database down.
  maxPoolSize: 20,
  minPoolSize: 2,
  autoIndex: env.NODE_ENV !== 'production',
};

let connected = false;

/** Opens the primary database connection. Idempotent. */
export async function connectDatabase(): Promise<void> {
  if (connected) return;

  mongoose.connection.on('connected', () => {
    connected = true;
    logger.info(`MongoDB connected`);
  });
  mongoose.connection.on('disconnected', () => {
    connected = false;
    logger.warn('MongoDB disconnected');
  });
  mongoose.connection.on('error', (error: Error) => {
    logger.error({ err: error }, 'MongoDB connection error');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });

  await mongoose.connect(env.MONGODB_URI, connectionOptions);
}

/** Closes the connection gracefully (used by shutdown hooks and tests). */
export async function disconnectDatabase(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
  logger.info('MongoDB connection closed');
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}
