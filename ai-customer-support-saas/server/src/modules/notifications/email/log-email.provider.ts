import { isProduction } from '../../../config/env.config.js';
import { logger } from '../../../core/logger/logger.js';

import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from './email.types.js';

const OUTBOX_CAPACITY = 50;

/**
 * Development/test email provider ("log").
 *
 * Refuses to run in production (double-guarded: env.config.ts already rejects
 * EMAIL_PROVIDER="log" there). It logs SUBJECT + recipient only — never the
 * body — and keeps a small in-memory outbox so verification drivers can assert
 * template output without a real inbox.
 *
 * The outbox is process memory: nothing here is durable, and `SENT` on a
 * delivery row backed by this provider means "logged, not mailed".
 */
class LogEmailProvider implements EmailProvider {
  public readonly name = 'log';
  private readonly outbox: EmailMessage[] = [];

  public async send(message: EmailMessage): Promise<EmailSendResult> {
    await Promise.resolve();
    if (isProduction) {
      throw new EmailProviderError(
        'EMAIL_PROVIDER_LOG_IN_PRODUCTION',
        'The log email provider is development-only',
        false,
      );
    }

    this.outbox.push(message);
    if (this.outbox.length > OUTBOX_CAPACITY) this.outbox.shift();

    logger.info(
      { to: message.to, subject: message.subject, templateKey: message.templateKey, provider: 'log' },
      `[email:notification] ${message.subject}`,
    );
    return { acceptedAt: new Date(), providerMessageId: null };
  }

  /** Verification hook: messages accepted by this process, oldest first. */
  public sentMessages(): readonly EmailMessage[] {
    return [...this.outbox];
  }

  /** Verification hook: drops the in-memory outbox. */
  public clear(): void {
    this.outbox.length = 0;
  }
}

export const logEmailProvider = new LogEmailProvider();
