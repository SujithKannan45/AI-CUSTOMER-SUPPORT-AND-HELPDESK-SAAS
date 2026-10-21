import type { Types } from 'mongoose';

import type { CustomerDocument, CustomerStatus } from './customer.types.js';
import type { ArchiveState, CustomerSortField } from './customer.validation.js';

/**
 * Customer module — public DTOs, service payloads and query objects.
 *
 * The safe representation that crosses the HTTP boundary lives here — never
 * the raw Mongoose document. Customer PII is limited to what the workspace
 * itself registered (name/email/phone/avatar); nothing is added, packed or
 * widened by the mapper.
 */
export interface CustomerDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly avatarUrl: string | null;
  readonly status: CustomerStatus;
  readonly tags: readonly string[];
  /** Plain object inspectable by clients; values are simple primitives. */
  readonly metadata: Record<string, string | number | boolean | null>;
  readonly lastInteractionAt: string | null;
  /** Soft-delete stamp (null = live customer). */
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** GET …/customers/:customerId — 200 payload. */
export interface CustomerDetailPayload {
  readonly customer: CustomerDto;
}

/** POST …/customers — 201 payload. */
export type CustomerCreatedPayload = CustomerDetailPayload;

/** GET …/customers — 200 payload (pagination contract matches workspaces). */
export interface CustomerListPayload {
  readonly items: readonly CustomerDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * GET …/customers/:customerId/summary — the future-facing interaction seam.
 *
 * `available: false` is FIXED until tickets/conversations exist: no invented
 * counts, no fake engagement numbers. The only field served is
 * `lastInteractionAt`, which the model already carries. Ticket/conversation/
 * CSAT summary sources will be added by the modules that own that data.
 */
export interface CustomerInteractionSummary {
  readonly available: boolean;
  readonly lastInteractionAt: string | null;
}

// ── Mapper (the single place a document becomes a DTO) ───────────────────────

function toMetadataObject(map: Map<string, unknown>): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of map) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    } else if (value === null) {
      result[key] = null;
    }
    // Non-primitive values are unreachable through validated writes; skipping
    // them keeps the DTO contract honest without throwing on legacy rows.
  }
  return result;
}

export function toCustomerDto(doc: CustomerDocument): CustomerDto {
  const email = doc.email?.length ? doc.email : null;
  const phone = doc.phone?.length ? doc.phone : null;
  const avatarUrl = doc.avatarUrl?.length ? doc.avatarUrl : null;
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    name: doc.name,
    email,
    phone,
    avatarUrl,
    status: doc.status,
    tags: [...doc.tags],
    metadata: toMetadataObject(doc.metadata),
    lastInteractionAt: doc.lastInteractionAt?.toISOString() ?? null,
    archivedAt: doc.deletedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Query object handed from the service to the repository (already validated). */
export interface CustomerListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  readonly search?: string;
  readonly status?: CustomerStatus;
  readonly tags?: string[];
  readonly sort: CustomerSortField;
  readonly order: 'asc' | 'desc';
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
  readonly archiveState: ArchiveState;
}
