/**
 * Email transport seam — provider-independent contract for auth emails.
 *
 * The auth service depends on this interface only; adapters live beside it.
 * Today there is exactly one adapter: the development-safe "log" outbox.
 * SMTP/SES adapters land in the notifications phase behind this same seam,
 * with no changes to auth code.
 *
 * Production safety: the "log" outbox refuses to send when
 * NODE_ENV=production (double-guarded by the env.config.ts boot guard that
 * rejects EMAIL_PROVIDER="log" in production), so auth emails can never be
 * silently swallowed by a console writer in a real deployment.
 */

/** A fully rendered transactional email. Carries the raw one-time token in `text` — never log the body. */
export interface AuthEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailTransport {
  send(email: AuthEmail): Promise<void>;
}
