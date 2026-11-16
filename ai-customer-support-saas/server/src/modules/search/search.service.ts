import { Types } from 'mongoose';

import { searchConversations } from '../conversations/conversation.repository.js';
import { listCustomers } from '../customers/customer.repository.js';
import { listEscalations } from '../escalations/escalation.repository.js';
import { listArticles } from '../knowledge-base/kb-article.repository.js';
import { listNotifications } from '../notifications/notification.repository.js';
import {
  roleHasPermission,
  WORKSPACE_PERMISSIONS,
  type WorkspacePermission,
} from '../rbac/rbac.permissions.js';
import { listTickets } from '../tickets/ticket.repository.js';
import type { WorkspaceRole } from '../workspaces/workspace.types.js';

import type { WorkspaceSearchPayload } from './search.dto.js';
import {
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type WorkspaceSearchItemDto,
} from './search.types.js';
import type { WorkspaceSearchQuery } from './search.validation.js';

/**
 * Unified workspace search (Prompt 17) — a thin, permission-aware fan-out
 * over the EXISTING module repositories. No model is queried from here and
 * no query construction is duplicated: each repository already composes its
 * mandatory `tenantFilter()` scope, its archive/visibility law and its
 * allowlisted filters. This service only decides WHICH modules this actor
 * may search and maps results into one homogeneous shape.
 *
 * Security law:
 * - The workspace comes from the validated middleware context, never the
 *   client; every repository call receives it as the tenant scope.
 * - RBAC is applied BEFORE a module is queried: a type the role cannot read
 *   is skipped (reported as `skippedTypes`), so results never reveal even
 *   the existence of records the caller may not read.
 * - Notifications are self-scoped by construction (`recipientId = actor`),
 *   matching the inbox law — no permission gate, no cross-user possibility.
 * - Customer email/phone, ticket descriptions, message bodies and internal
 *   notes are never placed in unified results.
 *
 * Capability honesty: matching is MongoDB case-insensitive literal substring
 * search over allowlisted fields inside each tenant slice. There is no
 * semantic search, relevance ranking, Atlas Search or Elasticsearch in this
 * deployment, and none is claimed.
 */

export interface SearchRequestContext {
  /** Validated workspace context id (middleware), hex string. */
  readonly workspaceId: string;
  /** Authenticated actor — the only recipient identity notification search uses. */
  readonly actorId: string;
  /** Effective role from the validated membership. */
  readonly role: WorkspaceRole;
}

/**
 * Read permission each entity type requires. `notification` is absent on
 * purpose: the inbox is self-scoped, so membership (already proven) is the
 * correct boundary and no workspace permission exists for it.
 */
const TYPE_PERMISSIONS: Partial<Record<SearchEntityType, WorkspacePermission>> = {
  ticket: WORKSPACE_PERMISSIONS.viewTickets,
  customer: WORKSPACE_PERMISSIONS.viewCustomers,
  knowledge_base_article: WORKSPACE_PERMISSIONS.viewKnowledgeBase,
  escalation: WORKSPACE_PERMISSIONS.viewEscalations,
  conversation: WORKSPACE_PERMISSIONS.viewConversations,
};

/** Bounded per-type query against ONE module's repository. */
async function searchByType(
  type: SearchEntityType,
  context: SearchRequestContext,
  term: string,
  limit: number,
): Promise<readonly WorkspaceSearchItemDto[]> {
  const workspaceId = new Types.ObjectId(context.workspaceId);

  switch (type) {
    case 'ticket': {
      const result = await listTickets({
        workspaceId,
        page: 1,
        limit,
        search: term,
        sort: 'updatedAt',
        order: 'desc',
        archiveState: 'live',
      });
      return result.items.map((doc) => ({
        type: 'ticket',
        id: doc._id.toHexString(),
        title: `${doc.number} · ${doc.subject}`,
        snippet: null,
        metadata: { number: doc.number, status: doc.status, priority: doc.priority },
      }));
    }

    case 'customer': {
      // Customer PII stays minimal: name + status only. Email/phone may have
      // matched the search term but are not echoed into a global result list.
      const result = await listCustomers({
        workspaceId,
        page: 1,
        limit,
        search: term,
        sort: 'updatedAt',
        order: 'desc',
        archiveState: 'live',
      });
      return result.items.map((doc) => ({
        type: 'customer',
        id: doc._id.toHexString(),
        title: doc.name,
        snippet: null,
        metadata: { status: doc.status },
      }));
    }

    case 'knowledge_base_article': {
      // Drafts are visible to staff with kb.view (their existing management
      // read); ARCHIVED content is excluded from global search.
      const result = await listArticles({
        workspaceId,
        page: 1,
        limit,
        search: term,
        excludeArchived: true,
        sort: 'updatedAt',
        order: 'desc',
      });
      return result.items.map((doc) => ({
        type: 'knowledge_base_article',
        id: doc._id.toHexString(),
        title: doc.title,
        snippet: doc.summary.length > 0 ? doc.summary : null,
        metadata: { status: doc.status, slug: doc.slug },
      }));
    }

    case 'escalation': {
      const result = await listEscalations({
        workspaceId,
        page: 1,
        limit,
        search: term,
      });
      return result.items.map((doc) => ({
        type: 'escalation',
        id: doc._id.toHexString(),
        title: doc.reasonCode,
        snippet: null,
        metadata: {
          status: doc.status,
          priority: doc.priority,
          triggerType: doc.triggerType,
          ticketId: doc.ticketId.toHexString(),
        },
      }));
    }

    case 'conversation': {
      const items = await searchConversations({ workspaceId, search: term, limit });
      return items.map((doc) => ({
        type: 'conversation',
        id: doc._id.toHexString(),
        title: doc.subject?.length ? doc.subject : 'Conversation',
        snippet: null,
        metadata: {
          ticketId: doc.ticketId.toHexString(),
          lastMessageAt: doc.lastMessageAt?.toISOString() ?? null,
        },
      }));
    }

    case 'notification': {
      const result = await listNotifications({
        workspaceId,
        recipientId: new Types.ObjectId(context.actorId),
        page: 1,
        limit,
        unreadOnly: false,
        search: term,
      });
      // Title/body are content-safe by schema (Prompt 16): machine facts, no
      // message text, no internal notes.
      return result.items.map((doc) => ({
        type: 'notification',
        id: doc._id.toHexString(),
        title: doc.title,
        snippet: doc.body,
        metadata: {
          type: doc.type,
          entityType: doc.entityType,
          entityId: doc.entityId.toHexString(),
          read: doc.readAt === null ? 'false' : 'true',
        },
      }));
    }
  }
}

export async function searchWorkspaceFlow(
  context: SearchRequestContext,
  query: WorkspaceSearchQuery,
): Promise<WorkspaceSearchPayload> {
  const requested = [...new Set<SearchEntityType>(query.types ?? SEARCH_ENTITY_TYPES)];

  const searchedTypes: SearchEntityType[] = [];
  const skippedTypes: SearchEntityType[] = [];
  for (const type of requested) {
    const permission = TYPE_PERMISSIONS[type];
    if (permission !== undefined && !roleHasPermission(context.role, permission)) {
      skippedTypes.push(type);
      continue;
    }
    searchedTypes.push(type);
  }

  const groups = await Promise.all(
    searchedTypes.map((type) => searchByType(type, context, query.q, query.limit)),
  );

  const counts: Record<string, number> = {};
  const items: WorkspaceSearchItemDto[] = [];
  searchedTypes.forEach((type, index) => {
    const group = groups[index] ?? [];
    counts[type] = group.length;
    items.push(...group);
  });

  return {
    query: query.q,
    requestedTypes: requested,
    searchedTypes,
    skippedTypes,
    perTypeLimit: query.limit,
    counts,
    items,
    totalResults: items.length,
  };
}
