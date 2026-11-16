import { z } from 'zod';

/**
 * Escalation API validation — allowlisted, bounded Zod schemas following the
 * conventions of agent.validation.ts / conversation.validation.ts. The
 * workspace path parameter is validated like every workspace-scoped route;
 * conversation/escalation/assignee references are 24-hex ids whose OWNERSHIP
 * the SERVICE verifies against the authorized workspace (never trusted).
 */

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-hex-character ObjectId');

export const escalationParamsSchema = z
  .object({
    workspaceId: objectIdSchema,
    escalationId: objectIdSchema,
  })
  .strict();
export interface EscalationParams {
  readonly workspaceId: string;
  readonly escalationId: string;
}

export const escalationWorkspaceParamsSchema = z
  .object({ workspaceId: objectIdSchema })
  .strict();
export interface EscalationWorkspaceParams {
  readonly workspaceId: string;
}

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * Manual staff escalation. Only the CONVERSATION is addressable by the
 * client — its ticket and customer references are resolved server-side from
 * the verified conversation (structurally impossible to cross tenants or
 * point the handoff at a foreign ticket).
 */
export const createEscalationSchema = z
  .object({
    conversationId: objectIdSchema,
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    /** Bounded human reason for the escalation (lifecycle-history detail). */
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export interface CreateEscalationInput {
  readonly conversationId: string;
  readonly priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  readonly note?: string;
}

// ── Listing ──────────────────────────────────────────────────────────────────

const pagingSchema = {
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

/** ISO-8601 datetime (offset allowed) — the project's date-input convention. */
const isoDateSchema = z.string().trim().datetime({ offset: true });

/**
 * Listing query (Prompt 17 extended it with search, reference and date
 * filters plus an allowlisted sort). Every value here is a SCALAR the service
 * maps onto allowlisted repository fields — no client object ever reaches
 * Mongo, and unknown keys are rejected by `.strict()`.
 */
export const listEscalationsQuerySchema = z
  .object({
    ...pagingSchema,
    status: z.enum(['PENDING', 'ASSIGNED', 'ACCEPTED', 'RESOLVED', 'CANCELLED']).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    triggerType: z
      .enum([
        'AI_INSUFFICIENT_KNOWLEDGE',
        'HUMAN_REQUEST',
        'SENSITIVE_TOPIC',
        'AI_REPEATED_FAILURE',
        'TECHNICAL_FAILURE',
        'MANUAL',
      ])
      .optional(),
    assignedToId: objectIdSchema.optional(),
    /** Literal substring over reason/topic machine codes (workspace-scoped). */
    search: z.string().trim().min(1).max(100).optional(),
    ticketId: objectIdSchema.optional(),
    conversationId: objectIdSchema.optional(),
    customerId: objectIdSchema.optional(),
    createdFrom: isoDateSchema.optional(),
    createdTo: isoDateSchema.optional(),
    sort: z.enum(['createdAt', 'updatedAt', 'priority']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.createdFrom === undefined ||
      query.createdTo === undefined ||
      new Date(query.createdFrom).getTime() <= new Date(query.createdTo).getTime(),
    { message: 'createdFrom must not be after createdTo', path: ['createdFrom'] },
  );
export interface ListEscalationsQuery {
  readonly page: number;
  readonly limit: number;
  readonly status?: 'PENDING' | 'ASSIGNED' | 'ACCEPTED' | 'RESOLVED' | 'CANCELLED';
  readonly priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  readonly triggerType?:
    | 'AI_INSUFFICIENT_KNOWLEDGE'
    | 'HUMAN_REQUEST'
    | 'SENSITIVE_TOPIC'
    | 'AI_REPEATED_FAILURE'
    | 'TECHNICAL_FAILURE'
    | 'MANUAL';
  readonly assignedToId?: string;
  readonly search?: string;
  readonly ticketId?: string;
  readonly conversationId?: string;
  readonly customerId?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly sort?: 'createdAt' | 'updatedAt' | 'priority';
  readonly order?: 'asc' | 'desc';
}

// ── Lifecycle actions ────────────────────────────────────────────────────────

export const assignEscalationSchema = z
  .object({ assigneeId: objectIdSchema })
  .strict();
export interface AssignEscalationInput {
  readonly assigneeId: string;
}

export const acceptEscalationSchema = z.object({}).strict();
export interface AcceptEscalationInput {
  readonly unused?: never;
}

export const resolveEscalationSchema = z
  .object({
    /** Bounded conclusion summary (plain text; capped to keep the record light). */
    resolutionNote: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
export interface ResolveEscalationInput {
  readonly resolutionNote?: string;
}

export const cancelEscalationSchema = z
  .object({
    /** Bounded cancellation reason — audited as a reason presence flag, never content. */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export interface CancelEscalationInput {
  readonly reason?: string;
}
