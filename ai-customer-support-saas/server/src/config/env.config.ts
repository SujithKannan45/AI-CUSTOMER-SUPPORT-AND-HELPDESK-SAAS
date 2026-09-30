import 'dotenv/config';
import { z } from 'zod';

/**
 * Central environment configuration.
 *
 * Application code must never read `process.env` directly — everything flows
 * through this validated, typed object so the app fails fast with a clear
 * message when configuration is missing or malformed.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Mongo connection string (Atlas or self-hosted). */
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/ai_support_saas'),

  /** Comma-separated list of origins allowed by CORS, e.g. "http://localhost:5173". */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  /** Root path for versioned API routes. */
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),
});

export type Env = z.infer<typeof envSchema>;

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  // The structured logger cannot be used here: it depends on this config.
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:', z.flattenError(parseResult.error).fieldErrors);
  process.exit(1);
}

export const env: Env = parseResult.data;

export const isProduction: boolean = env.NODE_ENV === 'production';
