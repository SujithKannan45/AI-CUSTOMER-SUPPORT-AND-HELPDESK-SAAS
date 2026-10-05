import { Schema, model } from 'mongoose';

import { SLUG_PATTERN } from '../../database/schema-validators.js';

import { WORKSPACE_STATUSES, type WorkspaceDocument } from './workspace.types.js';

/**
 * Workspace — the primary tenant model.
 *
 * Deliberately small: it owns identity, ownership and lifecycle only.
 * Members, customers, tickets, knowledge and AI configuration are separate
 * collections that reference this document by `workspaceId` — embedding them
 * here would hit the 16MB ceiling and turn every read into a contention
 * point.
 */
const workspaceSettingsSchema = new Schema(
  {
    timezone: { type: String, default: 'UTC', maxlength: 64, trim: true },
    locale: { type: String, default: 'en', maxlength: 10, trim: true },
  },
  { _id: false },
);

const workspaceSchema = new Schema<WorkspaceDocument>(
  {
    name: {
      type: String,
      required: [true, 'Workspace name is required'],
      trim: true,
      minlength: 1,
      maxlength: 100,
    },
    slug: {
      type: String,
      required: [true, 'Workspace slug is required'],
      lowercase: true,
      trim: true,
      immutable: true,
      minlength: 3,
      maxlength: 63,
      match: [SLUG_PATTERN, 'Slug must be 3–63 chars: lowercase letters, digits, single hyphens'],
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Workspace owner is required'],
    },
    status: {
      type: String,
      enum: WORKSPACE_STATUSES,
      default: 'active',
      required: true,
    },
    settings: {
      type: workspaceSettingsSchema,
      default: () => ({}),
    },
  },
  { timestamps: true },
);

/**
 * Index strategy:
 * - `slug` unique: tenant resolution (URL/subdomain) + duplicate prevention.
 *   Workspace lookup is global by design — this is the one collection that is
 *   itself the tenant. Declared via schema.index() with an explicit name (the
 *   `unique: true` path shorthand would silently generate a second `slug_1`
 *   index and conflict with this one).
 * - No `ownerId` index: "workspaces I own" flows through WorkspaceMember
 *   (the access-control source of truth), and owner-only lookups are rare.
 */
workspaceSchema.index({ slug: 1 }, { unique: true, name: 'uniq_workspace_slug' });

export const WorkspaceModel = model<WorkspaceDocument>('Workspace', workspaceSchema, 'workspaces');
