import { z } from 'zod';

import { EMAIL_PATTERN, PHONE_PATTERN, URL_PATTERN } from '../../database/schema-validators.js';

import { CUSTOMER_STATUSES } from './customer.types.js';

/**
 * Customer request validation (Zod, applied declaratively at the routes).
 *
 * Rules mirror the Customer model so HTTP-layer failures are 422s while
 * anything that slips past is still caught at the schema boundary.
 *
 * Mass-assignment protection: every schema is `.strict()` and defines ONLY
 * the accepted keys — `_id`, `workspaceId`, `createdAt`, `updatedAt`,
 * `deletedAt` and any unknown field are REJECTED before a service ever sees
 * the payload. Workspace association always comes from the validated
 * workspace context (middleware), never from the body.
 */
export const CUSTOMER_NAME_MAX = 120;
export const MAX_CUSTOMER_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_METADATA_KEYS = 20;
export const MAX_METADATA_VALUE_LENGTH = 255;
export const MAX_SEARCH_LENGTH = 100;
export const MAX_PAGE_SIZE = 50;

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Customer name is required')
  .max(CUSTOMER_NAME_MAX);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email must be at most 254 characters')
  .regex(EMAIL_PATTERN, 'Customer email is not a valid address');

const phoneSchema = z
  .string()
  .trim()
  .max(20, 'Phone must be at most 20 characters')
  .regex(PHONE_PATTERN, 'Phone must be 5–20 digits with optional + and separators');

const avatarUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(URL_PATTERN, 'Avatar URL must be an absolute http(s) URL');

/**
 * Tag schema — trimmed, non-empty, bounded per the model. Deduplication is
 * deferred to the model's set hook; validation only bounds the shape.
 */
const tagsSchema = z
  .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
  .max(MAX_CUSTOMER_TAGS, `A customer can have at most ${MAX_CUSTOMER_TAGS} tags`);

/**
 * Metadata values are application-managed integration keys (e.g. crmId) and
 * must stay primitive, bounded and secret-free: objects/arrays Make it
 * possible to smuggle nested content; only string/number/boolean/null pass.
 */
const metadataValueSchema = z.union([
  z.string().max(MAX_METADATA_VALUE_LENGTH),
  z.number(),
  z.boolean(),
  z.null(),
]);

const metadataSchema = z
  .record(z.string().trim().min(1).max(64), metadataValueSchema)
  .refine(
    (map) => Object.keys(map).length <= MAX_METADATA_KEYS,
    `Metadata can have at most ${MAX_METADATA_KEYS} keys`,
  );

// ── Create ───────────────────────────────────────────────────────────────────

/** Email is optional by design (chat-widget visitors may arrive anonymous). */
export const createCustomerSchema = z
  .object({
    name: nameSchema,
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    avatarUrl: avatarUrlSchema.optional(),
    status: z.enum(CUSTOMER_STATUSES).optional(),
    tags: tagsSchema.optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export interface CreateCustomerInput {
  name: string;
  email?: string;
  phone?: string;
  avatarUrl?: string;
  status?: (typeof CUSTOMER_STATUSES)[number];
  tags?: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

// ── Update ───────────────────────────────────────────────────────────────────
//
// Explicitly editable fields only; lifecycle fields (deletedAt) are managed
// by the dedicated archive/restore endpoints, never through this schema.
// `null` explicitly CLEARS an optional field — mapped to `$unset` in the
// repository so clearing is impossible to mistake for a no-op.

const nullable = <T extends z.ZodType>(schema: T): z.ZodType<unknown> =>
  schema.nullable().optional();

export const updateCustomerSchema = z
  .object({
    name: nullable(nameSchema),
    email: nullable(emailSchema),
    phone: nullable(phoneSchema),
    avatarUrl: nullable(avatarUrlSchema),
    status: nullable(z.enum(CUSTOMER_STATUSES)),
    tags: nullable(tagsSchema),
    metadata: nullable(metadataSchema),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    { message: 'Provide at least one editable customer field' },
  );

export interface UpdateCustomerInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  status?: (typeof CUSTOMER_STATUSES)[number] | null;
  tags?: string[] | null;
  metadata?: Record<string, string | number | boolean | null> | null;
}

// ── Identification ───────────────────────────────────────────────────────────

/**
 * Params for customer routes (mounted under
 * `/api/v1/workspaces/:workspaceId/customers`): BOTH ids are required to be
 * 24-character hex strings. Malformed ids are 422s (validation convention);
 * well-formed-but-unknown ids are 404s at the service layer.
 */
const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex string');

export const customerIdParamSchema = z
  .object({
    workspaceId: objectIdSchema,
    customerId: objectIdSchema,
  })
  .strict();

// ── Listing ──────────────────────────────────────────────────────────────────

/**
 * Sort allowlist — ONLY these fields are ever sent to MongoDB as sort keys,
 * so client input cannot sort on internals (or inject operator-shaped junk).
 * `_id` (same direction) is the deterministic tiebreak added by the
 * repository for a stable total order.
 */
export const CUSTOMER_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'email',
  'lastInteractionAt',
] as const;
export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

/** Which soft-deleted (archived) slices a listing reads. */
export const ARCHIVE_STATES = ['live', 'archived', 'all'] as const;
export type ArchiveState = (typeof ARCHIVE_STATES)[number];

const isoDateSchema = z.string().trim().datetime({ offset: true });

export const listCustomersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE, `Page size must be at most ${MAX_PAGE_SIZE}`)
      .default(20),
    /** Case-insensitive substring match over name OR email (workspace-scoped). */
    search: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).optional(),
    status: z.enum(CUSTOMER_STATUSES).optional(),
    /** Comma-separated tag list; a customer must carry ALL given tags. */
    tags: z
      .string()
      .trim()
      .min(1)
      .transform((raw) => raw.split(',').map((tag) => tag.trim()).filter(Boolean))
      .pipe(tagsSchema.max(MAX_CUSTOMER_TAGS))
      .optional(),
    sort: z.enum(CUSTOMER_SORT_FIELDS).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    createdFrom: isoDateSchema.optional(),
    createdTo: isoDateSchema.optional(),
    archiveState: z.enum(ARCHIVE_STATES).default('live'),
  })
  .strict()
  .refine(
    (query) =>
      query.createdFrom === undefined ||
      query.createdTo === undefined ||
      new Date(query.createdFrom).getTime() <= new Date(query.createdTo).getTime(),
    { message: 'createdFrom must not be after createdTo' },
  );

export interface ListCustomersQuery {
  page: number;
  limit: number;
  search?: string;
  status?: (typeof CUSTOMER_STATUSES)[number];
  tags?: string[];
  sort: CustomerSortField;
  order: 'asc' | 'desc';
  createdFrom?: string;
  createdTo?: string;
  archiveState: ArchiveState;
}
