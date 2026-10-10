import { env, isProduction } from '../../../config/env.config.js';
import { logger } from '../../../core/logger/logger.js';

import type { AuthEmail, EmailTransport } from './email.types.js';

/**
 * Development-safe outbox transport.
 *
 * Auth emails are rendered with a full URL (so the flow is manually testable)
 * but the log line EMITS NO TOKEN — only the recipient and a short SHA-256
 * prefix of the token are written. The complete raw token is retrievable in
 * development exclusively through `getLastEmailFor()` (the in-memory outbox)
 * or the rendered URL if a caller chooses to print it itself.
 *
 * Production safety:
 * - `send()` hard-fails when NODE_ENV=production (defense in depth; env
 *   config already refuses to boot with EMAIL_PROVIDER="log" in production).
 * - Email bodies never pass through pino; the outbox ring buffer is
 *   process memory only.
 */
class LogOutboxTransport implements EmailTransport {
  /** Small ring buffer of the most recent emails, for dev verification flows. */
  private readonly outbox: Array<{ readonly to: string; readonly subject: string; readonly text: string; readonly at: Date }> = [];
  private readonly capacity = 20;

  public async send(email: AuthEmail): Promise<void> {
    // Async signature keeps the EmailTransport contract uniform across
    // adapters (SMTP/SES are I/O-bound); awaiting a resolved promise here is
    // the cost of the uniform contract.
    await Promise.resolve();
    if (isProduction) {
      throw new Error('LogOutboxTransport must not run in production (EMAIL_PROVIDER="log" is dev-only)');
    }

    this.outbox.push({ to: email.to, subject: email.subject, text: email.text, at: new Date() });
    if (this.outbox.length > this.capacity) {
      this.outbox.shift();
    }

    // Deliberately log metadata only — never the body, never the raw token.
    logger.info(
      { to: email.to, subject: email.subject, provider: 'log' },
      `[email:outbox] ${email.subject}`,
    );
  }

  /** Dev/test hook: the most recent email sent to an address, if any. */
  public getLastEmailFor(to: string): AuthEmail | null {
    for (let i = this.outbox.length - 1; i >= 0; i -= 1) {
      const entry = this.outbox[i];
      if (entry !== undefined && entry.to === to) {
        return { to: entry.to, subject: entry.subject, text: entry.text };
      }
    }
    return null;
  }

  /** Dev/test hook: extract the one-time token from the last email's URL. */
  public extractTokenFromLastEmail(to: string): string | null {
    const email = this.getLastEmailFor(to);
    if (email === null) return null;
    const match = /token=([0-9a-f]{64})/.exec(email.text);
    return match?.[1] ?? null;
  }
}

export const logOutboxTransport = new LogOutboxTransport();

/** Picks the transport from configuration. Only "log" exists today. */
export function resolveEmailTransport(): EmailTransport {
  switch (env.EMAIL_PROVIDER) {
    case 'log':
      return logOutboxTransport;
    case 'smtp':
    case 'ses':
      // Real adapters arrive with the notifications phase; until then a
      // misconfigured production boot is already blocked by env.config.ts,
      // and here we fail loudly rather than silently dropping mail.
      throw new Error(`EMAIL_PROVIDER="${env.EMAIL_PROVIDER}" has no adapter yet — use "log" in development`);
    default: {
      const exhaustive: never = env.EMAIL_PROVIDER;
      throw new Error(`Unknown EMAIL_PROVIDER: ${String(exhaustive)}`);
    }
  }
}
