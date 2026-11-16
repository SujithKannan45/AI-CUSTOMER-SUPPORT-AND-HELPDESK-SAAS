import { z } from 'zod';

/**
 * Shared search primitives (Prompt 17).
 *
 * Why this module exists: before Prompt 17 every listing module hand-rolled
 * the same `term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` escape and its own
 * page/limit pair. Duplicated escaping is how a regex-injection bug survives
 * in one module after being fixed in another, so the escape lives in exactly
 * one place and every searcher composes through it. Pagination keeps the
 * project's pre-existing page/limit contract (documented in
 * docs/architecture.md) — each module's own schema defines its cap.
 *
 * Capability honesty: this deployment has NO Atlas Search, text index,
 * Elasticsearch or vector-backed application search. Search here is MongoDB
 * regex matching over an allowlisted field set, always composed INSIDE the
 * repository's `tenantFilter()` scope. Substring regex cannot use a B-tree
 * index, so a search scans the calling workspace's slice (bounded by tenant
 * size and the page limit) — a documented limitation, not a hidden one.
 */

/** Longest accepted search term. Keeps regex work and query strings bounded. */
export const MAX_SEARCH_TERM_LENGTH = 100;

/**
 * Escapes every regex metacharacter so a user term is matched as LITERAL
 * text. This is the only escaping implementation in the backend: search input
 * can never become an executable pattern (regex injection / ReDoS surface).
 */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

export function escapeRegexLiteral(term: string): string {
  return term.replace(REGEX_METACHARACTERS, '\\$&');
}

/** A case-insensitive literal-substring condition (`$regex` + `$options`). */
export interface LiteralRegexCondition {
  readonly $regex: string;
  readonly $options: 'i';
}

export function literalRegex(term: string): LiteralRegexCondition {
  return { $regex: escapeRegexLiteral(term), $options: 'i' };
}

/**
 * Builds the `$or` clause for a multi-field literal search. Field names are
 * supplied by the repository (never by a client), so no user-controlled key
 * can reach the Mongo query.
 */
export function literalSearchOr(
  fields: readonly string[],
  term: string,
): Record<string, LiteralRegexCondition>[] {
  const condition = literalRegex(term);
  return fields.map((field) => ({ [field]: condition }));
}

/** Shared bounded search-term schema (trimmed, non-empty, ≤ 100 chars). */
export function searchTermSchema(maxLength: number = MAX_SEARCH_TERM_LENGTH): z.ZodString {
  return z
    .string()
    .trim()
    .min(1, 'Search term must not be empty')
    .max(maxLength, `Search term must be at most ${maxLength} characters`);
}

