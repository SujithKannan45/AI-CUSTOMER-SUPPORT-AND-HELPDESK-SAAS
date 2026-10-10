import { env } from '../../../config/env.config.js';

import type { AuthEmail } from './email.types.js';
import { logOutboxTransport, resolveEmailTransport } from './log-outbox.transport.js';

/**
 * Auth email service — renders and sends authentication emails through the
 * provider-independent transport seam.
 *
 * The raw one-time token appears ONLY in the rendered email body handed to
 * the transport. It is never logged and never returned from any auth API.
 *
 * Development verification: with EMAIL_PROVIDER=log (the default), the
 * outbox keeps the last emails in process memory; `getTokenForEmail()` lets
 * drivers/tests complete the verify/reset flows without a real inbox.
 */
export function buildVerificationEmail(to: string, rawToken: string): AuthEmail {
  const url = `${env.CLIENT_URL}/verify-email?email=${encodeURIComponent(to)}&token=${rawToken}`;
  return {
    to,
    subject: 'Verify your email address',
    text: [
      'Welcome to AI Customer Support SaaS!',
      '',
      'Confirm your email address to activate your account:',
      url,
      '',
      'This link expires and can be used only once.',
    ].join('\n'),
  };
}

export function buildPasswordResetEmail(to: string, rawToken: string): AuthEmail {
  const url = `${env.CLIENT_URL}/reset-password?email=${encodeURIComponent(to)}&token=${rawToken}`;
  return {
    to,
    subject: 'Reset your password',
    text: [
      'A password reset was requested for your account.',
      '',
      'Reset your password:',
      url,
      '',
      'If you did not request this, you can safely ignore this email.',
      'This link expires and can be used only once.',
    ].join('\n'),
  };
}

export async function sendEmail(email: AuthEmail): Promise<void> {
  await resolveEmailTransport().send(email);
}

/**
 * Dev/test-only helper: with the log outbox active, extracts the one-time
 * token from the last email sent to the address. Returns null when the
 * outbox has no mail for the address (or a real provider is configured).
 */
export function getTokenForEmail(to: string): string | null {
  return logOutboxTransport.extractTokenFromLastEmail(to);
}
