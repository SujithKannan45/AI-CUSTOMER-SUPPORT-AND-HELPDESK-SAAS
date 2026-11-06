import nodemailer, { type Transporter } from 'nodemailer';

import { env } from '../../../config/env.config.js';
import { EMAIL_PATTERN } from '../../../database/schema-validators.js';

import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from './email.types.js';

/**
 * SMTP email provider — the production-capable adapter (`EMAIL_PROVIDER=smtp`).
 *
 * `EMAIL_PROVIDER=ses` also uses THIS transport: Amazon SES exposes an SMTP
 * endpoint, so SES deployments supply the SES SMTP host/port/credentials in
 * the existing SMTP_* variables. There is no SES API adapter (and therefore no
 * claim that SES-specific features such as configuration sets exist).
 *
 * Failure classification is deliberately conservative:
 * - configuration/auth/envelope problems are PERMANENT (retrying is pointless
 *   and would hammer the provider),
 * - connection/timeout/4xx/rate-limit problems are TRANSIENT (bounded retries),
 * - unknown errors are transient, but attempts are capped, so a bug cannot
 *   turn into an infinite loop.
 *
 * Address validation happens BEFORE the provider is contacted: an invalid
 * recipient is recorded as a permanent failure, never sent.
 */

interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly from: string;
  readonly user: string | undefined;
  readonly password: string | undefined;
}

/** Permanent nodemailer error codes — retrying cannot fix them. */
const PERMANENT_ERROR_CODES = new Set([
  'EAUTH',
  'EENVELOPE',
  'EMESSAGE',
  'EMISSINGFROM',
  'ETLS',
  'ECONFIGURATION',
]);

function isPermanentNodemailerError(code: string | undefined, responseCode: number | undefined): boolean {
  if (code !== undefined && PERMANENT_ERROR_CODES.has(code)) return true;
  if (responseCode !== undefined) {
    // SMTP 5xx = permanent protocol rejection; 4xx = try again later.
    return responseCode >= 500;
  }
  return false;
}

class SmtpEmailProvider implements EmailProvider {
  public readonly name: 'smtp' | 'ses';
  private transporter: Transporter | null = null;

  public constructor(name: 'smtp' | 'ses') {
    this.name = name;
  }

  public async send(message: EmailMessage): Promise<EmailSendResult> {
    await Promise.resolve();

    if (!EMAIL_PATTERN.test(message.to)) {
      throw new EmailProviderError(
        'INVALID_RECIPIENT',
        'Recipient address is not a valid email address',
        false,
      );
    }

    const config = this.resolveConfig();
    const transporter = this.getTransporter(config);

    try {
      // nodemailer types the send result as `any`; it is narrowed to unknown
      // immediately so nothing downstream trusts provider-shaped data.
      const info: unknown = await transporter.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      const messageIdCandidate =
        typeof info === 'object' && info !== null
          ? (info as { messageId?: unknown }).messageId
          : undefined;
      return {
        acceptedAt: new Date(),
        providerMessageId: typeof messageIdCandidate === 'string' ? messageIdCandidate : null,
      };
    } catch (error: unknown) {
      throw normalizeNodemailerError(error);
    }
  }

  /** Configuration is validated on EVERY send so a bad env fails honestly. */
  private resolveConfig(): SmtpConfig {
    const host = env.SMTP_HOST;
    const port = env.SMTP_PORT;
    const fromAddress = env.EMAIL_FROM_ADDRESS;

    if (host === undefined || port === undefined || fromAddress === undefined) {
      throw new EmailProviderError(
        'EMAIL_NOT_CONFIGURED',
        'SMTP_HOST, SMTP_PORT and EMAIL_FROM_ADDRESS are required for SMTP delivery',
        false,
      );
    }
    if (!EMAIL_PATTERN.test(fromAddress)) {
      throw new EmailProviderError(
        'EMAIL_SENDER_INVALID',
        'EMAIL_FROM_ADDRESS is not a valid email address',
        false,
      );
    }
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      throw new EmailProviderError(
        'EMAIL_NOT_CONFIGURED',
        'SMTP_USER and SMTP_PASSWORD must be provided together',
        false,
      );
    }

    const from =
      env.EMAIL_FROM_NAME === undefined
        ? fromAddress
        : `"${env.EMAIL_FROM_NAME.replace(/"/g, '')}" <${fromAddress}>`;

    return {
      host,
      port,
      // Implicit TLS on 465; STARTTLS is negotiated automatically otherwise.
      secure: port === 465,
      from,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
    };
  }

  private getTransporter(config: SmtpConfig): Transporter {
    // Between retries the transport is reused: nodemailer pools connections
    // internally only when `pool` is enabled, so a plain transporter is cheap.
    if (this.transporter !== null) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user !== undefined && config.password !== undefined
        ? { auth: { user: config.user, pass: config.password } }
        : {}),
      connectionTimeout: env.EMAIL_TIMEOUT_MS,
      greetingTimeout: env.EMAIL_TIMEOUT_MS,
      socketTimeout: env.EMAIL_TIMEOUT_MS,
    });
    return this.transporter;
  }
}

function normalizeNodemailerError(error: unknown): EmailProviderError {
  if (error instanceof EmailProviderError) return error;
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? ((error as { code: string }).code)
      : undefined;
  const responseCode =
    typeof error === 'object' && error !== null && typeof (error as { responseCode?: unknown }).responseCode === 'number'
      ? ((error as { responseCode: number }).responseCode)
      : undefined;

  const permanent = isPermanentNodemailerError(code, responseCode);
  return new EmailProviderError(
    code !== undefined ? `SMTP_${code}` : 'SMTP_UNKNOWN',
    // Provider messages can embed addresses/commands; only the code is stored.
    permanent ? 'SMTP provider rejected the message permanently' : 'SMTP delivery attempt failed',
    !permanent,
  );
}

export const smtpEmailProvider = new SmtpEmailProvider('smtp');
export const sesSmtpEmailProvider = new SmtpEmailProvider('ses');
