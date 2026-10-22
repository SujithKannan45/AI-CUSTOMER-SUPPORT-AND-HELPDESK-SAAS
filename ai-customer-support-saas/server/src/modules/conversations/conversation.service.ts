import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import {
  isWorkspacePrivilegedRole,
  roleHasPermission,
  WORKSPACE_PERMISSIONS,
} from '../rbac/rbac.permissions.js';
import { evaluateResourceModification } from '../rbac/resource-access.js';
import { findTicketInWorkspace } from '../tickets/ticket.repository.js';
import type { WorkspaceRole } from '../workspaces/workspace.types.js';

import {
  CONVERSATION_AUDIT_ACTIONS,
  recordConversationAudit,
} from './conversation-audit.js';
import {
  toConversationDto,
  toMessageDto,
  type ConversationDetailPayload,
  type ConversationListPayload,
  type ConversationListSpec,
  type ConversationMutatedPayload,
  type MessageCreatedPayload,
  type MessageDetailPayload,
  type MessageListPayload,
} from './conversation.dto.js';
import {
  createConversationRaceSafe,
  findConversationByTicket,
  findConversationInWorkspace,
  listConversations,
  setConversationMetadata,
  updateConversationLastMessage,
} from './conversation.repository.js';
import type {
  ConversationDocument,
  MessageVisibility,
} from './conversation.types.js';
import type {
  CreateConversationInput,
  CreateMessageInput,
  ListMessagesQuery,
  ListConversationsQuery,
  UpdateMessageInput,
} from './conversation.validation.js';
import {
  createMessageRecord,
  findLatestMessage,
  findMessageInConversation,
  listMessages,
  updateMessageBody,
} from './message.repository.js';

/**
 * Conversation & message business flows (controllers stay thin; authorization
 * has ALREADY run in middleware — this layer adds actor/resource rules).
 *
 * Identity & tenancy rules:
 * - Workspace association ALWAYS comes from the validated middleware context.
 *   Payloads are structurally incapable of carrying workspaceId, ticketId,
 *   customerId, conversationId, senderId or senderType (strict Zod schemas).
 * - The referenced ticket is loaded through the ticket module's OWN live,
 *   workspace-scoped lookup (`findTicketInWorkspace`) — "only valid tickets
 *   have conversations" is enforced on EVERY flow, not just creation. An
 *   archived (soft-deleted) ticket therefore reads as not-found for its
 *   conversation/messages too: one consistent not-found contract, no way to
 *   tunnel writes into archived history.
 * - The conversation's customer reference is copied from the verified ticket
 *   server-side; no client path can point a conversation at a foreign
 *   customer, and no duplicated customer profile data is ever stored.
 * - Sender identity is the authenticated principal (req.auth) — never a
 *   client value. The only sender type producible today is `AGENT` (staff
 *   member): no customer-portal authentication exists in this codebase, so
 *   customer-authored flows are a documented dependency, not a faked path
 *   (an arbitrary customerId in a request is never treated as identity).
 *
 * Visibility & the assignment cap:
 * - INTERNAL notes are staff-only BY DERIVATION: only roles holding
 *   `conversation.reply` (owner/admin/agent) reach sending paths, so an
 *   internal note can only exist by a staff action. Read-side, actors
 *   without `conversation.reply` get internal notes excluded IN THE QUERY
 *   (never returned-and-scrubbed) and a 403 on a direct internal read.
 * - Agents may send only on tickets ASSIGNED to them or OPENED by them
 *   (`evaluateResourceModification`, `allowCreator: true` — the same cap the
 *   ticket module documents). Owner/admin pass as triage roles. Viewer is
 *   already structurally denied any write (no reply permission).
 *
 * Consistency (documented honestly — NO transactions in this deployment,
 * standalone MongoDB):
 * - message + metadata is NOT atomic. If the advisory conversation metadata
 *   update fails, the message remains the authoritative record, the failure
 *   is LOGGED, and a subsequent thread read self-heals the metadata
 *   (lastMessageAt/lastMessageById are recomputed from the newest message —
 *   see `repairConversationMetadata`). No misleading "consistent" claim is
 *   made, and success responses are not suppressed by audit/metadata
 *   failures, matching the project-wide fire-and-forget audit convention.
 * - Audit appends are fire-and-forget (same as every module).
 */

const TICKET_NOT_FOUND = 'Ticket not found';
const CONVERSATION_NOT_FOUND = 'Conversation not found';
const MESSAGE_NOT_FOUND = 'Message not found';

export interface ConversationRequestContext {
  /** Validated workspace context id (middleware-loaded), hex string. */
  readonly workspaceId: string;
  /** Authenticated actor (sender identity + caps), hex string. */
  readonly actorId: string;
  /** Effective role from the validated membership. */
  readonly role: WorkspaceRole;
}

// ── Private helpers ──────────────────────────────────────────────────────────

async function requireLiveTicket(
  workspaceId: Types.ObjectId,
  ticketId: string,
): Promise<{ ticketId: Types.ObjectId; customerId: Types.ObjectId }> {
  const ticket = await findTicketInWorkspace(
    workspaceId,
    new Types.ObjectId(ticketId),
  );
  if (ticket === null) throw AppError.notFound(TICKET_NOT_FOUND);
  return { ticketId: ticket._id, customerId: ticket.customerId };
}

/**
 * Loads a LIVE conversation (scoped) and confirms its ticket is still live —
 * archived tickets read as not-found through any conversation path.
 */
async function requireLiveConversation(
  workspaceId: Types.ObjectId,
  conversationId: string,
): Promise<{ conversationId: Types.ObjectId; ticketId: Types.ObjectId }> {
  const conversation = await findConversationInWorkspace(
    workspaceId,
    new Types.ObjectId(conversationId),
  );
  if (conversation === null) throw AppError.notFound(CONVERSATION_NOT_FOUND);

  const ticket = await findTicketInWorkspace(workspaceId, conversation.ticketId);
  if (ticket === null) throw AppError.notFound(TICKET_NOT_FOUND);

  return { conversationId: conversation._id, ticketId: conversation.ticketId };
}

/** Guards INTERNAL-visibility reads: staff (reply-holders) only. */
function assertStaffVisibility(role: WorkspaceRole, visibility: MessageVisibility): void {
  if (visibility === 'INTERNAL' && !roleHasPermission(role, WORKSPACE_PERMISSIONS.replyToConversations)) {
    throw AppError.forbidden('Internal notes are visible to workspace staff only');
  }
}

function visibleToRole(role: WorkspaceRole): boolean {
  return roleHasPermission(role, WORKSPACE_PERMISSIONS.replyToConversations);
}

/** Same documented agent cap as tickets: assigned-or-creator staff only. */
function assertAgentCanWorkTicket(
  context: ConversationRequestContext,
  ticketCreatorId: Types.ObjectId,
  assigneeId: Types.ObjectId | null,
): void {
  if (isWorkspacePrivilegedRole(context.role)) return;
  const decision = evaluateResourceModification(
    { userId: context.actorId, role: context.role, workspaceId: context.workspaceId },
    {
      workspaceId: context.workspaceId,
      assigneeId,
      createdById: ticketCreatorId,
      // The conversation's ticket was already proven same-workspace by its
      // tenant-scoped read; the evaluator re-checks tenant as defense-in-depth.
    },
    { permission: WORKSPACE_PERMISSIONS.replyToConversations, allowCreator: true },
  );
  if (!decision.allowed) {
    throw AppError.forbidden(
      'Only assigned agents (or workspace administrators) may send messages on this ticket',
    );
  }
}

/**
 * Self-healing metadata repair (documented limitation): recomputes
 * lastMessageAt/lastMessageById from the newest message and writes them ONLY
 * when they drifted. Idempotent under concurrency (the values converge).
 */
async function repairConversationMetadata(
  workspaceId: Types.ObjectId,
  conversation: ConversationDocument,
): Promise<void> {
  const latest = await findLatestMessage(workspaceId, conversation._id);
  const latestAt = latest?.createdAt ?? null;
  const latestBy = latest?.senderId ?? null;
  const drifted =
    (conversation.lastMessageAt?.getTime() ?? null) !== (latestAt?.getTime() ?? null) ||
    (conversation.lastMessageById?.toHexString() ?? null) !== (latestBy?.toHexString() ?? null);
  if (!drifted) return;

  const repaired = await setConversationMetadata(workspaceId, conversation._id, {
    lastMessageAt: latestAt,
    lastMessageById: latestBy,
  });
  if (repaired === null) {
    // Vanishingly rare concurrent unlink — the DRIFT stays logged loudly so
    // the advisory metadata is never silently wrong.
    logger.error(
      { conversationId: conversation._id.toHexString() },
      'Conversation metadata repair lost its race against un-linking; metadata advisory only',
    );
  }
}

// ── Conversation flows ───────────────────────────────────────────────────────

export async function getOrCreateConversationFlow(
  context: ConversationRequestContext,
  ticketId: string,
  input: CreateConversationInput,
): Promise<ConversationMutatedPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const ticket = await requireLiveTicket(workspaceId, ticketId);

  const existing = await findConversationByTicket(workspaceId, ticket.ticketId);
  if (existing !== null) {
    return { conversation: toConversationDto(existing), created: false };
  }

  const { conversation, created } = await createConversationRaceSafe(workspaceId, {
    workspaceId,
    ticketId: ticket.ticketId,
    customerId: ticket.customerId,
    subject: input.subject ?? null,
  });

  if (created) {
    recordConversationAudit({
      action: CONVERSATION_AUDIT_ACTIONS.conversationCreated,
      workspaceId,
      actorId: new Types.ObjectId(context.actorId),
      targetId: conversation._id.toHexString(),
      resourceType: 'conversation',
      metadata: { ticketId: ticket.ticketId.toHexString() },
    });
  }

  return { conversation: toConversationDto(conversation), created };
}

export async function getConversationFlow(
  context: ConversationRequestContext,
  conversationId: string,
): Promise<ConversationDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  await requireLiveConversation(workspaceId, conversationId);
  const conversation = await findConversationInWorkspace(
    workspaceId,
    new Types.ObjectId(conversationId),
  );
  // requireLiveConversation just proved existence; a null here would be an
  // un-link race — surfaced as the same not-found contract.
  if (conversation === null) throw AppError.notFound(CONVERSATION_NOT_FOUND);
  return { conversation: toConversationDto(conversation) };
}

export async function listTicketConversationsFlow(
  context: ConversationRequestContext,
  ticketId: string,
  query: ListConversationsQuery,
): Promise<ConversationListPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const ticket = await requireLiveTicket(workspaceId, ticketId);

  const result = await listConversations({
    workspaceId,
    ticketId: ticket.ticketId,
    page: query.page,
    limit: query.limit,
  } satisfies ConversationListSpec);

  return {
    items: result.items.map((doc) => toConversationDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

// ── Message flows ────────────────────────────────────────────────────────────

export async function createMessageFlow(
  context: ConversationRequestContext,
  conversationId: string,
  input: CreateMessageInput,
): Promise<MessageCreatedPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  // Re-loads the conversation's live ticket so the agent cap and archived
  // ticket behavior are enforced here — middleware alone is not trusted for
  // actor-vs-resource rules.
  const { conversationId: convObjectId } = await requireLiveConversation(workspaceId, conversationId);
  const conversation = await findConversationInWorkspace(workspaceId, convObjectId);
  if (conversation === null) throw AppError.notFound(CONVERSATION_NOT_FOUND);
  const ticket = await findTicketInWorkspace(workspaceId, conversation.ticketId);
  if (ticket === null) throw AppError.notFound(TICKET_NOT_FOUND);

  assertAgentCanWorkTicket(context, ticket.createdById, ticket.agentId ?? null);

  // Sender identity is DERIVED: authenticated principal + staff membership.
  // No customer identity exists yet, so `CUSTOMER` senders are impossible
  // through this flow by construction.
  const message = await createMessageRecord(workspaceId, {
    workspaceId,
    conversationId: conversation._id,
    ticketId: conversation.ticketId,
    senderId: new Types.ObjectId(context.actorId),
    senderType: 'AGENT',
    body: input.body,
    visibility: input.visibility,
  });

  // Advisory metadata update — a failure downgrades to a logged warning and
  // the next thread read self-heals (see repairConversationMetadata). The
  // persisted MESSAGE remains the response payload and the source of truth.
  const metadataUpdate = await updateConversationLastMessage(workspaceId, conversation._id, {
    lastMessageAt: message.createdAt,
    lastMessageById: new Types.ObjectId(context.actorId),
  });
  if (metadataUpdate === null) {
    logger.warn(
      { conversationId: conversation._id.toHexString() },
      'Conversation last-message metadata update lost its race; self-heals on next read',
    );
  }

  recordConversationAudit({
    action: CONVERSATION_AUDIT_ACTIONS.messageCreated,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    targetId: message._id.toHexString(),
    resourceType: 'message',
    metadata: {
      visibility: input.visibility,
      conversationId: conversation._id.toHexString(),
      ticketId: conversation.ticketId.toHexString(),
      senderType: 'AGENT',
    },
  });

  return { message: toMessageDto(message) };
}

export async function listMessagesFlow(
  context: ConversationRequestContext,
  conversationId: string,
  query: ListMessagesQuery,
): Promise<MessageListPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const { conversationId: convObjectId } = await requireLiveConversation(workspaceId, conversationId);
  const conversation = await findConversationInWorkspace(workspaceId, convObjectId);
  if (conversation === null) throw AppError.notFound(CONVERSATION_NOT_FOUND);

  // INTERNAL notes never even reach actors without staff visibility.
  const publicOnly = !visibleToRole(context.role);
  const result = await listMessages({
    workspaceId,
    conversationId: convObjectId,
    page: query.page,
    limit: query.limit,
    publicOnly,
  });

  // Metadata self-heals on read (documented no-transaction fallback): any
  // authorized reader can trigger the idempotent repair.
  await repairConversationMetadata(workspaceId, conversation);

  return {
    items: result.items.map((doc) => toMessageDto(doc)),
    page: query.page,
    limit: query.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

export async function getMessageFlow(
  context: ConversationRequestContext,
  conversationId: string,
  messageId: string,
): Promise<MessageDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const { conversationId: convObjectId } = await requireLiveConversation(workspaceId, conversationId);
  const message = await findMessageInConversation(
    workspaceId,
    convObjectId,
    new Types.ObjectId(messageId),
  );
  if (message === null) throw AppError.notFound(MESSAGE_NOT_FOUND);

  assertStaffVisibility(context.role, message.visibility);
  return { message: toMessageDto(message) };
}

export async function editMessageFlow(
  context: ConversationRequestContext,
  conversationId: string,
  messageId: string,
  input: UpdateMessageInput,
): Promise<MessageDetailPayload> {
  const workspaceId = new Types.ObjectId(context.workspaceId);
  const { conversationId: convObjectId } = await requireLiveConversation(workspaceId, conversationId);
  const message = await findMessageInConversation(
    workspaceId,
    convObjectId,
    new Types.ObjectId(messageId),
  );
  if (message === null) throw AppError.notFound(MESSAGE_NOT_FOUND);

  // History integrity: ONLY the original sender may edit (administrators
  // included — nobody rewrites what someone else said), the body is the only
  // editable field, and every edit is audited. No deletion endpoint exists.
  if (!message.senderId.equals(new Types.ObjectId(context.actorId))) {
    throw AppError.forbidden('Only the original sender may edit a message');
  }

  const edited = await updateMessageBody(workspaceId, convObjectId, message._id, input.body);
  if (edited === null) throw AppError.notFound(MESSAGE_NOT_FOUND);

  recordConversationAudit({
    action: CONVERSATION_AUDIT_ACTIONS.messageEdited,
    workspaceId,
    actorId: new Types.ObjectId(context.actorId),
    targetId: edited._id.toHexString(),
    resourceType: 'message',
    metadata: {
      fields: ['body'],
      visibility: message.visibility,
      conversationId: convObjectId.toHexString(),
    },
  });

  return { message: toMessageDto(edited) };
}
