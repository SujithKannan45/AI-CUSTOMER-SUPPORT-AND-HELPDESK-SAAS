import { Types, type FilterQuery } from 'mongoose';

import { AppError } from '../../core/errors/index.js';
import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import { isDuplicateTicketNumberError, nextTicketNumber } from './ticket-counter.model.js';
import type { TicketListSpec } from './ticket.dto.js';
import { WITH_ARCHIVE, TICKET_NUMBER_ALLOCATION_RETRIES , TicketModel } from './ticket.model.js';
import type { TicketDocument, TicketStatus, TicketPriority } from './ticket.types.js';

/**
 * Persistence layer — the ONLY module that touches the `tickets` collection,
 * mirroring the customer repository conventions:
 *
 * - EVERY query is built through `tenantFilter()` and asserted with
 *   `assertTenantScope()` — a ticket query without a workspace scope is a
 *   programming error that surfaces as an opaque 500, never as another
 *   tenant's rows. The `_id` filter is ALWAYS composed inside this module so
 *   callers cannot fetch "an id" without the workspace discriminator:
 *   `{ …tenantFilter(workspaceId), _id: ticketId }` is both the check and
 *   the concealment (foreign ids read as not-found).
 * - Ticket numbers are allocated with a per-workspace atomic counter
 *   (ticket-counter.model.ts); the DB's unique compound index is the last
 *   resort, a lost race retries the whole create a bounded number of times.
 * - Status/priority/assignment mutations are SCOPED
 *   `findOneAndUpdate`s — never read-then-write from a document the caller
 *   handed us.
 */

/** Fields the repository writes at creation (validated upstream by Zod). */
export interface TicketCreateRecord {
  readonly customerId: Types.ObjectId;
  readonly subject: string;
  readonly description: string;
  readonly priority?: TicketPriority;
  readonly agentId?: Types.ObjectId | null;
  readonly createdById: Types.ObjectId;
  readonly tags?: string[];
  readonly category?: string;
  readonly dueAt?: Date;
}

/**
 * Creates one ticket with a freshly allocated workspace-scoped number.
 * The duplicate-key race on `number` retries the whole allocation
 * (counter $inc is atomic, so this is belt-and-braces) before surfacing a
 * non-operational error — a failed allocation is an infrastructure problem,
 * never a user input condition.
 */
export async function createTicketRecord(
  workspaceId: Types.ObjectId,
  record: TicketCreateRecord,
): Promise<TicketDocument> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TICKET_NUMBER_ALLOCATION_RETRIES; attempt += 1) {
    const number = await nextTicketNumber(workspaceId);
    try {
      return await TicketModel.create({
        ...tenantFilter(workspaceId),
        number,
        customerId: record.customerId,
        subject: record.subject,
        description: record.description,
        ...(record.priority !== undefined ? { priority: record.priority } : {}),
        ...(record.agentId !== undefined ? { agentId: record.agentId } : {}),
        createdById: record.createdById,
        ...(record.tags !== undefined ? { tags: record.tags } : {}),
        ...(record.category !== undefined ? { category: record.category } : {}),
        ...(record.dueAt !== undefined ? { dueAt: record.dueAt } : {}),
      });
    } catch (error) {
      if (isDuplicateTicketNumberError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw new AppError('Could not allocate a unique ticket number', {
    statusCode: 500,
    code: 'TICKET_NUMBER_ALLOCATION_FAILED',
    isOperational: false,
    cause: lastError,
  });
}

/**
 * Reads ONE ticket by id, scoped to its workspace. `null` for unknown ids,
 * foreign ids, or (by default) archived tickets — a single lookup answers
 * "does this ticket exist and may I see it" without leaking which.
 */
export async function findTicketInWorkspace(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
  options: { readonly includeArchived?: boolean } = {},
): Promise<TicketDocument | null> {
  const filter: FilterQuery<TicketDocument> = {
    ...tenantFilter(workspaceId),
    _id: ticketId,
  };
  assertTenantScope(filter, 'findTicketInWorkspace');
  const query = TicketModel.findOne(filter);
  return options.includeArchived === true ? query.setOptions(WITH_ARCHIVE) : query;
}

export interface TicketListResult {
  readonly items: readonly TicketDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * Listing filtered/sorted/paginated IN THE DATABASE (no in-memory splicing),
 * with a workspace-tenant scope and a deterministic `_id` tiebreak so
 * concurrent writes cannot duplicate or skip rows across pages.
 *
 * Archive slices (identical semantics to customers):
 * - `live` — model default (the pre-hook adds `deletedAt: null`).
 * - `archived` — the filter must mention `deletedAt` itself to pass the hook.
 * - `all` — the query opts out of the hook with `withArchive`.
 */
export async function listTickets(spec: TicketListSpec): Promise<TicketListResult> {
  const filter: Record<string, unknown> = { ...tenantFilter(spec.workspaceId) };

  if (spec.status !== undefined) filter['status'] = spec.status;
  if (spec.priority !== undefined) filter['priority'] = spec.priority;
  if (spec.customerId !== undefined) {
    filter['customerId'] = new Types.ObjectId(spec.customerId);
  }
  if (spec.agentId !== undefined) {
    filter['agentId'] = new Types.ObjectId(spec.agentId);
  }
  if (spec.tags !== undefined && spec.tags.length > 0) filter['tags'] = { $all: spec.tags };

  if (spec.search !== undefined) {
    // Case-insensitive substring over number OR subject. Escaped so regex
    // metacharacters in the search term match literally. Block-level
    // tradeoff (documented in the model): scans the tenant's slice —
    // replaced by Atlas Search when scale demands it.
    const escaped = spec.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter['$or'] = [
      { number: { $regex: escaped, $options: 'i' } },
      { subject: { $regex: escaped, $options: 'i' } },
    ];
  }

  if (spec.createdFrom !== undefined || spec.createdTo !== undefined) {
    filter['createdAt'] = {
      ...(spec.createdFrom !== undefined ? { $gte: spec.createdFrom } : {}),
      ...(spec.createdTo !== undefined ? { $lte: spec.createdTo } : {}),
    };
  }
  if (spec.updatedFrom !== undefined || spec.updatedTo !== undefined) {
    filter['updatedAt'] = {
      ...(spec.updatedFrom !== undefined ? { $gte: spec.updatedFrom } : {}),
      ...(spec.updatedTo !== undefined ? { $lte: spec.updatedTo } : {}),
    };
  }

  const withArchive = spec.archiveState === 'all';
  if (withArchive) {
    // No deletedAt filter at all WITH the opt-out option (hook then skips).
    delete filter['deletedAt'];
  } else if (spec.archiveState === 'archived') {
    filter['deletedAt'] = { $ne: null };
  }
  assertTenantScope(filter, 'listTickets');

  const direction = spec.order === 'asc' ? 1 : -1;
  // `priority` sorts on the derived numeric `priorityRank` (URGENT first
  // when descending); `number` sorts on the human-readable string.
  const sortField = spec.sort === 'priority' ? 'priorityRank' : spec.sort;
  const sort = { [sortField]: direction, _id: direction } as Record<string, 1 | -1>;

  const findOptions = withArchive ? { withArchive: true } : {};
  const [items, total] = await Promise.all([
    TicketModel.find(filter)
      .setOptions(findOptions)
      .sort(sort)
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    TicketModel.countDocuments(filter).setOptions(findOptions),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

/** Scoped read used by callers that need the CURRENT live ticket. */
export function liveTicketFilter(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
): FilterQuery<TicketDocument> {
  const filter: FilterQuery<TicketDocument> = {
    ...tenantFilter(workspaceId),
    _id: ticketId,
    deletedAt: null,
  };
  assertTenantScope(filter, 'liveTicketFilter');
  return filter;
}

/** Editable-field updates (subject/description/tags/category/dueAt/customer). */
export async function updateTicketFields(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
  set: Record<string, unknown>,
): Promise<TicketDocument | null> {
  if (Object.keys(set).length === 0) {
    return TicketModel.findOne(liveTicketFilter(workspaceId, ticketId));
  }
  return TicketModel.findOneAndUpdate(liveTicketFilter(workspaceId, ticketId), { $set: set }, {
    new: true,
    runValidators: true,
  });
}

/** Lifecycle stamps accompanying a status transition (may be empty). */
export interface TicketLifecycleStamps {
  readonly status: TicketStatus;
  readonly resolvedAt?: Date | null;
  readonly closedAt?: Date | null;
  readonly resolutionNote?: string;
}

export async function updateTicketStatus(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
  stamps: TicketLifecycleStamps,
): Promise<TicketDocument | null> {
  const set: Record<string, unknown> = { status: stamps.status };
  if (stamps.resolvedAt !== undefined) set['resolvedAt'] = stamps.resolvedAt;
  if (stamps.closedAt !== undefined) set['closedAt'] = stamps.closedAt;
  if (stamps.resolutionNote !== undefined) set['resolutionNote'] = stamps.resolutionNote;

  return TicketModel.findOneAndUpdate(liveTicketFilter(workspaceId, ticketId), { $set: set }, {
    new: true,
    runValidators: true,
  });
}

export async function updateTicketPriority(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
  priority: TicketPriority,
): Promise<TicketDocument | null> {
  return TicketModel.findOneAndUpdate(
    liveTicketFilter(workspaceId, ticketId),
    { $set: { priority } },
    {
      new: true,
      // runValidators makes the model's pre-validate hook refresh
      // priorityRank in exactly the same write.
      runValidators: true,
    },
  );
}

export async function updateTicketAssignment(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
  agentId: Types.ObjectId | null,
): Promise<TicketDocument | null> {
  return TicketModel.findOneAndUpdate(
    liveTicketFilter(workspaceId, ticketId),
    { $set: { agentId } },
    { new: true },
  );
}

/** Soft-delete by the customers convention (a scoped `deletedAt` stamp). */
export async function archiveTicketRecord(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
  archivedAt: Date,
): Promise<TicketDocument | null> {
  return TicketModel.findOneAndUpdate(
    liveTicketFilter(workspaceId, ticketId),
    { $set: { deletedAt: archivedAt } },
    { new: true },
  );
}
