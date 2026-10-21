import { type Types, type FilterQuery } from 'mongoose';

import { AppError } from '../../core/errors/index.js';
import {
  assertTenantScope,
  tenantFilter,
} from '../../database/tenant.js';

import type { CustomerListSpec } from './customer.dto.js';
import { CustomerModel } from './customer.model.js';
import type { CustomerDocument, CustomerStatus } from './customer.types.js';
import type { UpdateCustomerInput } from './customer.validation.js';

/**
 * Persistence layer — the ONLY module that touches the `customers`
 * collection, mirroring the workspace repository conventions:
 *
 * - EVERY query is built through `tenantFilter()` and asserted with
 *   `assertTenantScope()` — a customer query without a workspace scope is a
 *   programming error that surfaces as an opaque 500, never as another
 *   tenant's rows. The `_id` filter is ALWAYS composed inside this module so
 *   callers cannot fetch "an id" without the workspace discriminator:
 *   `{ …tenantFilter(workspaceId), _id: customerId }` is both the check and
 *   the concealment (foreign ids read as not-found).
 * - Uniqueness conflicts are translated from the duplicate-key error of
 *   `uniq_customer_email_per_workspace` — never a pre-insert existence check
 *   (which races under concurrent creation).
 * - Raw driver errors never escape this module.
 */
const DUPLICATE_KEY_ERROR = 11000;

/** Model default for live customers (model-level enum value, kept in sync). */
const DEFAULT_CUSTOMER_STATUS = 'active' as const;

export interface CustomerCreateRecord {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly avatarUrl?: string;
  readonly status?: CustomerStatus;
  readonly tags?: string[];
  readonly metadata?: Record<string, string | number | boolean | null>;
}

/**
 * True when the error is the duplicate-key violation of the per-workspace
 * customer email index specifically (not other uniqueness).
 */
export function isDuplicateCustomerEmailError(error: unknown): boolean {
  const candidate = error as { code?: unknown; keyValue?: Record<string, unknown> } | null;
  if (candidate === null || typeof candidate !== 'object') return false;
  if (candidate['code'] !== DUPLICATE_KEY_ERROR) return false;
  return candidate['keyValue']?.['email'] !== undefined;
}

export function duplicateCustomerEmailError(): AppError {
  // 409 with no DB detail: the message names the workspace-level rule only.
  return AppError.conflict(
    'A customer with this email already exists in this workspace',
  );
}

export async function createCustomer(
  workspaceId: Types.ObjectId,
  record: CustomerCreateRecord,
): Promise<CustomerDocument> {
  try {
    return await CustomerModel.create({
      ...tenantFilter(workspaceId),
      name: record.name,
      ...(record.email !== undefined ? { email: record.email } : {}),
      ...(record.phone !== undefined ? { phone: record.phone } : {}),
      ...(record.avatarUrl !== undefined ? { avatarUrl: record.avatarUrl } : {}),
      status: record.status ?? DEFAULT_CUSTOMER_STATUS,
      ...(record.tags !== undefined ? { tags: record.tags } : {}),
      ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
    });
  } catch (error) {
    if (isDuplicateCustomerEmailError(error)) {
      throw duplicateCustomerEmailError();
    }
    throw error;
  }
}

/**
 * Reads ONE customer by id, scoped to its workspace. `null` for unknown ids,
 * foreign ids, or (by default) archived customers — a single lookup answers
 * "does this customer exist and may I see it" without leaking which.
 */
export async function findCustomerInWorkspace(
  workspaceId: Types.ObjectId,
  customerId: Types.ObjectId,
  options: { readonly includeArchived?: boolean } = {},
): Promise<CustomerDocument | null> {
  const filter: FilterQuery<CustomerDocument> = {
    ...tenantFilter(workspaceId),
    _id: customerId,
  };
  assertTenantScope(filter, 'findCustomerInWorkspace');
  // includeArchived=false relies on the model's live-only hook (+deletedAt:
  // null); includeArchived=true opts OUT of that hook via the model's
  // additive query option (never an explicit deletedAt clause, which would
  // turn "include archived" into "archived only").
  const query = CustomerModel.findOne(filter);
  return options.includeArchived === true
    ? query.setOptions({ withDeleted: true })
    : query;
}

/**
 * Listing filtered/sorted/paginated IN THE DATABASE (no in-memory splicing),
 * with a workspace-tenant scope and a deterministic `_id` tiebreak so
 * concurrent writes cannot duplicate or skip rows across pages.
 *
 * Archive slices:
 * - `live` — model default (the schema's pre-hook adds `deletedAt: null`).
 * - `archived` — the filter must mention `deletedAt` itself to pass the hook.
 * - `all` — the query opts out of the hook with the model's WITH_DELETED
 *   option (see customer.model.ts).
 */
export interface CustomerListResult {
  readonly items: readonly CustomerDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

export async function listCustomers(spec: CustomerListSpec): Promise<CustomerListResult> {
  const filter: Record<string, unknown> = { ...tenantFilter(spec.workspaceId) };

  if (spec.status !== undefined) filter['status'] = spec.status;
  if (spec.tags !== undefined && spec.tags.length > 0) filter['tags'] = { $all: spec.tags };

  if (spec.search !== undefined) {
    // Case-insensitive substring over name OR email. Escaped so regex
    // metacharacters in the search term match literally. Block-level
    // tradeoff (documented in the model): this scans the tenant's slice of
    // the collection — bounded by the tenant size and pageSize — and is
    // replaced by Atlas Search when the directory scale demands it.
    const escaped = spec.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter['$or'] = [
      { name: { $regex: escaped, $options: 'i' } },
      { email: { $regex: escaped, $options: 'i' } },
    ];
  }

  if (spec.createdFrom !== undefined || spec.createdTo !== undefined) {
    filter['createdAt'] = {
      ...(spec.createdFrom !== undefined ? { $gte: spec.createdFrom } : {}),
      ...(spec.createdTo !== undefined ? { $lte: spec.createdTo } : {}),
    };
  }

  const withDeleted = spec.archiveState === 'all';
  if (withDeleted) {
    // No deletedAt filter at all WITH the opt-out option (hook then skips).
    filter['deletedAt'] = undefined;
    delete filter['deletedAt'];
  } else if (spec.archiveState === 'archived') {
    filter['deletedAt'] = { $ne: null };
  }
  assertTenantScope(filter, 'listCustomers');

  const direction = spec.order === 'asc' ? 1 : -1;
  const sort = { [spec.sort]: direction, _id: direction } as const;

  const findOptions = withDeleted ? { withDeleted: true } : {}; // model-hook opt-out, see customer.model.ts
  const [items, total] = await Promise.all([
    CustomerModel.find(filter)
      .setOptions(findOptions)
      .sort(sort)
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    CustomerModel.countDocuments(filter).setOptions(findOptions),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

/**
 * Builds the update document from VALIDATED input only — key-by-key, so
 * `_id`, `workspaceId`, timestamps and `deletedAt` are unreachable from
 * payloads even in principle. `null` clears an optional field (`$unset`).
 */
interface UpdateDocumentOps {
  readonly set: Record<string, unknown>;
  readonly unset: Record<string, 1>;
}

function buildUpdateOps(updates: UpdateCustomerInput): UpdateDocumentOps {
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  for (const [field, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null) {
      unset[field] = 1;
      continue;
    }
    set[field] = value;
  }
  return { set, unset };
}

/**
 * Applies an update scoped to BOTH workspace and id, requiring a live
 * (non-archived) customer. Run validators keep the schema's rules honest for
 * re-registered emails/phones. `null` for "not found in this workspace"
 * (unknown id, foreign id, or archived — callers may consult
 * `findCustomerInWorkspace(..., { includeArchived: true })` for callers
 * should map that distinction to 404 identically.
 */
export async function updateCustomer(
  workspaceId: Types.ObjectId,
  customerId: Types.ObjectId,
  updates: UpdateCustomerInput,
): Promise<CustomerDocument | null> {
  const { set, unset } = buildUpdateOps(updates);
  if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
    return findCustomerInWorkspace(workspaceId, customerId);
  }

  const filter: FilterQuery<CustomerDocument> = {
    ...tenantFilter(workspaceId),
    _id: customerId,
    deletedAt: null,
  };
  assertTenantScope(filter, 'updateCustomer');

  const query = CustomerModel.findOneAndUpdate(filter, { $set: set, $unset: unset }, {
    new: true,
    runValidators: true,
  });
  try {
    return await query;
  } catch (error) {
    if (isDuplicateCustomerEmailError(error)) {
      throw duplicateCustomerEmailError();
    }
    throw error;
  }
}

/**
 * Soft-delete by the model's convention — a scoped `$set: { deletedAt }`
 * (never a hard delete: the codebase has no customer-h delete path and the
 * prompt forbids introducing one). `null` when no LIVE customer matches.
 */
export async function archiveCustomer(
  workspaceId: Types.ObjectId,
  customerId: Types.ObjectId,
  archivedAt: Date,
): Promise<CustomerDocument | null> {
  const filter: FilterQuery<CustomerDocument> = {
    ...tenantFilter(workspaceId),
    _id: customerId,
    deletedAt: null,
  };
  assertTenantScope(filter, 'archiveCustomer');
  return CustomerModel.findOneAndUpdate(
    filter,
    { $set: { deletedAt: archivedAt } },
    { new: true },
  );
}

/**
 * Restores a soft-deleted customer; `null` when there is no archived match.
 *
 * The unique email index re-arms the moment `deletedAt` becomes null: a live
 * customer may have registered the same address in the meantime. That races
 * with the restore write itself, so the conflict is translated HERE to the
 * same 409 the create/update paths produce — predictable, never a raw E11000.
 */
export async function restoreCustomer(
  workspaceId: Types.ObjectId,
  customerId: Types.ObjectId,
): Promise<CustomerDocument | null> {
  const filter: FilterQuery<CustomerDocument> = {
    ...tenantFilter(workspaceId),
    _id: customerId,
    deletedAt: { $ne: null },
  };
  assertTenantScope(filter, 'restoreCustomer');
  try {
    return await CustomerModel.findOneAndUpdate(
      filter,
      { $set: { deletedAt: null } },
      { new: true },
    );
  } catch (error) {
    if (isDuplicateCustomerEmailError(error)) {
      throw duplicateCustomerEmailError();
    }
    throw error;
  }
}
