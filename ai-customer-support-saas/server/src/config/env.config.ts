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

  /**
   * Mongo connection string (Atlas or self-hosted). The default is the local
   * service (27017) to keep production/Atlas friction-free; in DEVELOPMENT a
   * dev helper should set an explicit dev URI (scripts/dev-db.ts on 27777) or
   * an explicit MONGODB_URI — see `scripts/dev-db.ts` and `npm run db:memory`.
   */
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

  /** ── Authentication ────────────────────────────────────────────────────── */
  // Secrets are optional in development (tests/dev boot without them); the
  // production boot guard below refuses to start without them. When absent in
  // non-production, auth.tokens.ts derives a per-process random secret.
  JWT_ACCESS_SECRET: optionalSecret,
  JWT_REFRESH_SECRET: optionalSecret,
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  /** One-time email-verification token lifetime (e.g. "24h", "30m"). */
  AUTH_VERIFY_EMAIL_TTL: z.string().default('24h'),
  /** One-time password-reset token lifetime. */
  AUTH_PASSWORD_RESET_TTL: z.string().default('1h'),

  /** ── Refresh-token cookie ───────────────────────────────────────────────── */
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  COOKIE_DOMAIN: optionalNonEmptyString,

  /** ── Email delivery (provider-independent seam; SMTP/SES adapters later) ── */
  /** "log" = dev-safe outbox (writes to logger, never sends). Absent + production = boot failure. */
  EMAIL_PROVIDER: z.enum(['log', 'smtp', 'ses']).default('log'),
  EMAIL_FROM_ADDRESS: optionalNonEmptyString,
  EMAIL_FROM_NAME: optionalNonEmptyString,
  SMTP_HOST: optionalNonEmptyString,
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: optionalNonEmptyString,
  SMTP_PASSWORD: optionalSecret,

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
 * Boot-time guards: development stays friction-free; production never boots
 * insecurely. Each failure names the exact fix.
 */
const productionFailures: string[] = [];
if (isProduction && env.JWT_ACCESS_SECRET === undefined) {
  productionFailures.push('JWT_ACCESS_SECRET is required in production.');
}
if (isProduction && env.JWT_REFRESH_SECRET === undefined) {
  productionFailures.push('JWT_REFRESH_SECRET is required in production.');
}
if (isProduction && env.EMAIL_PROVIDER !== 'log' && env.EMAIL_FROM_ADDRESS === undefined) {
  productionFailures.push('EMAIL_FROM_ADDRESS is required when EMAIL_PROVIDER is not "log".');
}
if (isProduction && env.EMAIL_PROVIDER === 'log') {
  productionFailures.push(
    'EMAIL_PROVIDER="log" is a development-only outbox and must not run in production.',
  );
}

if (productionFailures.length > 0) {
  // The structured logger cannot be used here: it depends on this config.
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:', productionFailures);
  process.exit(1);
}
