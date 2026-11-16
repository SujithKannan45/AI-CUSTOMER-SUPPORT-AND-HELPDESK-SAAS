/**
 * Unified workspace search vocabulary (Prompt 17).
 *
 * Scope: application-level search over EXISTING tenant-owned records. This is
 * ordinary MongoDB regex matching, not semantic/relevance-ranked search — no
 * Atlas Search, Elasticsearch or text index is configured in this deployment,
 * and the unified endpoint never claims otherwise.
 *
 * Messages are intentionally absent from the unified surface: message search
 * is conversation-scoped (`GET …/conversations/:id/messages?search=`), where
 * the existing authorization can prove the caller may read the thread and
 * where INTERNAL notes are excluded inside the query for non-staff roles.
 */

export const SEARCH_ENTITY_TYPES = [
  'ticket',
  'customer',
  'knowledge_base_article',
  'escalation',
  'conversation',
  'notification',
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/**
 * One search hit. Only fields each entity's own DTO already exposes to the
 * caller are allowed here — ids, machine codes and short labels. Customer
 * email/phone, message bodies, internal notes and document bytes never enter
 * this shape.
 */
export interface WorkspaceSearchItemDto {
  readonly type: SearchEntityType;
  readonly id: string;
  /** Short primary label (ticket number + subject, customer name, …). */
  readonly title: string;
  /** Optional short excerpt (KB summary, notification body). */
  readonly snippet: string | null;
  /** Machine metadata for client-side routing/badges. Strings only. */
  readonly metadata: Record<string, string | null>;
}
