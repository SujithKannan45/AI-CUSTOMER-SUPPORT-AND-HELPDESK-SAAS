/**
 * Email provider seam (Prompt 16).
 *
 * Business modules never touch a provider: they produce notification intents,
 * the dispatcher composes an email input, and the delivery service hands a
 * rendered message to whichever provider the configuration selected. Adding a
 * provider (SES API, Postmark, …) means adding an adapter here — no service
 * change.
 *
 * Honesty law: `send()` resolves when the PROVIDER ACCEPTED the message. There
 * is no delivery webhook or bounce processing in this deployment, so
 * acceptance is never described as "delivered".
 */

/** A fully rendered transactional message. Never logged as a body. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Content tag for logging/ledger correlation. Notification emails pass their
   * `NotificationType`; auth emails pass `'auth'` — the provider only records
   * it, so it stays a plain string rather than a second enum to keep in sync.
   */
  readonly templateKey: string;
}

/** Provider acceptance receipt — NOT proof of inbox delivery. */
export interface EmailSendResult {
  readonly acceptedAt: Date;
  /** Provider-side message id when the provider supplies one. */
  readonly providerMessageId: string | null;
}

export interface EmailProvider {
  /** Stable provider name recorded in the delivery ledger (`log`/`smtp`/`ses`). */
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Normalized provider failure. `code` is a STABLE machine identifier (never a
 * provider stack trace) stored on the delivery row; `transient` decides
 * whether a retry is meaningful (network/5xx/rate limit) or pointless
 * (auth failure, rejected envelope, missing configuration).
 */
export class EmailProviderError extends Error {
  public readonly code: string;
  public readonly transient: boolean;

  public constructor(code: string, message: string, transient: boolean) {
    super(message);
    this.name = 'EmailProviderError';
    this.code = code;
    this.transient = transient;
  }
}
