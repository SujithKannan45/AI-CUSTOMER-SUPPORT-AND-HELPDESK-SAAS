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

  /** ── AWS (previous phase; consumed by the S3 storage driver) ──────────────── */
  AWS_REGION: optionalNonEmptyString,
  AWS_ACCESS_KEY_ID: optionalNonEmptyString,
  AWS_SECRET_ACCESS_KEY: optionalNonEmptyString,
  S3_BUCKET_DOCUMENTS: optionalNonEmptyString,

  /** ── Document/file storage (Prompt 12) ───────────────────────────────── */
  /** "local" = disk driver (dev default); "s3" = production driver. */
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  /** Root directory for the local driver (ignored by the s3 provider). */
  STORAGE_DATA_DIR: z.string().min(1).default('./data/files'),
  /** Hard cap per uploaded file (rejected allocates nothing in storage). */
  FILE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  /** Dev escape hatch allowing the disk driver in production (explicit opt-in). */
  STORAGE_ALLOW_LOCAL_PRODUCTION: z.enum(['true', 'false']).default('false'),

  /**
   * Generation (chat) provider for the support agent (Prompt 14). "none"
   * (default) keeps agent endpoints safely unconfigured; "openai" uses the
   * OpenAI-compatible chat API; "gemini"/"bedrock" are RESERVED enum values
   * whose adapters are not implemented yet — the factory surfaces the same
   * safe "not configured" behavior until their adapters exist.
   */
  AI_PROVIDER: z.enum(['openai', 'gemini', 'bedrock', 'none']).default('none'),
  OPENAI_API_KEY: optionalNonEmptyString,
  GEMINI_API_KEY: optionalNonEmptyString,

  /** ── AI support agent (Prompt 14) ────────────────────────────────────── */
  /** OpenAI-compatible chat endpoint base (proxy-friendly, like RAG_OPENAI_BASE_URL). */
  AI_CHAT_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  /** Generation model id for the chat provider (configurable; live behavior must be verified before production use). */
  AI_CHAT_MODEL: z.string().min(1).default('gpt-4o-mini'),
  /** Per-call chat provider timeout in ms. */
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** Hard max completion tokens requested per generation call. */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4096).default(512),
  /** Question length bound (abuse guard). */
  AI_AGENT_QUESTION_MAX_CHARS: z.coerce.number().int().positive().default(2_000),
  /** Conversation-history grounding bounds (PUBLIC messages only — never internal notes). */
  AI_AGENT_HISTORY_MAX_MESSAGES: z.coerce.number().int().positive().max(50).default(10),
  AI_AGENT_HISTORY_MESSAGE_MAX_CHARS: z.coerce.number().int().positive().default(2_000),
  /** Answerability policy uses only evidence the application can measure. */
  /** Minimum passages that must survive retrieval for a grounded answer. */
  AI_AGENT_MIN_PASSAGES: z.coerce.number().int().positive().default(1),
  /** Minimum similarity score of the best retrieved passage (0 disables the floor). */
  AI_AGENT_MIN_CONTEXT_SCORE: z.coerce.number().min(0).max(1).default(0.1),
  /** Passages admitted into the generation context (must not exceed the retrieval max). */
  AI_AGENT_CONTEXT_MAX_PASSAGES: z.coerce.number().int().positive().default(5),
  /** Total characters of passage text admitted into the generation context. */
  AI_AGENT_CONTEXT_MAX_CHARS: z.coerce.number().int().positive().default(6_000),
  /** Returned-answer length cap (provider output is truncated to this bound). */
  AI_AGENT_ANSWER_MAX_CHARS: z.coerce.number().int().positive().default(2_000),

  /** ── AI/RAG foundation (Prompt 13) ── */
  /** Embedding provider: "none" (default — indexing stays dormant), "openai", or "mock" (tests/dev ONLY — forbidden in production). */
  RAG_EMBEDDING_PROVIDER: z.enum(['none', 'openai', 'mock']).default('none'),
  /** Embedding model id for the selected provider (openai adapter payload field). */
  RAG_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  /** Vector dimensionality — MUST match the vector store; stored per chunk. */
  RAG_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(4096).default(1536),
  /** Max texts per embedding API call. */
  RAG_EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(2048).default(64),
  /** Per-call embedding provider timeout in ms. */
  RAG_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Max characters per embedding API input (provider input guards). */
  RAG_EMBEDDING_INPUT_MAX_CHARS: z.coerce.number().int().positive().default(8000),
  /** OpenAI-compatible embeddings endpoint base (no secret; proxy-friendly). */
  RAG_OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  /** Vector search implementation: "none" (default), "atlas", or "inmemory" (tests/dev ONLY — forbidden in production unless explicitly allowed). */
  RAG_VECTOR_SEARCH: z.enum(['none', 'atlas', 'inmemory']).default('none'),
  /** Atlas Search index name on the rag_chunks collection (created manually on Atlas). */
  RAG_ATLAS_VECTOR_INDEX: z.string().min(1).default('rag_chunks_vector'),
  /** Escape hatch for forcing the o(N)-scan in-memory store in production; never used by default. */
  RAG_ALLOW_INMEMORY_VECTOR_PRODUCTION: z.enum(['true', 'false']).default('false'),
  /** Retrieval bounds: query length, max results per retrieval call, similarity floor (0 = off). */
  RAG_QUERY_MAX_LENGTH: z.coerce.number().int().positive().default(1000),
  RAG_MAX_RETRIEVE_LIMIT: z.coerce.number().int().positive().max(100).default(10),
  RAG_MIN_SCORE: z.coerce.number().min(0).max(1).default(0),
  /** Chunking bounds: chunk size and cross-chunk overlap (overlap MUST be strictly smaller than chunk size). */
  RAG_CHUNK_MAX_CHARS: z.coerce.number().int().positive().default(1_200),
  RAG_CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).default(150),
  /** Hard input cap before chunking (protects memory; sources stay bounded upstream). */
  RAG_MAX_SOURCE_CHARS: z.coerce.number().int().positive().default(300_000),
})
  .refine(
    (value) => value['RAG_CHUNK_OVERLAP_CHARS'] < value['RAG_CHUNK_MAX_CHARS'],
    { path: ['RAG_CHUNK_OVERLAP_CHARS'], message: 'must be strictly smaller than the chunk size' },
  )
  .refine(
    (value) => value['AI_AGENT_CONTEXT_MAX_PASSAGES'] <= value['RAG_MAX_RETRIEVE_LIMIT'],
    {
      path: ['AI_AGENT_CONTEXT_MAX_PASSAGES'],
      message: 'must not exceed RAG_MAX_RETRIEVE_LIMIT — retrieval can never admit more passages than one search returns',
    },
  );

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
if (isProduction && env.STORAGE_PROVIDER === 's3') {
  const missingAws = [
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'S3_BUCKET_DOCUMENTS',
  ].filter((key) => process.env[key] === undefined || process.env[key] === '');
  if (missingAws.length > 0) {
    productionFailures.push(
      `STORAGE_PROVIDER=s3 requires these variables in production: ${missingAws.join(', ')}.`,
    );
  }
}
if (isProduction && env.STORAGE_PROVIDER === 'local' && env.STORAGE_ALLOW_LOCAL_PRODUCTION !== 'true') {
  productionFailures.push(
    'STORAGE_PROVIDER=local is not nil-safe for production: set STORAGE_PROVIDER=s3 (with the AWS_* variables) or explicitly opt in with STORAGE_ALLOW_LOCAL_PRODUCTION=true.',
  );
}
if (isProduction && env.AI_PROVIDER === 'openai' && env.OPENAI_API_KEY === undefined) {
  productionFailures.push(
    'AI_PROVIDER=openai requires OPENAI_API_KEY in production (or set AI_PROVIDER=none).',
  );
}
if (isProduction && env.RAG_EMBEDDING_PROVIDER === 'mock') {
  productionFailures.push(
    'RAG_EMBEDDING_PROVIDER=mock is a deterministic test/dev provider: it must not run in production (use "openai" with OPENAI_API_KEY, or "none").',
  );
}
if (isProduction && env.RAG_EMBEDDING_PROVIDER === 'openai' && env.OPENAI_API_KEY === undefined) {
  productionFailures.push(
    'RAG_EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY in production (or set RAG_EMBEDDING_PROVIDER=none).',
  );
}
if (
  isProduction &&
  env.RAG_VECTOR_SEARCH === 'inmemory' &&
  env.RAG_ALLOW_INMEMORY_VECTOR_PRODUCTION !== 'true'
) {
  productionFailures.push(
    'RAG_VECTOR_SEARCH=inmemory performs an o(N) scan and is for tests/dev only: use Atlas Vector Search (RAG_VECTOR_SEARCH=atlas) or explicitly opt in with RAG_ALLOW_INMEMORY_VECTOR_PRODUCTION=true.',
  );
}

if (productionFailures.length > 0) {
  // The structured logger cannot be used here: it depends on this config.
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:', productionFailures);
  process.exit(1);
}
