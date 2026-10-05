import { Schema, model, type Model } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { DOTTED_IDENTIFIER_PATTERN } from '../../database/schema-validators.js';

import { type AuditLogDocument } from './audit-log.types.js';

const IMMUTABLE_MESSAGE = 'AuditLog entries are append-only and cannot be modified or deleted';

/**
 * Thrown (and surfaced as an opaque 500) when any code path attempts to edit
 * or remove an audit entry — a programming error, never a user condition.
 */
function rejectAuditMutation(): never {
  throw new AppError(IMMUTABLE_MESSAGE, {
    statusCode: 500,
    code: 'AUDIT_IMMUTABLE',
    isOperational: false,
  });
}

/**
 * AuditLog — immutable, tenant-scoped compliance trail.
 *
 * Immutability is enforced at the model layer, not by convention: every
 * update/delete shape (query and document middleware, bulkWrite) and any
 * modification of an already-persisted document throws. The only permitted
 * operation is `create`.
 *
 * No TTL and no archival policy yet — retention is a compliance decision that
 * the deploy phase will make (TTL index vs. cold storage), documented in
 * docs/data-model.md.
 */
const auditLogSchema = new Schema<AuditLogDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    action: {
      type: String,
      required: [true, 'Audit action is required'],
      lowercase: true,
      trim: true,
      maxlength: 100,
      match: [DOTTED_IDENTIFIER_PATTERN, 'Action must be a lowercase dotted identifier'],
    },
    resourceType: {
      type: String,
      required: [true, 'Audit resource type is required'],
      lowercase: true,
      trim: true,
      maxlength: 64,
      match: [DOTTED_IDENTIFIER_PATTERN, 'Resource type must be a lowercase dotted identifier'],
    },
    resourceId: {
      type: String,
      trim: true,
      maxlength: 64,
    },
    metadata: {
      type: Map,
      of: Schema.Types.Mixed,
    },
    ip: {
      type: String,
      maxlength: 45, // IPv4-mapped IPv6 worst case
      trim: true,
    },
    userAgent: {
      type: String,
      maxlength: 512,
      trim: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Query-shaped updates/deletes are forbidden.
auditLogSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'findOneAndDelete',
    'replaceOne',
    'deleteOne',
    'deleteMany',
  ],
  { document: false, query: true },
  rejectAuditMutation,
);
// Document-shaped deletion is forbidden.
auditLogSchema.pre('deleteOne', { document: true, query: false }, rejectAuditMutation);
// Edits of persisted documents (anything except creation) are forbidden.
auditLogSchema.pre('save', function rejectAuditEdits(): void {
  if (this.isNew) return;
  if (this.modifiedPaths({ includeChildren: true }).length > 0) {
    rejectAuditMutation();
  }
});

/**
 * Runtime guard for `bulkWrite`: its pre-hook fires but the hook runs on a
 * temporary wrapper object, so the throw does not propagate (`save()` skips
 * schema hooks entirely — verified against Mongoose 8.18). A non-enumerable
 * override makes any bulk mutation fail loudly instead of silently mutating
 * the compliance trail. Insert-only `bulkWrite` payloads remain possible
 * (they are additive, like `create`) for future batching of appends.
 */
interface BulkWriteCapable {
  bulkWrite: Model<AuditLogDocument>['bulkWrite'];
}

function installBulkWriteGuard(target: BulkWriteCapable): void {
  const original = target.bulkWrite.bind(target);
  Object.defineProperty(target, 'bulkWrite', {
    value: (operations: unknown, ...rest: unknown[]): unknown => {
      const mutating = (operations as Array<Record<string, unknown>>).some(
        (op) =>
          typeof op === 'object' &&
          op !== null &&
          ['updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'].some(
            (key) => key in op,
          ),
      );
      if (mutating) rejectAuditMutation();
      return original(operations as Parameters<typeof original>[0], ...(rest as []));
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

/**
 * Index strategy (audit logs are write-heavy — every index must earn its
 * keep; all lead with `workspaceId`):
 * - `{ workspaceId, createdAt }` desc: the workspace activity feed (default
 *   view) and retention/date-range scans.
 * - `{ workspaceId, resourceType, resourceId }`: "show history for this
 *   resource" — the audit drill-down.
 * - `{ workspaceId, actorId, createdAt }`: "what did this person do".
 */
auditLogSchema.index({ workspaceId: 1, createdAt: -1 }, { name: 'idx_audit_by_date' });
auditLogSchema.index(
  { workspaceId: 1, resourceType: 1, resourceId: 1 },
  { name: 'idx_audit_by_resource' },
);
auditLogSchema.index({ workspaceId: 1, actorId: 1, createdAt: -1 }, { name: 'idx_audit_by_actor' });

const AuditLogModelBase = model<AuditLogDocument>('AuditLog', auditLogSchema, 'audit_logs');

installBulkWriteGuard(AuditLogModelBase);

export const AuditLogModel: Model<AuditLogDocument> = AuditLogModelBase;
