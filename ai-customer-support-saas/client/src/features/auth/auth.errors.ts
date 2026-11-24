import { HttpApiError } from '@/services/http-client.service';

/**
 * Maps API failures onto short, safe copy.
 *
 * Only the server's sanitized error envelope message is ever shown — never a
 * response body, stack trace, URL, token or request id. Credential failures
 * stay deliberately uniform (the server does the same to prevent enumeration).
 */

const FALLBACK = 'Something went wrong. Please try again.';

function serverMessage(error: HttpApiError): string {
  const message = error.message.trim();
  return message.length > 0 ? message : FALLBACK;
}

export function describeSignInError(error: unknown): string {
  if (!(error instanceof HttpApiError)) return FALLBACK;

  if (error.isNetworkError) return serverMessage(error);
  if (error.status === 401) return 'Email or password is incorrect.';
  if (error.status === 403) {
    if (/suspend/i.test(error.message)) return 'This account is suspended. Contact your workspace owner.';
    if (/invit/i.test(error.message)) return 'This invitation has not been accepted yet.';
    return 'You do not have access to sign in.';
  }
  if (error.status === 422) return 'Check your email and password, then try again.';
  if (error.status === 429) return 'Too many sign-in attempts. Wait a few minutes, then try again.';
  if (error.status >= 500) return 'The service is temporarily unavailable. Please try again.';
  return serverMessage(error);
}

export function describePasswordResetRequestError(error: unknown): string {
  if (!(error instanceof HttpApiError)) return FALLBACK;
  if (error.isNetworkError) return serverMessage(error);
  if (error.status === 429) return 'Too many requests. Wait a few minutes, then try again.';
  if (error.status >= 500) return 'The service is temporarily unavailable. Please try again.';
  return serverMessage(error);
}

export function describePasswordResetError(error: unknown): string {
  if (!(error instanceof HttpApiError)) return FALLBACK;
  if (error.isNetworkError) return serverMessage(error);
  if (error.status === 400 || error.status === 422) {
    return 'This reset link is invalid or has expired. Request a new one from the sign-in page.';
  }
  if (error.status === 429) return 'Too many requests. Wait a few minutes, then try again.';
  if (error.status >= 500) return 'The service is temporarily unavailable. Please try again.';
  return serverMessage(error);
}
