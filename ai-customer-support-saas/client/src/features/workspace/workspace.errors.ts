import { HttpApiError } from '@/services/http-client.service';
import { firstFieldError } from '@/utils/api-error.util';

/** Maps workspace API failures to safe, actionable form copy. */
export function describeWorkspaceCreateError(error: unknown): string {
  if (!(error instanceof HttpApiError)) return 'Could not create the workspace. Please try again.';

  if (error.isNetworkError) return error.message;
  if (error.status === 409) {
    return 'A workspace with that name already exists. Try a different name.';
  }
  if (error.status === 422) {
    return (
      firstFieldError(error.details, 'name') ??
      firstFieldError(error.details, 'slug') ??
      'Check the workspace name and try again.'
    );
  }
  if (error.status === 429) return 'Too many requests. Wait a moment, then try again.';
  if (error.status >= 500) return 'The service is temporarily unavailable. Please try again.';
  return error.message;
}
