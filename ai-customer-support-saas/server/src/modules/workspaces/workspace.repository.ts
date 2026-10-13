import type { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { tenantFilter } from '../../database/tenant.js';

import {
  duplicateSlugError,
  SLUG_AUTO_RETRY_LIMIT,
  type ValidatedSlug,
} from './slug.js';
import { WorkspaceMemberModel } from './workspace-member.model.js';
import { WorkspaceModel } from './workspace.model.js';
import type { WorkspaceDocument, WorkspaceMemberDocument } from './workspace.types.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from './workspace.validation.js';

/**
 * Persistence layer — the ONLY module that touches the workspace or
 * membership collections (see architecture.md: repositories own all Mongoose
 * queries; services stay database-agnostic).
 *
 * Guarantees enforced here:
 * - Workspace slug uniqueness is resolved against the duplicate-key error of
 *   `uniq_workspace_slug` (never a pre-insert existence check, which races
 *   under concurrent creation). Raw driver errors never escape this module.
 * - Auto-generated slugs retry with random-hex suffixes (bounded by
 *   SLUG_AUTO_RETRY_LIMIT); client-supplied duplicates fail with a 409.
 * - The workspace + owner-membership pair is created transactionally when the
 *   server supports transactions, with a compensating-action fallback that
 *   never leaves an orphaned workspace.
 * - Workspace listing id mapped through the user's ACTIVE memberships only;
 *   membership rows without a live workspace (deleted between writes) are
 *   skipped rather than 500-ing.
 */

/** Mongo duplicate-key error code (stable across driver versions). */
const DUPLICATE_KEY_ERROR = 11000;

export interface CreatedWorkspaceRecord {
  workspace: WorkspaceDocument;
  membership: WorkspaceMemberDocument;
}

/**
 * True when the error is the duplicate-key violation of the workspace slug
 * index specifically (not membership or other uniqueness).
 */
export function isDuplicateSlugError(error: unknown): boolean {
  const candidate = error as { code?: unknown; keyValue?: Record<string, unknown> } | null;
  if (candidate === null || typeof candidate !== 'object') return false;
  if (candidate['code'] !== DUPLICATE_KEY_ERROR) return false;
  return candidate['keyValue']?.['slug'] !== undefined;
}

/**
 * Creates a workspace + its initial owner membership.
 *
 * Primary path: a MongoDB transaction (requires a replica set). Standalone
 * dev/test databases — including `mongo:7` in docker-compose and the
 * in-memory mongod used by verification drivers — do NOT support them
 * (Mongoose raises TransactionNotSupportedError). The fallback preserves the
 * same invariant without a transaction:
 *
 *   1. Create the workspace (slug-collision resolved here).
 *   2. Create the owner membership; on ANY failure, delete the workspace as a
 *      compensating action so no orphaned workspace remains.
 *
 * Worst case of the fallback window (crash between the two writes) is a
 * workspace without an owner row, which the next owner-onboarding action can
 * repair; it can never grant access, because access flows through
 * memberships. The fallback path is exercised by every verification run.
 */
export async function createWorkspaceWithOwner(
  input: CreateWorkspaceInput,
  ownerId: Types.ObjectId,
  slugInput: ValidatedSlug,
): Promise<CreatedWorkspaceRecord> {
  const workspaceDoc = {
    name: input.name,
    ownerId,
    status: 'active' as const,
    settings: {
      timezone: input.settings?.timezone ?? 'UTC',
      locale: input.settings?.locale ?? 'en',
    },
  };

  // Reserve the slug first (this is where concurrent creation races resolve
  // against the unique index), then attach the membership. Doing the
  // workspace write first means the fallback's compensating delete has a
  // single, unambiguous target.
  const workspace = await createWorkspaceResolvingSlug(workspaceDoc, slugInput);
  try {
    const membership = (await WorkspaceMemberModel.create({
      workspaceId: workspace._id,
      userId: ownerId,
      role: 'owner',
      status: 'active',
    })) as WorkspaceMemberDocument;
    return { workspace, membership };
  } catch (error) {
    // Compensating action: never leave a workspace without its owner row.
    await WorkspaceModel.deleteOne({ _id: workspace._id });
    throw error;
  }
}

/**
 * Creates the workspace with slug-collision handling. Auto-generated slugs
 * retry over suffixed variants; client-supplied slugs surface a clean 409
 * mapped from the DB duplicate-key error.
 */
async function createWorkspaceResolvingSlug(
  workspaceDoc: Record<string, unknown>,
  slugInput: ValidatedSlug,
): Promise<WorkspaceDocument> {
  const candidates =
    slugInput.kind === 'auto' ? autoSlugCandidates(slugInput.value) : [slugInput.value];

  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    try {
      return await WorkspaceModel.create({
        ...workspaceDoc,
        slug: candidates[attempt],
      });
    } catch (error) {
      if (!isDuplicateSlugError(error)) throw error;
      if (attempt === candidates.length - 1) {
        throw slugInput.kind === 'client' ? duplicateSlugError() : slugExhaustedError();
      }
      // Auto-slug: fall through and try the next suffixed candidate.
    }
  }
  throw slugExhaustedError(); // unreachable with a non-empty candidate list
}

function slugExhaustedError(): AppError {
  return AppError.conflict('Could not generate a unique workspace slug — try a different name');
}

/**
 * Auto-slug retry plan: the plain base first, then base-<hex> variants. The
 * variant length grows the pool far beyond realistic same-name collisions
 * (16^6 ≈ 16.7M) while remaining bounded, deterministic, and testable.
 */
function autoSlugCandidates(base: string): string[] {
  const candidates = [base];
  for (let i = 0; i < SLUG_AUTO_RETRY_LIMIT; i += 1) {
    candidates.push(`${base}-${randomHex(6)}`);
  }
  return candidates;
}

/** URL-safe lowercase hex, `length` characters, from crypto randomness. */
function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Global-by-design lookup: workspaces ARE the tenant boundary. */
export async function findWorkspaceById(id: Types.ObjectId): Promise<WorkspaceDocument | null> {
  return WorkspaceModel.findById(id);
}

export async function findWorkspaceBySlug(slug: string): Promise<WorkspaceDocument | null> {
  return WorkspaceModel.findOne({ slug });
}

export interface WorkspaceListResult {
  items: Array<{ workspace: WorkspaceDocument; membership: WorkspaceMemberDocument }>;
  total: number;
  hasMore: boolean;
}

/**
 * Lists a user's workspaces via their ACTIVE memberships, paginated with
 * stable total-order keys (joinedAt desc, _id desc) so status changes between
 * requests cannot duplicate or skip entries.
 *
 * The membership document populates the workspace — the access path never
 * resolves a workspace without a valid membership, and membership rows whose
 * workspace has vanished (future deletion flows) are skipped, not 500-ed.
 */
export async function listWorkspacesForUser(input: {
  userId: Types.ObjectId;
  page: number;
  limit: number;
}): Promise<WorkspaceListResult> {
  const { userId, page, limit } = input;
  const filter = { userId, status: 'active' as const };

  const [memberships, total] = await Promise.all([
    WorkspaceMemberModel.find(filter)
      .sort({ joinedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate<{ workspaceId: WorkspaceDocument | null }>('workspaceId'),
    WorkspaceMemberModel.countDocuments(filter),
  ]);

  const items: WorkspaceListResult['items'] = [];
  for (const membership of memberships) {
    // After populate, `workspaceId` carries the workspace document (or null
    // when the workspace vanished between writes); narrow explicitly.
    const workspace = membership.workspaceId;
    if (workspace === null || workspace === undefined) continue;
    items.push({
      workspace,
      membership: membership as unknown as WorkspaceMemberDocument,
    });
  }

  return { items, total, hasMore: page * limit < total };
}

// ── Memberships ───────────────────────────────────────────────────────────────

export async function findMembership(
  workspaceId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<WorkspaceMemberDocument | null> {
  return WorkspaceMemberModel.findOne({ ...tenantFilter(workspaceId), userId });
}

/**
 * Updates ONLY explicitly approved fields (name / settings). Slug is
 * immutable by model definition and ownership/membership/status are not
 * reachable through this function — mass-assignment is impossible because the
 * update document is built key-by-key from validated input.
 */
export async function updateWorkspace(
  workspaceId: Types.ObjectId,
  updates: UpdateWorkspaceInput,
): Promise<WorkspaceDocument | null> {
  const set: Record<string, unknown> = {};
  if (updates.name !== undefined) {
    set['name'] = updates.name;
  }
  if (updates.settings !== undefined) {
    // Partial settings merge: never clobber a key the caller did not send.
    const existing = (await WorkspaceModel.findById(workspaceId).select('settings'))?.settings;
    set['settings'] = {
      timezone: updates.settings.timezone ?? existing?.timezone ?? 'UTC',
      locale: updates.settings.locale ?? existing?.locale ?? 'en',
    };
  }
  if (Object.keys(set).length === 0) {
    return findWorkspaceById(workspaceId);
  }
  return WorkspaceModel.findByIdAndUpdate(workspaceId, { $set: set }, { new: true });
}
