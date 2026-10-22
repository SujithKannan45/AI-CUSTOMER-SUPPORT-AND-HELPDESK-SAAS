import { model, Schema, type Types } from 'mongoose';

import { tenantFilter } from '../../database/tenant.js';

/** Ticket-number prefix — same constant the model's `number` pattern allows. */
const TICKET_NUMBER_PREFIX = 'TKT';

/**
 * Ticket-number allocation — per-workspace monotonic sequence.
 *
 * Strategy: a tiny dedicated `ticket_counters` collection, one document per
 * workspace (`{ workspaceId }` unique), incremented with an ATOMIC
 * `findOneAndUpdate` + `$inc` + upsert. Properties:
 *
 * - Concurrency-safe: `$inc` is atomic in MongoDB; two concurrent creations
 *   in one workspace receive two distinct sequences without transactions.
 * - Not a `count()` of tickets: deleting/archiving a ticket can never rewind
 *   the sequence, and the number is stable under any future retention job.
 * - Not timestamp-derived: two tickets created in the same millisecond get
 *   distinct numbers.
 * - Uniqueness is still ENFORCED by the database — the unique compound index
 *   `uniq_ticket_number_per_workspace` (ticket.model.ts) is the last resort;
 *   a lost race maps to an allocation retry (TICKET_NUMBER_ALLOCATION_RETRIES).
 *
 * The human-readable form is `TKT-000001` — prefix + zero-padded sequence.
 * Same workspaces never collide; different workspaces can reuse the same
 * number freely (scoped uniqueness, mirrored in the index).
 *
 * Transactions: per-workspace allocation relies only on document-level
 * atomicity (`$inc`), NOT multi-document transactions — so it works on any
 * MongoDB deployment (standalone included) and does not claim transactional
 * guarantees beyond what is exercised here.
 */

/** Counter document — internal bookkeeping, never exposed over HTTP. */
interface TicketCounterDocument {
  workspaceId: Types.ObjectId;
  /** Monotonic per-workspace sequence; starts at 1 with the first ticket. */
  seq: number;
}

const ticketCounterSchema = new Schema<TicketCounterDocument>({
  workspaceId: {
    type: Schema.Types.ObjectId,
    ref: 'Workspace',
    required: [true, 'Workspace reference is required'],
  },
  seq: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
});

// One counter document per workspace — identical shape to the tenancy convention.
ticketCounterSchema.index({ workspaceId: 1 }, { unique: true, name: 'uniq_counter_per_workspace' });

const TicketCounterModel = model<TicketCounterDocument>(
  'TicketCounter',
  ticketCounterSchema,
  'ticket_counters',
);

/** Zero-padded width of the sequence inside a ticket number. */
const TICKET_NUMBER_WIDTH = 6;

/** Formats a sequence as the human-readable, workspace-scoped ticket number. */
export function formatTicketNumber(sequence: number): string {
  return `${TICKET_NUMBER_PREFIX}-${String(sequence).padStart(TICKET_NUMBER_WIDTH, '0')}`;
}

/**
 * Reserves the next sequence for this workspace and returns the ticket
 * number. Atomic per call; callers retry on the (theoretically unreachable)
 * duplicate-key race instead of racing here.
 */
export async function nextTicketNumber(workspaceId: Types.ObjectId): Promise<string> {
  const counter = await TicketCounterModel.findOneAndUpdate(
    tenantFilter(workspaceId),
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return formatTicketNumber(counter.seq);
}

/**
 * True when the error is a duplicate-key on the ticket `number` field
 * specifically (index `uniq_ticket_number_per_workspace`) — the signal the
 * allocation retry loop waits for. Any other duplicate key (none possible on
 * this collection) is NOT matched.
 */
export function isDuplicateTicketNumberError(error: unknown): boolean {
  const candidate = error as { code?: unknown; keyValue?: Record<string, unknown> } | null;
  if (candidate === null || typeof candidate !== 'object') return false;
  if (candidate['code'] !== 11000) return false;
  return candidate['keyValue']?.['number'] !== undefined;
}
