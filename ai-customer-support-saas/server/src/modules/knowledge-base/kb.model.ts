import {
  Schema,
  model,
  type CallbackWithoutResultAndOptionalError,
  type Model,
  type Query,
} from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { SLUG_PATTERN } from '../../database/schema-validators.js';

import {
  KB_ARTICLE_STATUSES,
  KB_BODY_MAX,
  KB_CHANGE_SUMMARY_MAX,
  KB_DESCRIPTION_MAX,
  KB_DISPLAY_ORDER_MAX,
  KB_SLUG_MAX,
  KB_SUMMARY_MAX,
  KB_TAG_MAX_LENGTH,
  KB_TITLE_MAX,
  MAX_KB_CATEGORY_DEPTH,
  MAX_KB_TAGS,
  type KbArticleDocument,
  type KbArticleStatus,
  type KbCategoryDocument,
  type KbRevisionDocument,
} from './kb.types.js';

/**
 * Knowledge Base persistence boundary — the ONLY module that registers the
 * `kb_categories`, `kb_articles` and `kb_article_revisions` collections
 * (mirrors ticket.model.ts / conversation.model.ts).
 *
 * Archive behaviors differ deliberately between the two content models:
 * - Categories reuse the platform soft-delete convention (`archivedAt` +
 *   live-only pre-query hook + explicit `withArchive` opt-out): an archived
 *   category vanishes from ordinary reads everywhere, so no consumer can
 *   silently attach content to a dead node.
 * - Articles carry ARCHIVED as a FIRST-CLASS status and get NO hidden hook —
 *   every article query composes status filters explicitly, because a silent
 *   default scope around draft/published content is exactly how draft
 *   material leaks into a wrong audience. Revisions are immutable history and
 *   never filtered at all.
 */

// ── Category ────────────────────────────────────────────────────────────────

const categorySchema = new Schema<KbCategoryDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      minlength: 1,
      maxlength: 100,
    },
    /** Service-derived from `name` (never client-supplied); see kb.types.ts. */
    slug: {
      type: String,
      required: [true, 'Category slug is required'],
      lowercase: true,
      trim: true,
      maxlength: KB_SLUG_MAX,
      match: [SLUG_PATTERN, 'Category slug must be lowercase letters, digits and single hyphens'],
    },
    description: {
      type: String,
      default: null,
      maxlength: KB_DESCRIPTION_MAX,
      trim: true,
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: 'KnowledgeBaseCategory',
      default: null,
    },
    displayOrder: {
      type: Number,
      default: 0,
      min: 0,
      max: KB_DISPLAY_ORDER_MAX,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    createdById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Creator reference is required'],
    },
    updatedById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Editor reference is required'],
    },
  },
  { timestamps: true },
);

/** Query option that bypasses the live-only scope (archived-category reads). */
interface KbCategoryQueryOptions {
  withArchive?: boolean;
}

/** Mirrors the customers/tickets live-only default scope. */
categorySchema.pre(
  ['find', 'findOne', 'countDocuments'],
  function excludeArchivedCategories(
    this: Query<unknown, KbCategoryDocument>,
    next: CallbackWithoutResultAndOptionalError,
  ): void {
    const options = this.getOptions() as unknown as KbCategoryQueryOptions;
    if (options.withArchive !== true && this.getFilter().archivedAt === undefined) {
      this.where({ archivedAt: null });
    }
    next();
  },
);

/** Live-only scope bypass, same convention as tickets' WITH_ARCHIVE. */
export const KB_CATEGORY_WITH_ARCHIVE = { withArchive: true } as const;

categorySchema.index(
  { workspaceId: 1, slug: 1 },
  { unique: true, name: 'uniq_kb_category_slug_per_workspace' },
);
categorySchema.index(
  { workspaceId: 1, parentId: 1, displayOrder: 1, name: 1 },
  { name: 'idx_kb_categories_tree' },
);

// ── Article ─────────────────────────────────────────────────────────────────

const tagSanitizer = (tags: string[]): string[] =>
  [...new Set(tags.map((t) => t.trim()).filter(Boolean))];

const articleSchema = new Schema<KbArticleDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'KnowledgeBaseCategory',
      default: null,
    },
    title: {
      type: String,
      required: [true, 'Article title is required'],
      trim: true,
      minlength: 1,
      maxlength: KB_TITLE_MAX,
    },
    /** Derived from the title unless the client supplies one (see service). */
    slug: {
      type: String,
      required: [true, 'Article slug is required'],
      lowercase: true,
      trim: true,
      maxlength: KB_SLUG_MAX,
      match: [SLUG_PATTERN, 'Article slug must be lowercase letters, digits and single hyphens'],
    },
    summary: {
      // Optional: default '' does NOT satisfy Mongoose `required` (empty
      // string counts as missing), so summary's optional-ness is expressed
      // without `required` — the service never sums an empty snapshot.
      type: String,
      default: '',
      maxlength: KB_SUMMARY_MAX,
      trim: true,
    },
    /**
     * MARKDOWN/plain-text source stored verbatim (whitespace preserved for
     * code blocks; see kb.types.ts for the safe-rendering contract).
     */
    body: {
      type: String,
      required: [true, 'Article body is required'],
      minlength: 1,
      maxlength: KB_BODY_MAX,
    },
    tags: {
      type: [String],
      default: [],
      set: tagSanitizer,
      validate: {
        validator: (tags: string[]): boolean =>
          tags.length <= MAX_KB_TAGS && tags.every((t) => t.length <= KB_TAG_MAX_LENGTH),
        message: `An article can have at most ${MAX_KB_TAGS} tags of ${KB_TAG_MAX_LENGTH} characters`,
      },
    },
    status: {
      type: String,
      enum: KB_ARTICLE_STATUSES,
      default: 'DRAFT',
      required: true,
    },
    currentRevisionNumber: {
      type: Number,
      required: true,
      min: 0, // 0 = transient "created before its first snapshot persisted".
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    createdById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Author reference is required'],
    },
    lastEditedById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Editor reference is required'],
    },
  },
  { timestamps: true },
);

articleSchema.index(
  { workspaceId: 1, slug: 1 },
  { unique: true, name: 'uniq_kb_article_slug_per_workspace' },
);
articleSchema.index(
  { workspaceId: 1, categoryId: 1, status: 1, updatedAt: -1 },
  { name: 'idx_kb_articles_by_category' },
);
articleSchema.index(
  { workspaceId: 1, status: 1, publishedAt: -1 },
  { name: 'idx_kb_articles_published' },
);
articleSchema.index(
  { workspaceId: 1, status: 1, title: 1 },
  { name: 'idx_kb_articles_by_title' },
);
articleSchema.index(
  { workspaceId: 1, tags: 1 },
  { name: 'idx_kb_articles_by_tag' },
);
articleSchema.index(
  { workspaceId: 1, createdById: 1, updatedAt: -1 },
  { name: 'idx_kb_articles_by_author' },
);
articleSchema.index({ workspaceId: 1, createdAt: -1 }, { name: 'idx_kb_articles_by_created' });
articleSchema.index({ workspaceId: 1, updatedAt: -1 }, { name: 'idx_kb_articles_by_updated' });

export function isKbArticleStatus(value: string): value is KbArticleStatus {
  return (KB_ARTICLE_STATUSES as readonly string[]).includes(value);
}

// ── Revision (append-only, model-enforced immutability) ─────────────────────

const revisionSchema = new Schema<KbRevisionDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: [true, 'Workspace reference is required'],
    },
    articleId: {
      type: Schema.Types.ObjectId,
      ref: 'KnowledgeBaseArticle',
      required: [true, 'Article reference is required'],
    },
    revisionNumber: {
      type: Number,
      required: [true, 'Revision number is required'],
      min: [1, 'Revision numbers start at 1'],
      // Allocated server-side via an atomic `$inc` on the article; immutable.
      immutable: true,
    },
    title: {
      type: String,
      required: [true, 'Revision title is required'],
      trim: true,
      minlength: 1,
      maxlength: KB_TITLE_MAX,
    },
    summary: {
      // Optional: default '' does NOT satisfy Mongoose `required` (empty
      // string counts as missing), so summary's optional-ness is expressed
      // without `required` — the service never sums an empty snapshot.
      type: String,
      default: '',
      maxlength: KB_SUMMARY_MAX,
      trim: true,
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'KnowledgeBaseCategory',
      default: null,
    },
    tags: {
      type: [String],
      default: [],
      set: tagSanitizer,
      validate: {
        validator: (tags: string[]): boolean =>
          tags.length <= MAX_KB_TAGS && tags.every((t) => t.length <= KB_TAG_MAX_LENGTH),
        message: `An article can have at most ${MAX_KB_TAGS} tags of ${KB_TAG_MAX_LENGTH} characters`,
      },
    },
    body: {
      type: String,
      required: [true, 'Revision body is required'],
      minlength: 1,
      maxlength: KB_BODY_MAX,
    },
    editorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Editor reference is required'],
    },
    changeSummary: {
      type: String,
      default: null,
      maxlength: KB_CHANGE_SUMMARY_MAX,
      trim: true,
    },
    restoredFromRevisionNumber: {
      type: Number,
      default: null,
      min: 1,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

revisionSchema.index(
  { workspaceId: 1, articleId: 1, revisionNumber: 1 },
  { unique: true, name: 'uniq_kb_revision_number_per_article' },
);

// Immutability guards (mirrors audit-log.model.ts): history is append-only.
function rejectRevisionMutation(): void {
  throw new AppError('Knowledge-base revisions are append-only and cannot be modified or deleted', {
    statusCode: 500,
    code: 'KB_REVISION_IMMUTABLE',
    isOperational: false,
  });
}

revisionSchema.pre(
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
  rejectRevisionMutation,
);
revisionSchema.pre('deleteOne', { document: true, query: false }, rejectRevisionMutation);
revisionSchema.pre('save', function rejectRevisionEdits(): void {
  if (this.isNew) return;
  if (this.modifiedPaths({ includeChildren: true }).length > 0) {
    rejectRevisionMutation();
  }
});

interface RevisionBulkWriteCapable {
  bulkWrite: Model<KbRevisionDocument>['bulkWrite'];
}

/**
 * Same belt-and-braces as AuditLog: `save()`/`bulkWrite` hook gaps are closed
 * by a non-enumerable override so bulk writes cannot mutate history.
 */
function installRevisionBulkWriteGuard(target: RevisionBulkWriteCapable): void {
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
      if (mutating) rejectRevisionMutation();
      return original(operations as Parameters<typeof original>[0], ...(rest as []));
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

const KbRevisionModelBase = model<KbRevisionDocument>(
  'KnowledgeBaseRevision',
  revisionSchema,
  'kb_article_revisions',
);

installRevisionBulkWriteGuard(KbRevisionModelBase);

export const KbRevisionModel: Model<KbRevisionDocument> = KbRevisionModelBase;

export const KbCategoryModel = model<KbCategoryDocument>(
  'KnowledgeBaseCategory',
  categorySchema,
  'kb_categories',
);

export const KbArticleModel = model<KbArticleDocument>(
  'KnowledgeBaseArticle',
  articleSchema,
  'kb_articles',
);

export { MAX_KB_CATEGORY_DEPTH };
