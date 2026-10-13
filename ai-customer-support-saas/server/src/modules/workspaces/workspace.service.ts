import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';

import { isValidSlug, normalizeSlug, slugifyName, type ValidatedSlug } from './slug.js';
import {
  toWorkspaceDto,
  toWorkspaceMembershipDto,
  type CreatedWorkspacePayload,
  type WorkspaceDetailPayload,
  type WorkspaceDto,
  type WorkspaceListPayload,
  type WorkspaceMembershipDto,
} from './workspace.dto.js';
import {
  createWorkspaceWithOwner,
  findMembership,
  findWorkspaceById,
  listWorkspacesForUser,
  updateWorkspace,
  type CreatedWorkspaceRecord,
  type WorkspaceListResult,
} from './workspace.repository.js';
import type { WorkspaceMemberDocument, WorkspaceMemberStatus, WorkspaceDocument } from './workspace.types.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from './workspace.validation.js';

/**
 * Workspace business flows + reusable membership queries.
 *
 * Rules enforced here (controllers stay thin):
 * - Slug normalization/validation happens BEFORE persistence; the repository
 *   handles concurrency (unique index + duplicate-key translation).
 * - Ownership checks are a single composable function, ready for Prompt 6 to
 *   replace/extend with full RBAC middleware instead of scattering role
 *   literals across handlers.
 * - Access to a workspace ALWAYS goes through an active membership row.
 */

// ── Membership queries (reusable, per Prompt 5 §9) ───────────────────────────

/** The user's membership in one workspace, or null when they have none. */
export async function getMembership(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberDocument | null> {
  if (!isValidObjectId(workspaceId) || !isValidObjectId(userId)) return null;
  return findMembership(new Types.ObjectId(workspaceId), new Types.ObjectId(userId));
}

/** Valid active membership for a user/workspace — throws 404/403 appropriately. */
export async function requireActiveMembership(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberDocument> {
  const membership = await getMembership(workspaceId, userId);
  // 404 (not 403) for wrong-or-nonexistent id membership: does not leak which
  // ids belong to other tenants.
  if (membership === null || membership.status !== 'active') {
    throw AppError.notFound('Workspace not found');
  }
  return membership;
}

/** True when the given user owns the workspace (the exact Prompt 5 gate). */
export function isWorkspaceOwner(
  workspace: Pick<WorkspaceDocument, 'ownerId'>,
  userId: string,
): boolean {
  return workspace.ownerId.toHexString() === userId;
}

/**
 * The user's ACTIVE memberships joined with their workspaces — the workspace
 * switcher payload. Inactive (invited/suspended) memberships are excluded.
 */
export async function listActiveWorkspacesForUser(input: {
  userId: string;
  page: number;
  limit: number;
}): Promise<WorkspaceListResult> {
  return listWorkspacesForUser({
    userId: new Types.ObjectId(input.userId),
    page: input.page,
    limit: input.limit,
  });
}

/** Validates a membership row is usable for access decisions. */
export function isMembershipActive(
  membership: Pick<WorkspaceMemberDocument, 'status'>,
): boolean {
  return membership.status === ('active' satisfies WorkspaceMemberStatus);
}

// ── Workspace flows ──────────────────────────────────────────────────────────

export interface RequestContextMeta {
  readonly ip?: string;
  readonly userAgent?: string;
}

/**
 * Resolves the slug strategy for a create request:
 * client-supplied (normalized + validated) or auto-derived from the name.
 */
export function resolveSlugInput(input: CreateWorkspaceInput): ValidatedSlug {
  if (input.slug !== undefined) {
    const normalized = normalizeSlug(input.slug);
    if (!isValidSlug(normalized)) {
      throw AppError.validation('Request validation failed', {
        slug: ['Invalid slug'],
      });
    }
    return { kind: 'client', value: normalized };
  }
  const derived = slugifyName(input.name);
  // Reachable only for names whose entire content is punctuation/whitespace
  // (createSchema enforces 3+ chars but not slug-safety).
  if (derived === null) {
    throw AppError.validation('Request validation failed', {
      name: ['Workspace name must include letters or digits to derive a URL slug'],
    });
  }
  return { kind: 'auto', value: derived };
}

export async function createWorkspaceFlow(
  input: CreateWorkspaceInput,
  authUserId: string,
  _requestMeta: RequestContextMeta,
): Promise<CreatedWorkspacePayload> {
  const slugInput = resolveSlugInput(input);
  const record: CreatedWorkspaceRecord = await createWorkspaceWithOwner(
    input,
    new Types.ObjectId(authUserId),
    slugInput,
  );

  return {
    workspace: toWorkspaceDto(record.workspace),
    membership: toWorkspaceMembershipDto(record.membership),
  };
}

export interface WorkspaceListOptions {
  readonly userId: string;
  readonly page: number;
  readonly limit: number;
}

export async function listWorkspacesFlow(
  options: WorkspaceListOptions,
): Promise<WorkspaceListPayload> {
  const result = await listActiveWorkspacesForUser(options);
  const items = result.items.map(({ workspace, membership }) => ({
    workspace: toWorkspaceDto(workspace),
    // Memberships from the listing carry a POPULATED `workspaceId`
    // (workspace document), so the DTO mapper must take the id from the
    // membership's own `_id` owner linkage differently — rebuild the
    // workspaceId from the mapped workspace rather than reading the
    // populated field as an ObjectId.
    membership: toWorkspaceMembershipDto({
      _id: membership._id,
      workspaceId: workspace._id, // authoritative linkage, always an ObjectId
      userId: membership.userId,
      role: membership.role,
      status: membership.status,
      joinedAt: membership.joinedAt,
    }),
  }));
  return {
    items,
    page: options.page,
    limit: options.limit,
    total: result.total,
    hasMore: result.hasMore,
  };
}

/**
 * Loads a workspace the caller can view: id must be well-formed, workspace
 * must exist, and the caller must hold an ACTIVE membership.
 *
 * 404 is used for BOTH unknown ids and non-member access — the response does
 * not reveal whether a workspace id exists outside the caller's scope.
 */
export async function getWorkspaceDetailFlow(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceDetailPayload> {
  const membership = await getMembership(workspaceId, userId);
  if (membership === null || !isMembershipActive(membership)) {
    throw AppError.notFound('Workspace not found');
  }
  const workspace = await findWorkspaceById(new Types.ObjectId(workspaceId));
  if (workspace === null) {
    throw AppError.notFound('Workspace not found');
  }
  return {
    workspace: toWorkspaceDto(workspace),
    membership: toWorkspaceMembershipDto(membership),
  };
}

/**
 * Owner-only update path. Access checks mirror detail (404 for
 * unknown/foreign/non-member; 403 when a valid member is not the owner).
 */
export async function updateWorkspaceFlow(
  workspaceId: string,
  userId: string,
  updates: UpdateWorkspaceInput,
): Promise<WorkspaceDto> {
  const workspace = await findWorkspaceById(new Types.ObjectId(workspaceId));
  // Same 404-for-unknown-or-foreign shape as detail (no existence oracle).
  if (workspace === null) {
    throw AppError.notFound('Workspace not found');
  }
  const membership = await getMembership(workspaceId, userId);
  if (membership === null || !isMembershipActive(membership)) {
    throw AppError.notFound('Workspace not found');
  }
  if (!isWorkspaceOwner(workspace, userId)) {
    // Members may know the workspace exists (they can read it), but updates
    // are owner-only until Prompt 6 adds role middleware.
    throw AppError.forbidden('Only the workspace owner can update the workspace');
  }
  const updated = await updateWorkspace(new Types.ObjectId(workspaceId), updates);
  if (updated === null) {
    throw AppError.notFound('Workspace not found');
  }
  return toWorkspaceDto(updated);
}

/** Guard for ObjectId-shaped ids — route-level regex normally catches this first. */
function isValidObjectId(candidate: string): boolean {
  return Types.ObjectId.isValid(candidate);
}

// Re-exported for controllers that build pagination-aware responses.
export type { WorkspaceMembershipDto };
