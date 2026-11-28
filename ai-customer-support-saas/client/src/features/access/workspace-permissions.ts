import type { WorkspaceRole } from '@/features/workspace/types';

/**
 * UI affordance mirror of the server's RBAC registry
 * (`server/src/modules/rbac/rbac.permissions.ts`).
 *
 * This is NOT authorization. It exists only so the interface does not offer a
 * control that the server would reject: every request is still authorized by
 * `requirePermission` from the DB-derived membership role, and the server can
 * deny any action this table would allow. Keep it in sync when the registry
 * changes; a stale table can only hide a permitted control, never grant one.
 *
 * Read access (`customer.view`, `ticket.view`) is held by all four roles, so
 * there is no read gate here.
 */
export type UiPermission =
  | 'customer.create'
  | 'customer.update'
  | 'ticket.create'
  | 'ticket.update'
  | 'ticket.assign'
  | 'conversation.reply'
  | 'analytics.view';

const ROLE_GRANTS: { readonly [K in WorkspaceRole]: readonly UiPermission[] } = {
  owner: [
    'customer.create',
    'customer.update',
    'ticket.create',
    'ticket.update',
    'ticket.assign',
    'conversation.reply',
    'analytics.view',
  ],
  admin: [
    'customer.create',
    'customer.update',
    'ticket.create',
    'ticket.update',
    'ticket.assign',
    'conversation.reply',
    'analytics.view',
  ],
  agent: ['ticket.create', 'ticket.update', 'conversation.reply'],
  viewer: [],
};

export function roleCan(role: WorkspaceRole | null, permission: UiPermission): boolean {
  if (role === null) return false;
  return ROLE_GRANTS[role].includes(permission);
}

export interface TicketModificationInput {
  readonly agentId: string | null;
  readonly createdById: string;
}

/**
 * Mirrors the ticket service's assignment cap
 * (`evaluateResourceModification(..., { allowCreator: true })`): owners and
 * admins may triage any ticket, agents only tickets assigned to them or opened
 * by them, and roles without `ticket.update` never may.
 *
 * The server re-evaluates this on every mutation; the client copy only decides
 * whether to render the controls.
 */
export function canModifyTicket(
  role: WorkspaceRole | null,
  userId: string | null,
  ticket: TicketModificationInput,
): boolean {
  if (role === null) return false;
  if (role === 'owner' || role === 'admin') return true;
  if (!roleCan(role, 'ticket.update')) return false;
  if (userId === null) return false;
  return ticket.agentId === userId || ticket.createdById === userId;
}

/**
 * Mirrors the conversation service's send rule: `conversation.reply` plus the
 * same assignment cap as tickets (`evaluateResourceModification(...
 * { allowCreator: true })`) evaluated against the CONVERSATION'S ticket, which
 * the server loads and re-checks on every send. Owners/admins may reply on any
 * ticket; agents only on tickets assigned to them or opened by them; viewers
 * hold no reply permission at all.
 */
export function canReplyToConversation(
  role: WorkspaceRole | null,
  userId: string | null,
  ticket: TicketModificationInput,
): boolean {
  if (role === null) return false;
  if (role === 'owner' || role === 'admin') return true;
  if (!roleCan(role, 'conversation.reply')) return false;
  if (userId === null) return false;
  return ticket.agentId === userId || ticket.createdById === userId;
}
