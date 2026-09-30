import { pino } from 'pino';

import { env, isProduction } from '../../config/env.config.js';

/**
 * Structured application logger.
 *
 * JSON output plays well with CloudWatch Logs Insights and other log
 * aggregators in production. Secrets are redacted centrally so feature code
 * never has to think about it.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.secret'],
    censor: '[REDACTED]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
});
