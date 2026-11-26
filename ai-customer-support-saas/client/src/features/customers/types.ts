/**
 * Client mirrors of the Prompt 7 customer contracts
 * (`server/src/modules/customers/customer.dto.ts` and `customer.validation.ts`).
 *
 * Every field below exists in the API response; nothing is derived or invented.
 */
export const CUSTOMER_STATUSES = ['active', 'blocked'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export type CustomerMetadataValue = string | number | boolean | null;

export interface CustomerDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly avatarUrl: string | null;
  readonly status: CustomerStatus;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, CustomerMetadataValue>>;
  readonly lastInteractionAt: string | null;
  /** Soft-delete stamp; null = live customer. */
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerDetailPayload {
  readonly customer: CustomerDto;
}

export interface CustomerListPayload {
  readonly items: readonly CustomerDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/** Server sort allowlist — no other key is accepted by the API. */
export const CUSTOMER_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'email',
  'lastInteractionAt',
] as const;
export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

/** Which soft-deleted slice a listing reads (server default: live). */
export const CUSTOMER_ARCHIVE_STATES = ['live', 'archived', 'all'] as const;
export type CustomerArchiveState = (typeof CUSTOMER_ARCHIVE_STATES)[number];

export const CUSTOMER_PAGE_SIZE = 20;
export const CUSTOMER_MAX_PAGE_SIZE = 50;

export interface CustomerListQuery {
  readonly page?: number;
  readonly limit?: number;
  /** Case-insensitive substring over name OR email (server-side). */
  readonly search?: string;
  readonly status?: CustomerStatus;
  /** A customer must carry ALL given tags. */
  readonly tags?: readonly string[];
  readonly sort?: CustomerSortField;
  readonly order?: 'asc' | 'desc';
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly archiveState?: CustomerArchiveState;
}

/** POST body — the strict server schema accepts these keys only. */
export interface CreateCustomerInput {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly avatarUrl?: string;
  readonly status?: CustomerStatus;
  readonly tags?: readonly string[];
}

/** PATCH body — `null` explicitly clears an optional field. */
export interface UpdateCustomerInput {
  readonly name?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly avatarUrl?: string | null;
  readonly status?: CustomerStatus;
  readonly tags?: readonly string[];
}
