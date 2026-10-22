import { type Types, type FilterQuery } from 'mongoose';

import { AppError } from '../../core/errors/index.js';
import { assertTenantScope, tenantFilter } from '../../database/tenant.js';

import type { ConversationListSpec } from './conversation.dto.js';
import { ConversationModel } from './conversation.model.js';
import type { ConversationDocument } from './conversation.types.js';

/**
 * Conversation persistence layer — the ONLY module that touches the
 * `conversations` collection, mirroring the ticket repository conventions:
 *
 * - EVERY query is built through `tenantFilter()` and asserted with
 *   `assertTenantScope()`. The document `_id` and parent references are
 *   ALWAYS composed here, so no caller can fetch "a conversation id" without
 *   the workspace scope: foreign ids read as not-found (both the check and
 *   the concealment).
 * - The one-primary-conversation-per-ticket DESIGN is enforced by the unique
 *   `{ workspaceId, ticketId }` index; a lost get-or-create race is resolved
 *   by re-reading the winner (see `isDuplicateConversationError`).
 * - Last-message metadata updates are SCOPED `findOneAndUpdate`s, never
 *   read-then-write. This deployment does NOT support multi-document
 *   transactions (standalone mongod); metadata is deliberately advisory and
 *   self-heals on read (documented in conversation.service.ts), so no
 *   transaction is claimed or relied on anywhere here.
 */

/**
 * Creates the primary conversation for a ticket. The caller has ALREADY
 * verified the ticket is live and in the same workspace, and supplies the
 * customer reference copied from that ticket server-side.
 */
export interface ConversationCreateArgs {
  readonly workspaceId: Types.ObjectId;
  readonly ticketId: Types.ObjectId;
  readonly customerId: Types.ObjectId;
  readonly subject: string | null;
}

export async function createConversation(
  workspaceId: Types.ObjectId,
  record: ConversationCreateArgs,
): Promise<ConversationDocument> {
  return ConversationModel.create({
    ...tenantFilter(workspaceId),
    ticketId: record.ticketId,
    customerId: record.customerId,
    subject: record.subject,
    lastMessageAt: null,
    lastMessageById: null,
  });
}

/**
 * Creates the primary conversation for a ticket, resolving a duplicate-key
 * race by re-reading the winning document. Returns `{ conversation, created }`
 * so the service can report an accurate `created` flag (and audit only real
 * creations).
 */
export async function createConversationRaceSafe(
  workspaceId: Types.ObjectId,
  record: ConversationCreateArgs,
): Promise<{ conversation: ConversationDocument; created: boolean }> {
  try {
    const createdDocument = await createConversation(workspaceId, record);
    return { conversation: createdDocument, created: true };
  } catch (error) {
    if (!isDuplicateConversationError(error)) {
      throw error;
    }
    const winner = await findConversationByTicket(workspaceId, record.ticketId);
    if (winner === null) {
      // Duplicate said another row exists, but the re-read missed it — treat
      // as an integrity anomaly (non-operational), never as another tenant's
      // data.
      throw new AppError('Conversation uniqueness race could not be resolved', {
        statusCode: 500,
        code: 'CONVERSATION_RACE_UNRESOLVED',
        isOperational: false,
        cause: error,
      });
    }
    return { conversation: winner, created: false };
  }
}

/**
 * True when the error is a duplicate-key on the conversation ticket scope
 * specifically (index `uniq_conversation_per_ticket`). Any other duplicate
 * key is a programming error and is rethrown untouched.
 */
export function isDuplicateConversationError(error: unknown): boolean {
  const candidate = error as { code?: unknown; keyValue?: Record<string, unknown> } | null;
  if (candidate === null || typeof candidate !== 'object') return false;
  if (candidate['code'] !== 11000) return false;
  return candidate['keyValue']?.['ticketId'] !== undefined;
}

/**
 * Finds ONE conversation by id, scoped to its workspace. `null` also for
 * foreign ids — a single lookup answers "does this conversation exist here"
 * without crossing tenants.
 */
export async function findConversationInWorkspace(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
): Promise<ConversationDocument | null> {
  const filter: FilterQuery<ConversationDocument> = {
    ...tenantFilter(workspaceId),
    _id: conversationId,
  };
  assertTenantScope(filter, 'findConversationInWorkspace');
  return ConversationModel.findOne(filter);
}

/** Finds the PRIMARY conversation of a ticket (unique by index). */
export async function findConversationByTicket(
  workspaceId: Types.ObjectId,
  ticketId: Types.ObjectId,
): Promise<ConversationDocument | null> {
  const filter: FilterQuery<ConversationDocument> = {
    ...tenantFilter(workspaceId),
    ticketId,
  };
  assertTenantScope(filter, 'findConversationByTicket');
  return ConversationModel.findOne(filter);
}

export interface ConversationListResult {
  readonly items: readonly ConversationDocument[];
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * Listing conversations of one ticket, fully database-side (pagination and
 * counts under the SAME tenant + ticket constraints; a deterministic
 * `_id` tiebreak for concurrent inserts). In the one-primary design this
 * normally returns one row — the endpoint stays generic so workspaces and
 * future threading features keep one contract.
 */
export async function listConversations(spec: ConversationListSpec): Promise<ConversationListResult> {
  const filter: FilterQuery<ConversationDocument> = {
    ...tenantFilter(spec.workspaceId),
    ticketId: spec.ticketId,
  };
  assertTenantScope(filter, 'listConversations');

  const [items, total] = await Promise.all([
    ConversationModel.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((spec.page - 1) * spec.limit)
      .limit(spec.limit),
    ConversationModel.countDocuments(filter),
  ]);

  return { items, total, hasMore: spec.page * spec.limit < total };
}

/**
 * Advisory metadata write after a message persisted. Scoped to the
 * conversation AND its workspace; `null` return means the vanishingly-rare
 * concurrent unlink — the service documents the self-healing fallback.
 */
export async function updateConversationLastMessage(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
  stamps: { readonly lastMessageAt: Date; readonly lastMessageById: Types.ObjectId },
): Promise<ConversationDocument | null> {
  const filter: FilterQuery<ConversationDocument> = {
    ...tenantFilter(workspaceId),
    _id: conversationId,
  };
  assertTenantScope(filter, 'updateConversationLastMessage');
  return ConversationModel.findOneAndUpdate(
    filter,
    {
      $set: {
        lastMessageAt: stamps.lastMessageAt,
        lastMessageById: stamps.lastMessageById,
      },
    },
    { new: true },
  );
}

/** Self-healing metadata repair path (used when metadata drifted). */
export async function setConversationMetadata(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
  stamps: {
    readonly lastMessageAt: Date | null;
    readonly lastMessageById: Types.ObjectId | null;
  },
): Promise<ConversationDocument | null> {
  const filter: FilterQuery<ConversationDocument> = {
    ...tenantFilter(workspaceId),
    _id: conversationId,
  };
  assertTenantScope(filter, 'setConversationMetadata');
  return ConversationModel.findOneAndUpdate(
    filter,
    { $set: { lastMessageAt: stamps.lastMessageAt, lastMessageById: stamps.lastMessageById } },
    { new: true },
  );
}
