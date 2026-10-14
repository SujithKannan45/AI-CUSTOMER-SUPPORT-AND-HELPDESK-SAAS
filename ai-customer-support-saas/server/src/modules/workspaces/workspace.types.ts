import type { Document, Types } from 'mongoose';

/**
 * Centralized RBAC vocabulary for the whole SaaS.
 *
 * Every role reference in the codebase — schemas, authorization middleware,
 * services, seeded data — must import from here. Never scatter `'admin'`
 * string literals; a typo becomes a permission hole.
 *
 * Hierarchy: owner > admin > agent > viewer. Roles are an ordered tuple with
 * numeric weights: role LEVEL answers "is this role at least a manager?",
 * while the permission registry (modules/rbac) answers "may this role do X
 * exactly?". Both exist because hierarchy alone is too coarse (an agent must
 * not create customers, yet outranks viewer).
 */
export const WORKSPACE_ROLES = ['owner', 'admin', 'agent', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Numeric weight per role; higher wins. The single source of role ordering. */
export const ROLE_WEIGHTS: Record<WorkspaceRole, number> = {
  owner: 3,
  admin: 2,
  agent: 1,
  viewer: 0,
};

/**
 * Pure authorization predicate for Prompt 4+ ("may this role do X in this
 * workspace?"). Deliberately pure and framework-free — middleware will compose
 * it with the membership lookup; it contains no Express or DB code.
 */
export function hasAtLeastRole(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_WEIGHTS[role] >= ROLE_WEIGHTS[minimum];
}

/** Membership lifecycle inside a workspace (independent of user status). */
export const WORKSPACE_MEMBER_STATUSES = ['active', 'invited', 'suspended'] as const;
export type WorkspaceMemberStatus = (typeof WORKSPACE_MEMBER_STATUSES)[number];

/** Workspace (tenant) lifecycle. */
export const WORKSPACE_STATUSES = ['active', 'archived'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** Basic, typed workspace settings — extended additively in later phases. */
export interface WorkspaceSettings {
  timezone: string;
  locale: string;
}

/**
 * Workspace — the tenant boundary. Everything business-owned carries a
 * reference back to this document; no resource is ever embedded inside it.
 */
export interface WorkspaceDocument extends Document<Types.ObjectId> {
  name: string;
  /**
   * Public, URL-safe tenant identifier. Globally unique across the platform
   * (it names the tenant) and immutable after creation.
   */
  slug: string;
  ownerId: Types.ObjectId;
  status: WorkspaceStatus;
  settings: WorkspaceSettings;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * WorkspaceMember — a user's role inside one workspace; the row that RBAC
 * will consult. One membership per (workspace, user), exactly one `owner`
 * membership per workspace (partial unique index in the model).
 *
 * Customers are NOT members — they live in the `customers` collection.
 */
export interface WorkspaceMemberDocument extends Document<Types.ObjectId> {
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  /** Who invited this member; null when the workspace owner self-created. */
  invitedBy?: Types.ObjectId;
  /** Membership start — set once, never re-derived from createdAt. */
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
