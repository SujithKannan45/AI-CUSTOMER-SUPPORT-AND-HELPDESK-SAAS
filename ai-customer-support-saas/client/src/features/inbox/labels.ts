import type { MessageSenderType, MessageVisibility } from './types';

/**
 * Display helpers for the conversation surface.
 *
 * Sender identity is shown as a real value or a documented placeholder: the
 * message DTO carries `senderId` only and this backend release has NO member
 * directory endpoint (`workspace.members.list` is a reserved permission with no
 * route), so an agent is labelled from the trailing id fragment — never an
 * invented name.
 */

export const VISIBILITY_LABELS: Record<MessageVisibility, string> = {
  PUBLIC: 'Customer-visible reply',
  INTERNAL: 'Internal note',
};

export const SENDER_TYPE_LABELS: Record<MessageSenderType, string> = {
  AGENT: 'Agent',
  CUSTOMER: 'Customer',
};

/** `Agent #28a37d`, `Customer`, or `You` for the signed-in agent. */
export function senderLabel(
  message: { readonly senderId: string; readonly senderType: MessageSenderType },
  currentUserId: string | null,
): string {
  if (currentUserId !== null && message.senderId === currentUserId) return 'You';
  if (message.senderType === 'CUSTOMER') return SENDER_TYPE_LABELS.CUSTOMER;
  return `Agent #${message.senderId.slice(-6)}`;
}

/** Thread title: the conversation subject, else the ticket subject. */
export function conversationTitle(
  subject: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (subject !== null && subject !== undefined && subject.length > 0) return subject;
  if (fallback !== null && fallback !== undefined && fallback.length > 0) return fallback;
  return 'Untitled conversation';
}
