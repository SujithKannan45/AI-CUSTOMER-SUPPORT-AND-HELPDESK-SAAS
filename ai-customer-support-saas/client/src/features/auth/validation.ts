/**
 * Authentication form validation.
 *
 * These are the *client* mirrors of the server's Zod rules
 * (`server/src/modules/auth/auth.validation.ts` and the shared
 * `EMAIL_PATTERN`). They exist to fail fast and focus the right field; the
 * server remains the authority on every rule.
 */

/** Mirrors `EMAIL_PATTERN` in `server/src/database/schema-validators.ts`. */
export const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MAX_LENGTH = 128;

export interface SignInInput {
  email: string;
  password: string;
}

export interface SignInFieldErrors {
  email?: string;
  password?: string;
}

export interface ResetPasswordInput {
  password: string;
  confirmPassword: string;
}

export interface ResetPasswordFieldErrors {
  password?: string;
  confirmPassword?: string;
}

/** Email is trimmed for transport exactly like the server schema does. */
export function validateEmail(value: string): string | undefined {
  const email = value.trim();
  if (email.length === 0) return 'Enter your email address.';
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    return 'Enter a valid email address.';
  }
  return undefined;
}

export function validateSignIn(input: SignInInput): SignInFieldErrors {
  const errors: SignInFieldErrors = {};
  const emailError = validateEmail(input.email);
  if (emailError !== undefined) errors.email = emailError;

  // Passwords are never trimmed or otherwise rewritten.
  if (input.password.length === 0) {
    errors.password = 'Enter your password.';
  } else if (input.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Passwords are at most ${PASSWORD_MAX_LENGTH} characters.`;
  }

  return errors;
}

/**
 * Password policy mirrored from `passwordSchema` on the server: 8–128 chars,
 * at least one letter and one digit.
 */
export function validateNewPassword(value: string): string | undefined {
  if (value.length === 0) return 'Enter a new password.';
  if (value.length < 8) return 'Use at least 8 characters.';
  if (value.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (!/[a-zA-Z]/.test(value)) return 'Include at least one letter.';
  if (!/[0-9]/.test(value)) return 'Include at least one digit.';
  return undefined;
}

export function validateResetPassword(input: ResetPasswordInput): ResetPasswordFieldErrors {
  const errors: ResetPasswordFieldErrors = {};
  const passwordError = validateNewPassword(input.password);
  if (passwordError !== undefined) errors.password = passwordError;

  if (input.confirmPassword.length === 0) {
    errors.confirmPassword = 'Confirm your new password.';
  } else if (input.confirmPassword !== input.password) {
    errors.confirmPassword = 'Passwords do not match.';
  }

  return errors;
}

export function hasFieldErrors(errors: object): boolean {
  return Object.values(errors).some((value) => typeof value === 'string' && value.length > 0);
}
