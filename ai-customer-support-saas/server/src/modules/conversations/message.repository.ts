import { type Types, type FilterQuery } from 'mongoose';

import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import { MessageModel } from './conversation.model.js';
import type { MessageDocument, MessageVisibility } from './conversation.types.js';

/**
 * Message persistence layer — the ONLY module that touches the `messages`
 * collection:
 *
 * - Every query is workspace- AND conversation-scoped (composed through
 *   `tenantFilter()` and asserted). Messages are never fetched globally by id
 *   and authorized afterwards — the scoped filter IS the authorization and
 *   the 404 concealment in one.
 * - Chronology: reads sort `{ createdAt: 1, _id: 1 }` (ascending, stable
 *   under per-millisecond bursts) and writes never infer order from clocks.
 * - Visibility filtering is a DATABASE-side `$eq PRIVATE-PUBLIC` exclusion
 *   for actors without staff visibility — internal notes never even leave
 *   MongoDB for those callers (no post-read scrubbing that could leak in an
 *   exception path).
 */

export interface MessageCreateArgs {
  readonly workspaceId: Types.ObjectId;
  readonly conversationId: Types.ObjectId;
  /** Copied from the conversation server-side; never a client field. */
  readonly ticketId: Types.ObjectId;
  readonly senderId: Types.ObjectId;
  readonly senderType: 'AGENT' | 'CUSTOMER';
  readonly body: string;
  readonly visibility: MessageVisibility;
}

/** Appends one message; content metadata (`createdAt`) is written by Mongo timestamps. */
export async function createMessageRecord(
  workspaceId: Types.ObjectId,
  args: MessageCreateArgs,
): Promise<MessageDocument> {
  return MessageModel.create({
    ...tenantFilter(workspaceId),
    conversationId: args.conversationId,
    ticketId: args.ticketId,
    senderId: args.senderId,
    senderType: args.senderType,
    body: args.body,
    visibility: args.visibility,
    attachments: [],
  });
}

export interface MessageListSpec {
  readonly workspaceId: Types.ObjectId;
  readonly conversationId: Types.ObjectId;
  readonly page: number;
  readonly limit: number;
  /**
   * When true (actors without staff visibility), INTERNAL notes are excluded
   * IN THE QUERY — the caller never receives them to scrub later.
   */
  readonly publicOnly: boolean;
}

export interface MessageListResult {
  readonly items: readonly MessageDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

/** Chronological, paginated thread read with a deterministic `_id` tiebreak. */
export async function listMessages(spec: MessageListSpec): Promise<MessageListResult> {
  const filter: FilterQuery<MessageDocument> = {
    ...tenantFilter(spec.workspaceId),
    conversationId: spec.conversationId,
  };
  if (spec.publicOnly) {
    filter['visibility'] = 'PUBLIC';
  }
  assertTenantScope(filter, 'listMessages');

  const [items, total] = await Promise.all([
    MessageModel.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    MessageModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

/**
 * Reads ONE message scoped by workspace AND conversation. Returns null for
 * foreign ids, unknown ids, and messages that simply are not in THIS
 * conversation — no cross-conversation existence oracle.
 */
export async function findMessageInConversation(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
  messageId: Types.ObjectId,
): Promise<MessageDocument | null> {
  const filter: FilterQuery<MessageDocument> = {
    ...tenantFilter(workspaceId),
    conversationId,
    _id: messageId,
  };
  assertTenantScope(filter, 'findMessageInConversation');
  return MessageModel.findOne(filter);
}

/**
 * History-preserving body edit: scoped `findOneAndUpdate` on the body ONLY.
 * Visibility and all references are structurally unreachable here.
 */
export async function updateMessageBody(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
  messageId: Types.ObjectId,
  body: string,
): Promise<MessageDocument | null> {
  const filter: FilterQuery<MessageDocument> = {
    ...tenantFilter(workspaceId),
    conversationId,
    _id: messageId,
  };
  assertTenantScope(filter, 'updateMessageBody');
  return MessageModel.findOneAndUpdate(filter, { $set: { body } }, { new: true, runValidators: true });
}

/**
 * The NEWEST message (any visibility) — the repair path's source of truth
 * when conversation metadata drifted, so the metadata is always derivable.
 */
export async function findLatestMessage(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
): Promise<MessageDocument | null> {
  const filter: FilterQuery<MessageDocument> = {
    ...tenantFilter(workspaceId),
    conversationId,
  };
  assertTenantScope(filter, 'findLatestMessage');
  return MessageModel.findOne(filter).sort({ createdAt: -1, _id: -1 });
}
