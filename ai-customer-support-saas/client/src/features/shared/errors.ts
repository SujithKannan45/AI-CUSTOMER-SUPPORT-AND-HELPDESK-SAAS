import { HttpApiError } from '@/services/http-client.service';

/**
 * Error copy shared by the record surfaces (customers, tickets).
 *
 * Mapping is status-based only: server response bodies, `code` values, request
 * ids and field names are never rendered. The one deliberate exception is a
 * 422 whose per-field messages the calling form maps explicitly onto its own
 * controls (see `fieldErrorsFrom`).
 */

export type ReadResource =
  | 'customers'
  | 'customer'
  | 'tickets'
  | 'ticket'
  | 'inbox'
  | 'conversation'
  | 'messages';

export interface ReadErrorCopy {
  readonly message: string;
  /** 403 is an authorization outcome — retrying can only fail again. */
  readonly forbidden: boolean;
  readonly notFound: boolean;
}

const FORBIDDEN: Record<ReadResource, string> = {
  customers:
    'Customer records are not available to your role in this workspace. Ask a workspace administrator for access.',
  customer:
    'Customer records are not available to your role in this workspace. Ask a workspace administrator for access.',
  tickets:
    'Support tickets are not available to your role in this workspace. Ask a workspace administrator for access.',
  ticket:
    'Support tickets are not available to your role in this workspace. Ask a workspace administrator for access.',
  inbox:
    'Conversations are not available to your role in this workspace. Ask a workspace administrator for access.',
  conversation:
    'Conversations are not available to your role in this workspace. Ask a workspace administrator for access.',
  messages:
    'Messages are not available to your role in this workspace. Ask a workspace administrator for access.',
};

const NOT_FOUND: Record<ReadResource, string> = {
  customers: 'This workspace could not be found or is no longer available to your account.',
  customer: 'This customer does not exist in the current workspace, or was archived.',
  tickets: 'This workspace could not be found or is no longer available to your account.',
  ticket: 'This ticket does not exist in the current workspace, or was archived.',
  inbox: 'This workspace could not be found or is no longer available to your account.',
  conversation:
    'This conversation does not exist in the current workspace, or its ticket was archived.',
  messages: 'This conversation does not exist in the current workspace, or its ticket was archived.',
};

export function describeReadError(error: unknown, resource: ReadResource): ReadErrorCopy {
  if (!(error instanceof HttpApiError)) {
    return {
      message: 'This data could not be loaded. Please try again.',
      forbidden: false,
      notFound: false,
    };
  }

  if (error.status === 403) {
    return { message: FORBIDDEN[resource], forbidden: true, notFound: false };
  }

  if (error.status === 404) {
    return { message: NOT_FOUND[resource], forbidden: false, notFound: true };
  }

  if (error.status === 429) {
    return {
      message: 'Too many requests. Please wait a moment, then try again.',
      forbidden: false,
      notFound: false,
    };
  }

  if (error.isNetworkError) {
    return { message: error.message, forbidden: false, notFound: false };
  }

  return {
    message: 'The service could not load this data. Please try again.',
    forbidden: false,
    notFound: false,
  };
}

export interface MutationErrorOptions {
  /** Used for unmapped statuses (5xx and anything unexpected). */
  readonly fallback: string;
  /** 409 copy — the resource's current state rejects the change. */
  readonly conflict?: string;
  /** 404 copy — the record disappeared (archived elsewhere) while editing. */
  readonly notFound?: string;
}

/** Safe, status-derived copy for a create/update/archive/transition failure. */
export function describeMutationError(error: unknown, options: MutationErrorOptions): string {
  if (!(error instanceof HttpApiError)) return options.fallback;

  switch (error.status) {
    case 403:
      return 'You do not have permission to perform this action in this workspace.';
    case 404:
      return options.notFound ?? 'This record no longer exists in the current workspace.';
    case 409:
      return options.conflict ?? 'This change conflicts with the record’s current state.';
    case 422:
      return 'Some values were rejected. Check the highlighted fields and try again.';
    case 429:
      return 'Too many requests. Please wait a moment, then try again.';
    case 0:
      return error.message;
    default:
      return options.fallback;
  }
}

/**
 * Extracts validated field messages from a 422 `details` object
 * (`{ field: string[] }`, produced by the server's validation middleware).
 * Unknown keys are ignored, so a server-side addition cannot leak into the UI.
 */
export function fieldErrorsFrom<Field extends string>(
  error: unknown,
  fields: readonly Field[],
): Partial<Record<Field, string>> {
  if (!(error instanceof HttpApiError) || error.status !== 422) return {};

  const details = error.details;
  if (typeof details !== 'object' || details === null) return {};

  const result: Partial<Record<Field, string>> = {};
  for (const field of fields) {
    const value = (details as Record<string, unknown>)[field];
    if (!Array.isArray(value)) continue;
    const first: unknown = value[0];
    if (typeof first === 'string' && first.length > 0) result[field] = first;
  }
  return result;
}
