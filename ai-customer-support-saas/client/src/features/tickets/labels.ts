import type { BadgeTone } from '@/components/ui/badge';
import type { TicketPriority, TicketStatus } from './types';

/** Human labels for the actual backend enums — no invented values. */
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_CUSTOMER: 'Waiting for customer',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export const TICKET_STATUS_TONES: Record<TicketStatus, BadgeTone> = {
  OPEN: 'info',
  IN_PROGRESS: 'warning',
  WAITING_FOR_CUSTOMER: 'brand',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const TICKET_PRIORITY_TONES: Record<TicketPriority, BadgeTone> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warning',
  URGENT: 'danger',
};

/**
 * Assignee display.
 *
 * The ticket DTO carries only `agentId`, and this backend release has **no**
 * member-directory endpoint to resolve names (`workspace.members.list` is a
 * reserved permission with no route). The UI therefore shows the trailing id
 * fragment — a real value — instead of inventing a name, and labels the column
 * so the limitation is visible.
 */
export function assigneeLabel(agentId: string | null): string {
  if (agentId === null) return 'Unassigned';
  return `Agent #${agentId.slice(-6)}`;
}
