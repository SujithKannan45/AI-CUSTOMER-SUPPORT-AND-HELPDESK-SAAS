import { createHash, randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

import { env } from '../../config/env.config.js';
import { AppError } from '../../core/errors/app-error.js';

/**
 * Token primitives for the auth module — the ONLY place that knows about JWT
 * encoding, secret material and password hashing.
 *
 * Design notes:
 * - Access JWTs carry MINIMAL claims (sub, type, iat, exp). No email, no
 *   roles, no workspace data — authorization context is resolved server-side
 *   per request in later prompts, never trusted from the token.
 * - When JWT secrets are absent (development/tests), per-process random
 *   secrets are derived so dev boots stay friction-free. Production refuses
 *   to boot without explicit secrets (env.config.ts boot guard).
 * - One-time tokens (verify-email, password reset) are 32 random bytes,
 *   hex-encoded (64 chars). Only their SHA-256 hash touches the database.
 */

const BCRYPT_ROUNDS = 12;

/** Refresh-token cookie name (HttpOnly; the access token stays in JSON only). */
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** Derive a per-process secret when none is configured (dev/test only). */
function devSecret(prefix: string): Uint8Array {
  return new TextEncoder().encode(`${prefix}:${process.pid}:${randomBytes(32).toString('hex')}`);
}

const accessSecret: Uint8Array = env.JWT_ACCESS_SECRET
  ? new TextEncoder().encode(env.JWT_ACCESS_SECRET)
  : devSecret('access');

/**
 * Refresh-token signing secret — reserved for the signed-JWT refresh variant.
 * Today's refresh tokens are opaque random strings verified against a database
 * hash (stronger than a stateless JWT: server-side revocation is instant), so
 * the secret is referenced here only to keep derivation symmetric with the
 * access secret and hot when that variant is enabled.
 */
void (env.JWT_REFRESH_SECRET !== undefined
  ? new TextEncoder().encode(env.JWT_REFRESH_SECRET)
  : devSecret('refresh'));

/** Access-token TTL in seconds (parsed from e.g. "15m", "1h", "7d"). */
const ACCESS_TTL_SECONDS = parseDuration(env.JWT_ACCESS_TTL);
/** Refresh-token TTL in seconds. */
export const REFRESH_TTL_SECONDS = parseDuration(env.JWT_REFRESH_TTL);
export const VERIFY_EMAIL_TTL_SECONDS = parseDuration(env.AUTH_VERIFY_EMAIL_TTL);
export const PASSWORD_RESET_TTL_SECONDS = parseDuration(env.AUTH_PASSWORD_RESET_TTL);

/** Parses a compact duration ("15m" | "1h" | "7d" | "30s" | "45") into seconds. */
function parseDuration(value: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(value.trim());
  if (match === null) {
    throw new AppError(`Invalid duration "${value}" in auth configuration`, {
      statusCode: 500,
      code: 'CONFIG_ERROR',
      isOperational: false,
    });
  }
  const unit = match[2] ?? '';
  const multipliers: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };
  return Number(match[1]) * multipliers[unit]!;
}

/** The minimal JWT claim set — deliberately closed for extension. */
interface AccessJwtPayload {
  /** Subject: the user id as a string. */
  sub: string;
  /** Token type discriminator. */
  type: 'access';
  iat: number;
  exp: number;
}

/**
 * Signs a short-lived access JWT for a user. The only claims are sub/type/
 * iat/exp — everything authorization-related is resolved from the database
 * per request so revocation (status changes, tokenVersion bumps) takes
 * effect immediately rather than at token expiry.
 */
export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({ type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(accessSecret);
}

/**
 * Verifies an access JWT and returns the typed payload. Throws
 * AppError.unauthorized on any failure (bad signature, expired, wrong type) —
 * the middleware never leaks *why*.
 */
export async function verifyAccessToken(token: string): Promise<AccessJwtPayload> {
  try {
    const { payload } = await jwtVerify(token, accessSecret);
    const typed = payload as unknown as AccessJwtPayload;
    if (typed.type !== 'access' || typeof typed.sub !== 'string' || typed.sub.length === 0) {
      throw new Error('unexpected claims');
    }
    return typed;
  } catch {
    throw AppError.unauthorized();
  }
}

/**
 * Generates a cryptographically random opaque refresh token (raw form, 64 hex
 * chars). Callers persist ONLY `hashToken(raw)` and hand the raw value to the
 * client (cookie/JSON) exactly once.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 hex of a raw token — the database form for all long-lived tokens. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Constant-time comparison of a raw token against a stored hash. Refresh
 * tokens are high-entropy opaque strings, so a plain hash equality lookup is
 * already safe; this helper documents the intent and keeps token comparison
 * in one place.
 */
export function tokensMatch(raw: string, storedHash: string): boolean {
  return hashToken(raw) === storedHash;
}

/** Hashes a plaintext password (bcrypt, cost 12). */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Verifies a plaintext password against a stored hash. Returns false (never
 * throws) for missing hashes — accounts without a local credential
 * (future SSO-only) simply fail credential comparison.
 */
export async function verifyPassword(plain: string, passwordHash: string | undefined): Promise<boolean> {
  if (passwordHash === undefined || passwordHash.length === 0) return false;
  return bcrypt.compare(plain, passwordHash);
}
