import {
  Schema,
  model,
  type CallbackWithoutResultAndOptionalError,
  type Model,
  type Query,
} from 'mongoose';

import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_RANKS,
  TICKET_STATUSES,
  type TicketDocument,
  type TicketPriority,
} from './ticket.types.js';

/** Hard bounds for the `tags` array — prevents unbounded-array write abuse. */
export const MAX_TICKET_TAGS = 20;
const MAX_TAG_LENGTH = 40;

/** The live-only scope bypass (same convention as customers). */
export const WITH_ARCHIVE = { withArchive: true } as const;

/** Duplicate-key races get this many whole-create retries before failing. */
export const TICKET_NUMBER_ALLOCATION_RETRIES = 3;

/**
 * Query option that bypasses the live-only scope (archived ticket listing).
 */
interface TicketQueryOptions {
  withArchive?: boolean;
}

/**
 * Ticket — tenant-scoped support request (see ticket.types.ts for the domain
 * shape and ticket-counter.model.ts for number allocation).
 *
 * Archive decision: tickets reuse the customers soft-delete convention
 * (`deletedAt` + live-only pre-query hook + explicit opt-out). Closed ≠
 * archived: a closed ticket is a finished LIVE ticket (still listed by
 * default); archiving removes it from the ordinary views while keeping the
 * record for history/reports. There is deliberately NO hard delete.
 *
 * The `priority` → `priorityRank` derivation is the model's single piece of
 * duplicated state, and only because MongoDB cannot sort enum strings by
 * intended weight; the hook keeps it always-consistent and unreachable by
 * any client payload (no route accepts priorityRank).
 */
const ticketSchema = new Schema<TicketDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    number: {
      type: String,
      required: [true, 'Ticket number is required'],
      uppercase: true,
      trim: true,
      // Allocated by ticket-counter.model.ts, never by clients.
      immutable: true,
      match: [/^TKT-\d{6,}$/, 'Ticket number must match TKT-######'],
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'Customer reference is required'],
    },
    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      minlength: 1,
      maxlength: 10_000,
    },
    status: {
      type: String,
      enum: TICKET_STATUSES,
      default: 'OPEN',
      required: true,
    },
    priority: {
      type: String,
      enum: TICKET_PRIORITIES,
      default: 'MEDIUM',
      required: true,
    },
    priorityRank: {
      type: Number,
      required: true,
      min: 1,
      max: 4,
    },
    agentId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Creator reference is required'],
    },
    tags: {
      type: [String],
      default: [],
      set: (tags: string[]): string[] => [...new Set(tags.map((t) => t.trim()).filter(Boolean))],
      validate: {
        validator: (tags: string[]): boolean =>
          tags.length <= MAX_TICKET_TAGS && tags.every((t) => t.length <= MAX_TAG_LENGTH),
        message: `A ticket can have at most ${MAX_TICKET_TAGS} tags of ${MAX_TAG_LENGTH} characters`,
      },
    },
    category: {
      type: String,
      trim: true,
      maxlength: 64,
    },
    resolutionNote: {
      type: String,
      trim: true,
      maxlength: 10_000,
    },
    dueAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

/**
 * Keeps `priorityRank` glued to `priority`. Fires on saves AND
 * `findOneAndUpdate` updates (the repository writes priority only through a
 * scoped `findOneAndUpdate`), so priority and its rank can never drift
 * apart — the rank field is never accepted from a payload.
 */
ticketSchema.pre('validate', function syncPriorityRank(): void {
  const priority = this.get('priority') as TicketPriority | undefined;
  if (priority !== undefined && priority !== null) {
    this.set('priorityRank', TICKET_PRIORITY_RANKS[priority]);
  }
});

ticketSchema.pre('findOneAndUpdate', function syncPriorityRankOnUpdate(): void {
  const update = this.getUpdate() as Record<string, unknown> | null | undefined;
  if (update === null || update === undefined) return;
  const priority = (update['$set'] as Record<string, unknown> | undefined)?.['priority'] ?? update['priority'];
  if (typeof priority === 'string') {
    // Query#set() on an update query adds to `$set` — the update-side mirror
    // of the document hook above.
    this.set({ priorityRank: TICKET_PRIORITY_RANKS[priority as TicketPriority] });
  }
});

/**
 * Live-only default scope (mirrors customers): every read excludes archived
 * tickets unless the query (a) mentions `deletedAt` itself (an explicit
 * archived-only slice) or (b) opted out with the `withArchive` option.
 */
ticketSchema.pre(
  ['find', 'findOne', 'countDocuments'],
  function excludeArchivedTickets(
    this: Query<unknown, TicketDocument>,
    next: CallbackWithoutResultAndOptionalError,
  ): void {
    const options = this.getOptions() as unknown as TicketQueryOptions;
    if (options.withArchive !== true && this.getFilter().deletedAt === undefined) {
      this.where({ deletedAt: null });
    }
    next();
  },
);

/**
 * Index strategy (all lead with `workspaceId` per the tenancy convention):
 * - `{ workspaceId, number }` unique: the ticket-number uniqueness LAW (not
 *   just a hint) and the fastest "open ticket TKT-000042" lookup.
 * - `{ workspaceId, status, priorityRank, createdAt }`: the default triage
 *   board read — filter by status, order by urgency then age.
 * - `{ workspaceId, customerId, createdAt }`: "all tickets for this customer"
 *   (customer detail page; Prompt 9 conversation linking).
 * - `{ workspaceId, agentId, updatedAt }`: the agent's work queue.
 * - `{ workspaceId, createdAt }`/`{ workspaceId, updatedAt }`: date-range
 *   filters and newest/updated sort fallbacks.
 *
 * Search: subject substring uses regex scan of the tenant slice (same
 * documented tradeoff as customers); a text index is deliberately deferred
 * until the Atlas Search phase.
 */
ticketSchema.index(
  { workspaceId: 1, number: 1 },
  { unique: true, name: 'uniq_ticket_number_per_workspace' },
);
ticketSchema.index(
  { workspaceId: 1, status: 1, priorityRank: -1, createdAt: -1 },
  { name: 'idx_tickets_board' },
);
ticketSchema.index(
  { workspaceId: 1, customerId: 1, createdAt: -1 },
  { name: 'idx_tickets_by_customer' },
);
ticketSchema.index(
  { workspaceId: 1, agentId: 1, updatedAt: -1 },
  { name: 'idx_tickets_by_agent' },
);
ticketSchema.index({ workspaceId: 1, createdAt: -1 }, { name: 'idx_tickets_by_created' });
ticketSchema.index({ workspaceId: 1, updatedAt: -1 }, { name: 'idx_tickets_by_updated' });

export const TicketModel = model<TicketDocument, Model<TicketDocument>>(
  'Ticket',
  ticketSchema,
  'tickets',
);
