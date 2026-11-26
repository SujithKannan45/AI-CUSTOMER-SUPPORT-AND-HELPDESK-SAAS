import { httpClient } from '@/services/http-client.service';
import type {
  CreateCustomerInput,
  CustomerDetailPayload,
  CustomerListPayload,
  CustomerListQuery,
  UpdateCustomerInput,
} from './types';

/**
 * Customer endpoints (backend: `server/src/modules/customers`).
 *
 * The workspace id is a routing input only: `requireWorkspaceContext()` resolves
 * the caller's active membership from the database on every request, so a
 * tampered id reads as 404 and grants nothing. Ids are URL-encoded rather than
 * interpolated raw.
 */
function customerPath(workspaceId: string, suffix = ''): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/customers${suffix}`;
}

function customerIdPath(workspaceId: string, customerId: string, suffix = ''): string {
  return customerPath(workspaceId, `/${encodeURIComponent(customerId)}${suffix}`);
}

/**
 * Query construction limited to the validated server contract. Empty values
 * are omitted (the server trims and defaults), so a cleared filter never sends
 * `search=` and produces a 422.
 */
export function customerListSearch(query: CustomerListQuery): string {
  const params = new URLSearchParams();

  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.search !== undefined && query.search.length > 0) params.set('search', query.search);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.tags !== undefined && query.tags.length > 0) params.set('tags', query.tags.join(','));
  if (query.sort !== undefined) params.set('sort', query.sort);
  if (query.order !== undefined) params.set('order', query.order);
  if (query.createdFrom !== undefined) params.set('createdFrom', query.createdFrom);
  if (query.createdTo !== undefined) params.set('createdTo', query.createdTo);
  if (query.archiveState !== undefined) params.set('archiveState', query.archiveState);

  return params.toString();
}

function signalOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal !== undefined ? { signal } : {};
}

export const customerService = {
  /** GET …/customers — tenant-scoped, filtered, paginated listing. */
  list(
    workspaceId: string,
    query: CustomerListQuery = {},
    signal?: AbortSignal,
  ): Promise<CustomerListPayload> {
    const search = customerListSearch(query);
    return httpClient.get<CustomerListPayload>(
      `${customerPath(workspaceId)}${search.length > 0 ? `?${search}` : ''}`,
      signalOptions(signal),
    );
  },

  /** GET …/customers/:customerId — live customers only (archived read 404). */
  get(
    workspaceId: string,
    customerId: string,
    signal?: AbortSignal,
  ): Promise<CustomerDetailPayload> {
    return httpClient.get<CustomerDetailPayload>(
      customerIdPath(workspaceId, customerId),
      signalOptions(signal),
    );
  },

  /** POST …/customers — requires `customer.create` (owner/admin). */
  create(workspaceId: string, input: CreateCustomerInput): Promise<CustomerDetailPayload> {
    return httpClient.post<CustomerDetailPayload>(customerPath(workspaceId), input);
  },

  /** PATCH …/customers/:customerId — requires `customer.update` (owner/admin). */
  update(
    workspaceId: string,
    customerId: string,
    input: UpdateCustomerInput,
  ): Promise<CustomerDetailPayload> {
    return httpClient.patch<CustomerDetailPayload>(customerIdPath(workspaceId, customerId), input);
  },

  /** PATCH …/customers/:customerId/archive — idempotent soft delete. */
  archive(workspaceId: string, customerId: string): Promise<CustomerDetailPayload> {
    return httpClient.patch<CustomerDetailPayload>(customerIdPath(workspaceId, customerId, '/archive'));
  },

  /** PATCH …/customers/:customerId/restore — idempotent undelete. */
  restore(workspaceId: string, customerId: string): Promise<CustomerDetailPayload> {
    return httpClient.patch<CustomerDetailPayload>(customerIdPath(workspaceId, customerId, '/restore'));
  },
};
