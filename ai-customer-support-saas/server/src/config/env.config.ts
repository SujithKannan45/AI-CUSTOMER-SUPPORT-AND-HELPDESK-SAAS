import 'dotenv/config';
import { z } from 'zod';

/**
 * Optional env var that treats "missing" and "present-but-empty" (e.g. copied
 * from .env.example) the same: both become `undefined`. Lets later-phase
 * credentials stay blank in development without breaking boot.
 */
const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().optional());

/** Same as above, but with a minimum length for secrets. */
const optionalSecret = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().min(32).optional());

/**
 * Central environment configuration.
 *
 * Application code must never read `process.env` directly — everything flows
 * through this validated, typed object so the app fails fast with a clear
 * message when configuration is missing or malformed.
 *
 * Sections marked "(future phase)" are parsed and typed now so later prompts
 * add no new env plumbing — they only consume `env.*`.
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

  /** ── Rate limiting ──────────────────────────────────────────────────────── */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),

  /** ── Authentication (future phase — typed now, optional until it lands) ─── */
  JWT_ACCESS_SECRET: optionalSecret,
  JWT_REFRESH_SECRET: optionalSecret,
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  /** Browser URL of the SPA — used for CORS allow-list and future email links. */
  CLIENT_URL: z.string().url().default('http://localhost:5173'),

  /** ── AWS (future phase) ─────────────────────────────────────────────────── */
  AWS_REGION: optionalNonEmptyString,
  AWS_ACCESS_KEY_ID: optionalNonEmptyString,
  AWS_SECRET_ACCESS_KEY: optionalNonEmptyString,
  S3_BUCKET_DOCUMENTS: optionalNonEmptyString,

  /** ── AI providers (future phase) ────────────────────────────────────────── */
  AI_PROVIDER: z.enum(['openai', 'gemini', 'bedrock', 'none']).default('none'),
  OPENAI_API_KEY: optionalNonEmptyString,
  GEMINI_API_KEY: optionalNonEmptyString,
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

/**
 * Boot-time guard: refuse to run in production with placeholder auth secrets.
 * Development stays friction-free; production never boots insecurely.
 */
if (isProduction && (env.JWT_ACCESS_SECRET === undefined || env.JWT_REFRESH_SECRET === undefined)) {
  // eslint-disable-next-line no-console
  console.error('❌ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are required in production.');
  process.exit(1);
}
