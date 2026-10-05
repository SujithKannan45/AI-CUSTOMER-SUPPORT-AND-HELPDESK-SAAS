import { Schema, model, type CallbackWithoutResultAndOptionalError, type Model, type Query } from 'mongoose';

import { EMAIL_PATTERN, PHONE_PATTERN, URL_PATTERN } from '../../database/schema-validators.js';

import { CUSTOMER_STATUSES, type CustomerDocument } from './customer.types.js';

/** Hard bounds for the `tags` array — prevents unbounded-array write abuse. */
export const MAX_CUSTOMER_TAGS = 20;
const MAX_TAG_LENGTH = 40;

/**
 * Instance methods on every customer document.
 *
 * `softDelete()` stamps `deletedAt`; the live-only query scope (below) then
 * hides the document from all default reads while preserving history for
 * restore flows and analytics.
 */
interface CustomerInstanceMethods {
  softDelete(): Promise<CustomerDocument>;
}

type CustomerTypeModel = Model<
  CustomerDocument,
  Record<string, never>,
  CustomerInstanceMethods
>;

/**
 * Query option that bypasses the live-only scope (admin listings, restore
 * flows). Usage: `CustomerModel.countDocuments(filter, WITH_DELETED)`.
 */
export const WITH_DELETED = { withDeleted: true } as const;

/**
 * Customer — tenant-scoped end-user profile.
 *
 * Soft delete decision: customers are the only model in this layer that gets
 * `deletedAt`. Rationale — customer deletion is user-triggered and
 * accident-prone; keeping the row preserves history for future
 * tickets/conversations and lets the workspace undo the deletion. User and
 * Workspace lifecycle is expressed through `status` enums instead, and
 * AuditLog is append-only by definition — so no model here duplicates a
 * soft-delete concept it doesn't need.
 *
 * Because the email-uniqueness index is partial (`deletedAt: null`), a
 * soft-deleted customer's email becomes reusable; hard deletion (and any
 * purge job) is out of scope for this phase.
 */
const customerSchema = new Schema<CustomerDocument, CustomerTypeModel, CustomerInstanceMethods>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    name: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
      minlength: 1,
      maxlength: 120,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      match: [EMAIL_PATTERN, 'Customer email is not a valid address'],
      maxlength: 254,
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 20,
      match: [PHONE_PATTERN, 'Phone must be 5–20 digits with optional + and separators'],
    },
    avatarUrl: {
      type: String,
      maxlength: 2048,
      match: [URL_PATTERN, 'Avatar URL must be an absolute http(s) URL'],
    },
    status: {
      type: String,
      enum: CUSTOMER_STATUSES,
      default: 'active',
      required: true,
    },
    tags: {
      type: [String],
      default: [],
      set: (tags: string[]): string[] => [...new Set(tags.map((t) => t.trim()).filter(Boolean))],
      validate: {
        validator: (tags: string[]): boolean =>
          tags.length <= MAX_CUSTOMER_TAGS && tags.every((t) => t.length <= MAX_TAG_LENGTH),
        message: `A customer can have at most ${MAX_CUSTOMER_TAGS} tags of ${MAX_TAG_LENGTH} characters`,
      },
    },
    metadata: {
      type: Map,
      of: Schema.Types.Mixed,
      default: {},
    },
    lastInteractionAt: {
      type: Date,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

customerSchema.method('softDelete', function softDelete(
  this: CustomerDocument & CustomerInstanceMethods,
): Promise<CustomerDocument> {
  if (this.deletedAt !== null) return Promise.resolve(this);
  this.deletedAt = new Date();
  return this.save();
});

/**
 * Live-only default scope: every read excludes soft-deleted customers unless
 * the query explicitly opts in with `WITH_DELETED`. Existing filters that
 * mention `deletedAt` themselves (e.g. an admin "show deleted" view) are
 * left untouched. This is the safety net that keeps future repository code
 * from accidentally serving deleted records.
 */
customerSchema.pre(
  ['find', 'findOne', 'countDocuments'],
  function excludeDeletedCustomers(
    this: Query<unknown, CustomerDocument>,
    next: CallbackWithoutResultAndOptionalError,
  ): void {
    const options = this.getOptions() as unknown as { withDeleted?: boolean };
    if (options.withDeleted !== true && this.getFilter().deletedAt === undefined) {
      this.where({ deletedAt: null });
    }
    next();
  },
);

/**
 * Index strategy (all lead with `workspaceId` per the tenancy convention):
 * - `{ workspaceId, email }` unique, partial: per-tenant email uniqueness.
 *   Partial on "has email AND not deleted" so anonymous visitors (no email)
 *   coexist and soft-deleted customers release their address for re-use.
 *   NEVER make customer email globally unique — the same person can be a
 *   customer of many workspaces.
 * - `{ workspaceId, status }`: list/filter by lifecycle state.
 * - `{ workspaceId, createdAt }` desc: newest-signups views and date-range
 *   analytics.
 * - `{ workspaceId, updatedAt }` desc: "recently active" views.
 * - No text index on name/email yet: cross-field search will use Atlas Search
 *   when the customer-directory phase lands, not a blocking regex index.
 */
customerSchema.index(
  { workspaceId: 1, email: 1 },
  {
    unique: true,
    name: 'uniq_customer_email_per_workspace',
    partialFilterExpression: { email: { $exists: true }, deletedAt: null },
  },
);
customerSchema.index({ workspaceId: 1, status: 1 }, { name: 'idx_customers_by_status' });
customerSchema.index({ workspaceId: 1, createdAt: -1 }, { name: 'idx_customers_by_created' });
customerSchema.index({ workspaceId: 1, updatedAt: -1 }, { name: 'idx_customers_by_updated' });

export const CustomerModel = model<CustomerDocument, CustomerTypeModel>(
  'Customer',
  customerSchema,
  'customers',
);
