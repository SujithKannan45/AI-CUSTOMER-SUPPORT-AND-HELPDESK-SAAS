import { Schema, model } from 'mongoose';

import {
  WORKSPACE_MEMBER_STATUSES,
  WORKSPACE_ROLES,
  type WorkspaceMemberDocument,
} from './workspace.types.js';

/**
 * WorkspaceMember — the row RBAC consults: "which role does this user hold in
 * this workspace?".
 *
 * Design notes:
 * - One membership per (workspaceId, userId) — enforced by a unique compound
 *   index, not by application logic.
 * - Exactly one `owner` per workspace — enforced by a partial unique index
 *   covering only `role: 'owner'` documents, so the DB rejects a second owner
 *   even if a buggy service path forgets to check.
 * - Members are internal staff only. Customers never appear here; adding them
 *   would blur `agent`-level permissions onto end users.
 */
const workspaceMemberSchema = new Schema<WorkspaceMemberDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    role: {
      type: String,
      enum: WORKSPACE_ROLES,
      required: true,
    },
    status: {
      type: String,
      enum: WORKSPACE_MEMBER_STATUSES,
      default: 'active',
      required: true,
    },
    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    joinedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
  },
  { timestamps: true },
);

/**
 * Index strategy:
 * - `{ workspaceId, userId }` unique: direct "is this user in this workspace"
 *   lookups (the hot path for every tenant-scoped request) + duplicate
 *   prevention. Leads with workspaceId per the tenancy convention.
 * - `{ userId, status }`: reverse lookup — "list workspaces for user X"
 *   (workspace switcher, Prompt 4 session loading) filtered to active
 *   memberships.
 * - Owner invariant: partial unique on `{ workspaceId }` scoped to owner docs
 *   (see model docs).
 */
workspaceMemberSchema.index(
  { workspaceId: 1, userId: 1 },
  { unique: true, name: 'uniq_member_per_workspace' },
);
workspaceMemberSchema.index({ userId: 1, status: 1 }, { name: 'idx_memberships_by_user' });
workspaceMemberSchema.index(
  { workspaceId: 1 },
  { unique: true, partialFilterExpression: { role: 'owner' }, name: 'uniq_owner_per_workspace' },
);

export const WorkspaceMemberModel = model<WorkspaceMemberDocument>(
  'WorkspaceMember',
  workspaceMemberSchema,
  'workspace_members',
);
