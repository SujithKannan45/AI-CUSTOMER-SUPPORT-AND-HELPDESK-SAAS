import { z } from 'zod';

import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from './ticket.types.js';

/**
 * Ticket request validation (Zod, applied declaratively at the routes).
 *
 * Rules mirror the Ticket model so HTTP-layer failures are 422s while
 * anything that slips past is still caught at the schema boundary.
 *
 * Mass-assignment protection: every schema is `.strict()` and defines ONLY
 * the accepted keys — `_id`, `workspaceId`, `number`, `status`, `priority`,
 * lifecycle/audit timestamps (`resolvedAt`, `closedAt`, `deletedAt`,
 * `createdAt`, `updatedAt`) and any unknown field are REJECTED before a
 * service ever sees the payload. Lifecycle fields move only through their
 * dedicated endpoints, and workspace association always comes from the
 * validated workspace context (middleware), never the body.
 */
export const TICKET_SUBJECT_MAX = 200;
export const TICKET_DESCRIPTION_MAX = 10_000;
export const TICKET_CATEGORY_MAX = 64;
export const MAX_TICKET_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_SEARCH_LENGTH = 100;
export const MAX_PAGE_SIZE = 50;
export const MAX_RESOLUTION_NOTE_LENGTH = 10_000;

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex string');

const subjectSchema = z.string().trim().min(1, 'Subject is required').max(TICKET_SUBJECT_MAX);
const descriptionSchema = z
  .string()
  .trim()
  .min(1, 'Description is required')
  .max(TICKET_DESCRIPTION_MAX);

const tagsSchema = z
  .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
  .max(MAX_TICKET_TAGS, `A ticket can have at most ${MAX_TICKET_TAGS} tags`);

const categorySchema = z.string().trim().min(1).max(TICKET_CATEGORY_MAX);

/** ISO-8601 datetime (offset allowed) — the project's date-input convention. */
const isoDateSchema = z.string().trim().datetime({ offset: true });

// ── Identification ───────────────────────────────────────────────────────────

/**
 * Params for ticket routes (mounted under
 * `/api/v1/workspaces/:workspaceId/tickets`): BOTH ids must be 24-char hex.
 * Malformed ids are 422s; well-formed-but-unknown ids are 404s at the service
 * layer.
 */
export const ticketIdParamSchema = z
  .object({
    workspaceId: objectIdSchema,
    ticketId: objectIdSchema,
  })
  .strict();

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * NOTE: `agentId` is accepted only so the service can honor an explicit
 * assignment at OPEN time; the service re-checks the actor actually holds
 * `ticket.assign` (an agent creating a ticket may NOT self-assign it to a
 * colleague through creation) and verifies the assignee is an eligible
 * member of THIS workspace.
 */
export const createTicketSchema = z
  .object({
    customerId: objectIdSchema,
    subject: subjectSchema,
    description: descriptionSchema,
    priority: z.enum(TICKET_PRIORITIES).optional(),
    agentId: objectIdSchema.optional(),
    tags: tagsSchema.optional(),
    category: categorySchema.optional(),
    dueAt: isoDateSchema.optional(),
  })
  .strict();

export interface CreateTicketInput {
  customerId: string;
  subject: string;
  description: string;
  priority?: (typeof TICKET_PRIORITIES)[number];
  agentId?: string;
  tags?: string[];
  category?: string;
  dueAt?: string;
}

// ── Update (PATCH /:ticketId) ────────────────────────────────────────────────

export const updateTicketSchema = z
  .object({
    subject: subjectSchema.optional(),
    description: descriptionSchema.optional(),
    tags: tagsSchema.optional(),
    category: categorySchema.optional(),
    dueAt: isoDateSchema.optional(),
    customerId: objectIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    { message: 'Provide at least one editable ticket field' },
  );

export interface UpdateTicketInput {
  subject?: string;
  description?: string;
  tags?: string[];
  category?: string;
  dueAt?: string;
  customerId?: string;
}

// ── Status / priority / assignment / resolve ──────────────────────────────────

export const setTicketStatusSchema = z
  .object({ status: z.enum(TICKET_STATUSES) })
  .strict();

export interface SetTicketStatusInput {
  status: TicketStatus;
}

export const setTicketPrioritySchema = z
  .object({ priority: z.enum(TICKET_PRIORITIES) })
  .strict();

export interface SetTicketPriorityInput {
  priority: TicketPriority;
}

/**
 * Assignment: `agentId: null` unassigns. The service verifies a non-null
 * assignee is an ACTIVE member of THIS workspace eligible for desk work.
 */
export const setTicketAssignmentSchema = z
  .object({ agentId: objectIdSchema.nullable() })
  .strict();

export interface SetTicketAssignmentInput {
  agentId: string | null;
}

export const resolveTicketSchema = z
  .object({
    resolutionNote: z.string().trim().max(MAX_RESOLUTION_NOTE_LENGTH).optional(),
  })
  .strict();

export interface ResolveTicketInput {
  resolutionNote?: string;
}

// ── Listing ──────────────────────────────────────────────────────────────────

/**
 * Sort allowlist — ONLY these fields are ever sent to MongoDB as sort keys.
 * `priority` maps to the derived `priorityRank` field (see ticket.model.ts);
 * `_id` (same direction) is the deterministic tiebreak added by the
 * repository.
 */
export const TICKET_SORT_FIELDS = ['createdAt', 'updatedAt', 'priority', 'number'] as const;
export type TicketSortField = (typeof TICKET_SORT_FIELDS)[number];

/** Which archived slices a listing reads (customers convention). */
export const ARCHIVE_STATES = ['live', 'archived', 'all'] as const;
export type ArchiveState = (typeof ARCHIVE_STATES)[number];

export const listTicketsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE, `Page size must be at most ${MAX_PAGE_SIZE}`)
      .default(20),
    /** Substring match over ticket NUMBER or SUBJECT (workspace-scoped). */
    search: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).optional(),
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    /** Exact customer match (24-hex id). */
    customerId: objectIdSchema.optional(),
    /** Exact assigned agent match (24-hex user id). */
    agentId: objectIdSchema.optional(),
    /** Comma-separated tag list; a ticket must carry ALL given tags. */
    tags: z
      .string()
      .trim()
      .min(1)
      .transform((raw) => raw.split(',').map((tag) => tag.trim()).filter(Boolean))
      .pipe(tagsSchema.max(MAX_TICKET_TAGS))
      .optional(),
    sort: z.enum(TICKET_SORT_FIELDS).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    createdFrom: isoDateSchema.optional(),
    createdTo: isoDateSchema.optional(),
    updatedFrom: isoDateSchema.optional(),
    updatedTo: isoDateSchema.optional(),
    archiveState: z.enum(ARCHIVE_STATES).default('live'),
  })
  .strict()
  .refine(
    (query) =>
      query.createdFrom === undefined ||
      query.createdTo === undefined ||
      new Date(query.createdFrom).getTime() <= new Date(query.createdTo).getTime(),
    { message: 'createdFrom must not be after createdTo' },
  )
  .refine(
    (query) =>
      query.updatedFrom === undefined ||
      query.updatedTo === undefined ||
      new Date(query.updatedFrom).getTime() <= new Date(query.updatedTo).getTime(),
    { message: 'updatedFrom must not be after updatedTo' },
  );

export interface ListTicketsQuery {
  page: number;
  limit: number;
  search?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;
  agentId?: string;
  tags?: string[];
  sort: TicketSortField;
  order: 'asc' | 'desc';
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  archiveState: ArchiveState;
}
