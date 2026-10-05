import type { Document, Types } from 'mongoose';

/** Customer lifecycle inside a workspace. */
export const CUSTOMER_STATUSES = ['active', 'blocked'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/**
 * Customer — an end user who contacts a workspace for support. Strictly
 * tenant-scoped: belongs to exactly one workspace, never a platform identity.
 *
 * Distinct from `User` (internal staff identity) and from `WorkspaceMember`
 * (customers must never hold internal roles).
 *
 * Conversations, tickets and CSAT scores will reference this document by id —
 * they are NOT embedded here (bounded documents, independent growth rates).
 */
export interface CustomerDocument extends Document<Types.ObjectId> {
  workspaceId: Types.ObjectId;
  name: string;
  /**
   * Optional by design: chat-widget visitors may exist before any email is
   * captured. When present it is validated and unique per workspace (compound
   * index — the same email may exist in different workspaces).
   */
  email?: string;
  phone?: string;
  avatarUrl?: string;
  status: CustomerStatus;
  /** Free-form segmentation labels; bounded (max 20 × 40 chars) in the schema. */
  tags: string[];
  /**
   * Integration key/value bag (e.g. stripeCustomerId, crmId). Values are
   * application-managed — never store secrets, tokens or conversation
   * content here.
   */
  metadata: Map<string, unknown>;
  /** Last time the customer interacted with this workspace (any channel). */
  lastInteractionAt?: Date;
  /**
   * Soft delete (see model): set by the future delete flow; null = live.
   * Default queries exclude non-null values.
   */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
