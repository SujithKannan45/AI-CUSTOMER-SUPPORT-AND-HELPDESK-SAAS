import type { Types } from 'mongoose';

import type { WorkspaceRole } from '../workspaces/workspace.types.js';

import {
  isWorkspacePrivilegedRole,
  roleHasPermission,
  type WorkspacePermission,
} from './rbac.permissions.js';

/**
 * Resource-level authorization helpers — reusable, PURE support for the
 * assignment rules that ticket, customer and conversation modules will
 * enforce (later phases). Nothing here touches Express or the database:
 * routes/middleware resolve the actor context (tenant + permission), then
 * services pass already-loaded resource data to these functions.
 *
 * Compose — the permission gate first, then this helper:
 *
 *   requirePermission(WORKSPACE_PERMISSIONS.updateTicket)   // middleware
 *   → evaluateResourceModification(actor, resource)         // service helper
 *
 * So calling `evaluateResourceModification` alone does NOT prove the caller
 * holds `ticket.update` — it encodes the assignment CAP on top of a granted
 * permission.
 *
 * Rules encoded (per the RBAC prompt):
 * - `owner` / `admin` — administrative access includes triage of any ticket.
 * - `agent` — may modify ONLY resources assigned to them, subject to the
 *   documented per-module options; unassigned resources stay admin/owner
 *   territory, keeping "agent" from silently meaning "full member".
 * - `viewer` (and any future role without a modifying permission) — denied.
 */

/** Interface every tenant-owned, potentially assignable resource implements. */
export interface AssessableWorkspaceResource {
  /** Owning tenant; a resource from another workspace is never assessable. */
  readonly workspaceId: string;
  /** Currently assigned member (ObjectId or hex string); null/undefined = unassigned. */
  readonly assigneeId?: Types.ObjectId | string | null;
  /** Member who created the resource, when the module records creation; used by `allowCreator`. */
  readonly createdById?: Types.ObjectId | string | null;
}

/**
 * The caller of a resource decision: membership-derived identity plus the
 * workspace context the middleware validated. `userId`/`role` are read from
 * `req.workspace` / `req.auth` — never from request payloads.
 */
export interface ResourceActorContext {
  readonly userId: string;
  readonly role: WorkspaceRole;
  /** Workspace whose context this request was authorized against. */
  readonly workspaceId: string;
}

export type ResourceAccessDecision =
  | { readonly allowed: true; readonly basis: 'privileged-role' | 'assigned' | 'creator' }
  | { readonly allowed: false; readonly reason: ResourceAccessDenialReason };

export type ResourceAccessDenialReason =
  | 'workspace-mismatch'
  | 'permission-not-held'
  | 'agent-not-assigned';

function toHex(value: Types.ObjectId | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.toHexString();
}

/**
 * Defensive tenant check for resources whose id arrived from the request
 * (route params): the resource MUST belong to the workspace whose context
 * the middleware already validated. Primary enforcement is the repository
 * pattern of always fetching tenant-scoped
 * (`{ ...tenantFilter(workspaceId), _id: id }`), which makes the lookup both
 * the check and the concealment (foreign ids read as not-found). This helper
 * exists for the rare non-query path (e.g. a resource preloaded generically)
 * and fails loudly — a scope violation is a programmer error, never a
 * user-facing condition.
 */
export function assertSameWorkspace(
  contextWorkspaceId: string,
  resource: AssessableWorkspaceResource,
): void {
  if (resource.workspaceId !== contextWorkspaceId) {
    throw new Error(
      `TENANT_SCOPE_VIOLATION: resource workspace ${resource.workspaceId} does not match context workspace ${contextWorkspaceId}`,
    );
  }
}

interface ModificationOptions {
  /**
   * The modifying permission the route has ALREADY enforced at the middleware
   * layer. Re-checked here as defense-in-depth so the helper can never grant
   * to a role the registry denies (e.g. a viewer "assigned to themselves").
   */
  readonly permission: WorkspacePermission;
  /**
   * Whether the agent who OPENED a resource may keep editing it when it was
   * assigned to someone else (the documented "unless explicitly permitted"
   * escape valve, enabled per module). Default FALSE — strictest rule.
   */
  readonly allowCreator?: boolean;
  /**
   * Whether agents may modify UNASSIGNED resources (per-module triage
   * policy, e.g. claim-then-edit flows). Default FALSE — administration
   * territory until someone claims it.
   */
  readonly allowUnassignedAgents?: boolean;
}

/**
 * Assignment-based modification decision for one resource.
 *
 * Evaluation order (first match wins):
 *   tenant mismatch → deny · privileged role (owner/admin) → allow (triage)
 *   · registry denies the permission for this role → deny
 *   · assigned to the actor → allow · unassigned (+ knob) → allow
 *   · actor is the creator (+ knob, incl. assigned-elsewhere) → allow · deny
 */
export function evaluateResourceModification(
  actor: ResourceActorContext,
  resource: AssessableWorkspaceResource,
  options: ModificationOptions,
): ResourceAccessDecision {
  if (resource.workspaceId !== actor.workspaceId) {
    return { allowed: false, reason: 'workspace-mismatch' };
  }
  if (isWorkspacePrivilegedRole(actor.role)) {
    return { allowed: true, basis: 'privileged-role' };
  }
  if (!roleHasPermission(actor.role, options.permission)) {
    // Roles without the modifying permission (viewer et al.) can never be
    // granted through assignment — assignment is a CAP on privileged roles,
    // not an independent grant source.
    return { allowed: false, reason: 'permission-not-held' };
  }
  const creatorId = toHex(resource.createdById);
  const creatorMayAct = options.allowCreator === true && creatorId === actor.userId;
  const assigneeId = toHex(resource.assigneeId);
  if (assigneeId === null) {
    if (options.allowUnassignedAgents === true) {
      return { allowed: true, basis: 'assigned' };
    }
    if (creatorMayAct) {
      return { allowed: true, basis: 'creator' };
    }
    return { allowed: false, reason: 'agent-not-assigned' };
  }
  if (assigneeId === actor.userId) {
    return { allowed: true, basis: 'assigned' };
  }
  if (creatorMayAct) {
    return { allowed: true, basis: 'creator' };
  }
  // Assigned to someone else: the agent cap applies unless the module
  // explicitly permitted creator edits.
  return { allowed: false, reason: 'agent-not-assigned' };
}
