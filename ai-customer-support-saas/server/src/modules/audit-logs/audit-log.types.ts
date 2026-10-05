import type { Document, Types } from 'mongoose';

/**
 * AuditLog — append-only compliance record.
 *
 * There is intentionally NO update or delete path, no status enum, and no
 * soft delete: the collection is the tamper-evident "what happened" story for
 * security reviews and compliance. Entries are written once and read forever.
 */
export interface AuditLogDocument extends Document<Types.ObjectId> {
  workspaceId: Types.ObjectId;
  /**
   * Who performed the action. Null = non-human actor (system job, AI
   * assistant, incoming webhook). Human actors always reference a User.
   */
  actorId?: Types.ObjectId | null;
  /**
   * Dotted action name, `<domain>.<verb>` — e.g. `member.added`,
   * `workspace.settings_changed`, `ticket.status_changed`. An open vocabulary:
   * later modules register new actions without schema changes (pattern-
   * constrained by the model, not enum-locked).
   */
  action: string;
  /** Kind of resource acted upon, e.g. `user`, `member`, `customer`, `ticket`. */
  resourceType: string;
  /** Target resource id (string form so external ids also fit); optional for actor-scoped events like `user.login`. */
  resourceId?: string;
  /** Structured context of the event. Never secrets, tokens or credentials. */
  metadata?: Map<string, unknown>;
  /** Request origin when captured; leniently sized to fit IPv4/IPv6. */
  ip?: string;
  userAgent?: string;
  /** Occurrence time = `createdAt` (single source; no duplicate field). */
  createdAt: Date;
}
