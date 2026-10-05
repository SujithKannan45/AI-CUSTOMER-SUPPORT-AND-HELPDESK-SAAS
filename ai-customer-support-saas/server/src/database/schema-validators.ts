/**
 * Shared schema-level validators.
 *
 * Field constraints that more than one model needs live here so every model
 * enforces identical rules (e.g. the same email shape for platform users and
 * workspace customers). Model-specific rules stay inside the model file.
 *
 * These are the database boundary — the last line of defense — and must never
 * be trusted as the only validation layer (Zod request validation happens
 * earlier in controllers/routes).
 */

/**
 * Pragmatic email shape: local part + domain + TLD. Deliberately not the full
 * RFC 5322 grammar — the goal is rejecting obvious garbage, not blocking
 * exotic-but-valid addresses.
 */
export const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/** Absolute http(s) URL — used for avatars and other external references. */
export const URL_PATTERN = /^https?:\/\/\S+$/;

/**
 * Loose E.164-ish phone shape: optional leading `+`, then 5–20 digits with
 * common separators. Keeps international numbers valid without pretending to
 * parse country codes.
 */
export const PHONE_PATTERN = /^\+?[0-9\s\-().]{5,20}$/;

/**
 * URL-safe tenant slug: lowercase letters/digits, single inner hyphens,
 * 3–63 characters (DNS-label sized so it can front a subdomain later).
 * Models must pair this with `lowercase: true, trim: true` on the path.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Lowercase dotted identifier for the audit taxonomy (`action`,
 * `resourceType`), e.g. `member.added`, `workspace.settings_changed`.
 * Dots give namespacing (`<domain>.<verb>`); letters/digits/._- only, so the
 * values stay grep- and dashboard-friendly.
 */
export const DOTTED_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
