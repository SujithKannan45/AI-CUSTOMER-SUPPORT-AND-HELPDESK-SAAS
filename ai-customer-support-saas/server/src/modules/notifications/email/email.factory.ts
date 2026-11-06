import { env } from '../../../config/env.config.js';

import type { EmailProvider } from './email.types.js';
import { logEmailProvider } from './log-email.provider.js';
import { sesSmtpEmailProvider, smtpEmailProvider } from './smtp-email.provider.js';

/**
 * Provider selection — the ONLY place configuration decides which adapter
 * sends mail. Business code (and the delivery service) asks for "the
 * provider"; it never branches on EMAIL_PROVIDER itself.
 *
 * `ses` intentionally maps to the SMTP adapter (SES SMTP endpoint) — see
 * smtp-email.provider.ts. A process-wide override exists for verification
 * drivers and future tests (`setEmailProvider`), never for production routing.
 */
let override: EmailProvider | null = null;

export function resolveEmailProvider(): EmailProvider {
  if (override !== null) return override;
  switch (env.EMAIL_PROVIDER) {
    case 'log':
      return logEmailProvider;
    case 'smtp':
      return smtpEmailProvider;
    case 'ses':
      return sesSmtpEmailProvider;
    default: {
      const exhaustive: never = env.EMAIL_PROVIDER;
      throw new Error(`Unknown EMAIL_PROVIDER: ${String(exhaustive)}`);
    }
  }
}

/** Test/verification seam: registers (or clears) a provider override. */
export function setEmailProvider(provider: EmailProvider | null): void {
  override = provider;
}
