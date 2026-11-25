import { HttpApiError } from '@/services/http-client.service';

export interface AnalyticsErrorCopy {
  readonly message: string;
  /** 403 is an authorization outcome, not a transient failure. */
  readonly forbidden: boolean;
}

/**
 * Safe UI copy for analytics failures. Server response bodies, request ids and
 * internal error details are never surfaced; only status-derived copy is used.
 */
export function describeAnalyticsError(error: unknown): AnalyticsErrorCopy {
  if (!(error instanceof HttpApiError)) {
    return { message: 'Analytics could not be loaded. Please try again.', forbidden: false };
  }

  if (error.status === 403) {
    return {
      message:
        'Analytics is limited to workspace owners and admins. Ask an administrator for access to workspace analytics.',
      forbidden: true,
    };
  }

  if (error.status === 404) {
    return {
      message: 'This workspace could not be found or is no longer available to your account.',
      forbidden: false,
    };
  }

  if (error.status === 429) {
    return {
      message: 'Too many analytics requests. Please wait a moment, then try again.',
      forbidden: false,
    };
  }

  if (error.isNetworkError) {
    return { message: error.message, forbidden: false };
  }

  return {
    message: 'The analytics service could not load this data. Please try again.',
    forbidden: false,
  };
}
