import type { NotificationType } from '../notification.types.js';

/**
 * Email templates — pure rendering, no I/O, no model access.
 *
 * Design:
 * - ONE branded, responsive layout shared by every notification email; the
 *   per-type registry supplies the subject prefix and the "what happened"
 *   heading. That keeps seven templates consistent without seven copies of
 *   the same table markup, and a new notification type is a compile error
 *   until it has a registry entry (`Record<NotificationType, …>`).
 * - PLAIN TEXT alternative is always produced.
 * - EVERY dynamic value is escaped for HTML (ticket subjects and workspace
 *   names are user-controlled text → the classic HTML-injection vector).
 * - No links are emitted: the client SPA has no ticket/escalation routes yet,
 *   and inventing URLs would produce dead links in real inboxes. When the
 *   frontend prompts add routes, a link builder belongs here.
 * - No internal notes, message bodies, AI prompts, retrieved passages or
 *   storage paths are ever passed in — the dispatcher only supplies the
 *   content-safe title/body it already persisted on the notification.
 */

export interface NotificationEmailInput {
  readonly templateKey: NotificationType;
  readonly workspaceName: string;
  readonly recipientName: string;
  /** Content-safe headline, identical to the in-app notification title. */
  readonly title: string;
  /** Content-safe one-liner, identical to the in-app notification body. */
  readonly body: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface TemplateChrome {
  /** Shown as the email's category line above the heading. */
  readonly label: string;
  /** Prefix that makes the inbox subject scannable. */
  readonly subjectPrefix: string;
}

const TEMPLATE_CHROME: Readonly<Record<NotificationType, TemplateChrome>> = {
  'ticket.created': { label: 'New ticket', subjectPrefix: 'New ticket' },
  'ticket.assigned': { label: 'Ticket assigned', subjectPrefix: 'Assigned' },
  'ticket.reassigned': { label: 'Ticket reassigned', subjectPrefix: 'Reassigned' },
  'ticket.status_changed': { label: 'Ticket status update', subjectPrefix: 'Status update' },
  'ticket.priority_changed': { label: 'Ticket priority update', subjectPrefix: 'Priority update' },
  'conversation.public_message': { label: 'New public reply', subjectPrefix: 'New reply' },
  'escalation.created': { label: 'Escalation', subjectPrefix: 'Escalation' },
  'escalation.assigned': { label: 'Escalation assigned', subjectPrefix: 'Escalation assigned' },
  'escalation.reassigned': { label: 'Escalation reassigned', subjectPrefix: 'Escalation reassigned' },
  'escalation.accepted': { label: 'Escalation accepted', subjectPrefix: 'Escalation accepted' },
  'escalation.resolved': { label: 'Escalation resolved', subjectPrefix: 'Escalation resolved' },
  'escalation.cancelled': { label: 'Escalation cancelled', subjectPrefix: 'Escalation cancelled' },
  'ai.handoff': { label: 'AI handoff', subjectPrefix: 'AI handoff' },
  'ai.failure': { label: 'AI needs attention', subjectPrefix: 'AI needs attention' },
};

/** Escapes text for HTML element content AND attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain-text → minimal safe HTML (used by the AUTH emails, whose bodies are
 * already plain text with URLs). Everything is escaped, and line breaks are
 * preserved inside a styled `<pre>` — no markup from the text can ever reach
 * the document as HTML.
 */
export function renderPlainTextEmail(text: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:24px;background:#f5f6f8;">',
    '<pre style="max-width:560px;margin:0 auto;padding:20px 24px;background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#344054;">',
    escapeHtml(text),
    '</pre></body></html>',
  ].join('');
}

/** Subjects must never contain CR/LF (header injection); collapse whitespace. */
function sanitizeSubjectLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

/**
 * Renders one notification email. Deterministic and side-effect free, so the
 * verification driver can assert escaping and both alternatives directly.
 */
export function renderNotificationEmail(input: NotificationEmailInput): RenderedEmail {
  const chrome = TEMPLATE_CHROME[input.templateKey];
  const workspaceName = input.workspaceName.slice(0, 120);
  const recipientName = input.recipientName.slice(0, 120);
  const title = input.title.slice(0, 200);
  const body = input.body.slice(0, 500);

  const subject = sanitizeSubjectLine(`${chrome.subjectPrefix} · ${title}`);

  const text = [
    `${title}`,
    '',
    body,
    '',
    `Workspace: ${workspaceName}`,
    `Hello ${recipientName},`,
    '',
    'You are receiving this because notification emails are enabled for your',
    'membership in this workspace. You can change this in your notification',
    'preferences.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f5f6f8;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:24px 12px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #e4e7ec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">',
    `<tr><td style="padding:20px 24px 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085;">${escapeHtml(chrome.label)}</td></tr>`,
    `<tr><td style="padding:0 24px;font-size:18px;font-weight:600;color:#101828;line-height:1.35;">${escapeHtml(title)}</td></tr>`,
    `<tr><td style="padding:12px 24px 0;font-size:14px;color:#344054;line-height:1.5;">${escapeHtml(body)}</td></tr>`,
    `<tr><td style="padding:20px 24px 0;font-size:13px;color:#475467;line-height:1.5;">Hello ${escapeHtml(recipientName)},</td></tr>`,
    `<tr><td style="padding:12px 24px 24px;font-size:12px;color:#667085;line-height:1.5;border-top:1px solid #eaecf0;">Workspace: ${escapeHtml(workspaceName)}<br>`,
    'You are receiving this because notification emails are enabled for your membership in this workspace. You can change this in your notification preferences.</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');

  return { subject, text, html };
}
