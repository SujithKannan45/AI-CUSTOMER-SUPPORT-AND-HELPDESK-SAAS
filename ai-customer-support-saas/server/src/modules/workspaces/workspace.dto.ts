import type { Types } from 'mongoose';

import type {
  WorkspaceMemberStatus,
  WorkspaceRole,
  WorkspaceStatus,
  WorkspaceSettings,
} from './workspace.types.js';

/**
 * Workspace module — public DTOs, service payloads and request-context types.
 *
 * Documents (WorkspaceDocument / WorkspaceMemberDocument) are defined in
 * workspace.types.ts alongside the RBAC vocabulary. This file holds the SAFE
 * representation that crosses the HTTP boundary and the typed context the
 * middleware attaches to requests — never the raw Mongoose documents.
 */

/** Client-safe workspace representation (owner id included; members are separate collections). */
export interface WorkspaceDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: string;
  readonly status: WorkspaceStatus;
  readonly settings: WorkspaceSettings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Client-safe membership representation (used inside workspace responses and listings). */
export interface WorkspaceMembershipDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly status: WorkspaceMemberStatus;
  readonly joinedAt: string;
}

/**
 * A workspace listing row: the workspace plus the caller's membership in it —
 * everything a workspace switcher needs, nothing about other users.
 */
export interface WorkspaceListItemDto {
  readonly workspace: WorkspaceDto;
  readonly membership: WorkspaceMembershipDto;
}

/** POST /api/v1/workspaces — 201 payload. */
export interface CreatedWorkspacePayload {
  readonly workspace: WorkspaceDto;
  readonly membership: WorkspaceMembershipDto;
}

/** GET /api/v1/workspaces/:workspaceId — 200 payload (details include the caller's role). */
export interface WorkspaceDetailPayload {
  readonly workspace: WorkspaceDto;
  readonly membership: WorkspaceMembershipDto;
}

/** GET /api/v1/workspaces — 200 payload. */
export interface WorkspaceListPayload {
  readonly items: readonly WorkspaceListItemDto[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

// ── Mappers (the single place documents become DTOs) ─────────────────────────

export function toWorkspaceDto(doc: {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  ownerId: Types.ObjectId;
  status: WorkspaceStatus;
  settings: WorkspaceSettings;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceDto {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    slug: doc.slug,
    ownerId: doc.ownerId.toHexString(),
    status: doc.status,
    settings: {
      timezone: doc.settings?.timezone ?? 'UTC',
      locale: doc.settings?.locale ?? 'en',
    },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toWorkspaceMembershipDto(doc: {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  joinedAt: Date;
}): WorkspaceMembershipDto {
  return {
    id: doc._id.toHexString(),
    workspaceId: doc.workspaceId.toHexString(),
    userId: doc.userId.toHexString(),
    role: doc.role,
    status: doc.status,
    joinedAt: doc.joinedAt.toISOString(),
  };
}
