import { AppError } from '../../core/errors/app-error.js';
import { SLUG_PATTERN } from '../../database/schema-validators.js';

/**
 * Workspace slug utilities — the platform-wide URL-safe tenant identifier.
 *
 * Slug rules (also enforced at the model boundary by SLUG_PATTERN + the
 * `uniq_workspace_slug` unique index; both layers are deliberate — HTTP 422s
 * early, the DB catches anything that races past):
 *
 *   - lowercase letters and digits, with single inner hyphens
 *     (`^[a-z0-9]+(?:-[a-z0-9]+)*$`);
 *   - 3–63 characters (DNS-label sized so a slug can front a subdomain later);
 *   - leading/trailing hyphens and repeated hyphens are rejected;
 *   - slugs are IMMUTABLE after creation — they name the tenant in URLs.
 *
 * Uniqueness is Database-enforced, never a pre-insert existence check (which
 * races under concurrent creation). Duplicate detection translates the Mongo
 * duplicate-key error — a lost race yields a 409 for client-supplied slugs or
 * a suffixed retry for auto-generated ones, and raw driver errors never reach
 * the client (see workspace.repository.ts).
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;
/** Bounded retry budget for auto-slug suffixes (see autoSlugCandidates). */
export const SLUG_AUTO_RETRY_LIMIT = 5;

/** Length of the random hex suffix appended on auto-slug collisions. */
export const SLUG_SUFFIX_LENGTH = 6;

/**
 * A slug candidate resolved to its strategy:
 * - `client`: supplied by the caller — duplicates are a hard 409.
 * - `auto`: derived from the name (deterministically), with suffixed retries.
 */
export interface ValidatedSlug {
  kind: 'client' | 'auto';
  value: string;
}

/**
 * Normalizes a client-supplied slug: trims, lowercases, converts spaces and
 * underscores to hyphens, collapses repeats, and strips edge separators.
 * Validity is checked separately so callers can render precise 422 details.
 */
export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Validates a NORMALIZED slug against the platform slug rules. */
export function isValidSlug(candidate: string): boolean {
  return (
    candidate.length >= SLUG_MIN_LENGTH &&
    candidate.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(candidate)
  );
}

export function slugValidationError(candidate: string): string {
  if (candidate.length < SLUG_MIN_LENGTH) {
    return `Slug must be at least ${SLUG_MIN_LENGTH} characters`;
  }
  if (candidate.length > SLUG_MAX_LENGTH) {
    return `Slug must be at most ${SLUG_MAX_LENGTH} characters`;
  }
  return 'Slug may contain lowercase letters, digits and single hyphens only';
}

/**
 * Deterministic slug base derived from a workspace name (used when the client
 * did not supply one): separators → hyphens, slug-safe characters kept, edges
 * stripped, truncated to SLUG_MAX_LENGTH.
 *
 * Returns null when the name carries no slug-safe characters — the caller
 * supplies an explicit slug (validation rejects an unusable name early with a
 * 422, so this is a terminal safety net rather than a runtime pathway).
 */
export function slugifyName(raw: string): string | null {
  const base = normalizeSlug(raw)
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const truncated = base.slice(0, SLUG_MAX_LENGTH).replace(/^-+|-+$/g, '');
  return isValidSlug(truncated) ? truncated : null;
}

/**
 * Throws the user-facing 409 after a client-supplied slug already exists.
 * Called by the repository once the duplicate-key error arrives — the message
 * stays honest (existence comes from the unique index, not a pre-check).
 */
export function duplicateSlugError(): AppError {
  return AppError.conflict('A workspace with this slug already exists');
}
