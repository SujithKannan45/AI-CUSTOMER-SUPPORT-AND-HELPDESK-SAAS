import {
  hasAtLeastRole,
  WORKSPACE_ROLES,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '../workspaces/workspace.types.js';

/**
 * Membership role-integrity policy — the server-side rules that make
 * privilege escalation structurally impossible for the membership
 * lifecycle, WITHOUT any HTTP layer (no membership endpoints exist yet by
 * design; future endpoints simply call these evaluators before persisting).
 *
 * All functions are PURE (context in ⇒ decision out) so they are unit-test
 * friendly and framework-agnostic. The DB adds belt-and-braces guarantees:
 *   - unique `{ workspaceId, userId }` membership index (no duplicate rows)
 *   - partial unique `{ workspaceId }` on owner docs (at most ONE owner)
 * which means even a buggy caller cannot create conflicting role state.
 *
 * Core invariants enforced here:
 *  1. Nobody changes their OWN role — self-service promotion is impossible.
 *  2. Only the owner (via a dedicated flow, when it exists) can create or
 *     dissolve an `owner` membership — `evaluateRoleChange` and
 *     `evaluateMembershipCreation` reject role 'owner' as an ordinary value.
 *  3. Owner memberships themselves are immutable through ordinary flows —
 *     an ownership TRANSFER must be an atomic dedicated operation, never a
 *     "demote A + promote B" pair that transiently leaves zero owners.
 *  4. Admins may administer only strictly-low-weight roles: they cannot
 *     touch other admins or the owner, and cannot grant admin — promotion of
 *     admins is an owner-only decision.
 *  5. Removing a member never leaves the workspace without its valid owner.
 */

/** Must be an ACTIVE member to act on others — inactive members decide nothing. */
export function assertActorStatusEligible(status: WorkspaceMemberStatus): void {
  if (status !== 'active') {
    throw new Error(
      `RBAC_POLICY_VIOLATION: only active members may perform membership administration (got status: ${status})`,
    );
  }
}

/** Guard used by membership-creation paths: role must be a defined role at all. */
export function isValidWorkspaceRole(role: string): role is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(role);
}

/** Reference to a membership row used by the evaluators (ids as hex strings). */
export interface MembershipRef {
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly status: WorkspaceMemberStatus;
}

/** The workspace the decision applies to (ownerId as hex string). */
export interface WorkspaceRef {
  readonly ownerId: string;
}

export type RbacDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Role-change decision for actor changing target's role to `newRole`.
 *
 * Denials (each mapped to a §7 requirement):
 * - `invalid-role` — not in the centralized vocabulary (newRole must be a
 *   VALID role; creation of arbitrary role strings is impossible).
 * - `self-role-change` — users cannot modify their own role (incl. owners).
 * - `owner-membership-immutable` — owner rows change only through a
 *   dedicated transfer flow (not implemented as ordinary membership ops).
 * - `cannot-grant-owner` — ordinary ops never mint owners (invariant 2/3).
 * - `insufficient-role-level` — actor must be owner OR admin just to act.
 * - `admin-cannot-manage-elevated` — admins act on agents/viewers only.
 * - `admin-target-role-too-high` — admins can assign agent/viewer only.
 */
export function evaluateRoleChange(input: {
  actor: MembershipRef;
  target: MembershipRef;
  workspace: WorkspaceRef;
  newRole: string;
}): RbacDecision {
  const { actor, target, newRole } = input;

  if (!isValidWorkspaceRole(newRole)) {
    return { allowed: false, reason: 'invalid-role' };
  }
  if (actor.userId === target.userId) {
    return { allowed: false, reason: 'self-role-change' };
  }
  if (target.role === 'owner') {
    return { allowed: false, reason: 'owner-membership-immutable' };
  }
  if (newRole === 'owner') {
    return { allowed: false, reason: 'cannot-grant-owner' };
  }
  if (!hasAtLeastRole(actor.role, 'admin')) {
    return { allowed: false, reason: 'insufficient-role-level' };
  }
  if (actor.role !== 'owner') {
    // Admin actor: work the working tier only.
    if (hasAtLeastRole(target.role, 'admin')) {
      return { allowed: false, reason: 'admin-cannot-manage-elevated' };
    }
    if (hasAtLeastRole(newRole, 'admin')) {
      return { allowed: false, reason: 'admin-target-role-too-high' };
    }
  }
  return { allowed: true };
}

/**
 * Membership-removal decision (for future "remove member" flows). The owner
 * membership can never be the target (invariant 5: a workspace must always
 * keep its valid owner); admins stop at their own tier.
 *
 * Denial reasons follow `evaluateRoleChange`, plus
 * `workspace-owner-cannot-be-removed` when the target IS the workspace
 * owner's membership row.
 */
export function evaluateMembershipRemoval(input: {
  actor: MembershipRef;
  target: MembershipRef;
  workspace: WorkspaceRef;
}): RbacDecision {
  const { actor, target, workspace } = input;

  if (actor.userId === target.userId) {
    return { allowed: false, reason: 'self-role-change' };
  }
  if (target.role === 'owner' || workspace.ownerId === target.userId) {
    return { allowed: false, reason: 'workspace-owner-cannot-be-removed' };
  }
  if (!hasAtLeastRole(actor.role, 'admin')) {
    return { allowed: false, reason: 'insufficient-role-level' };
  }
  if (actor.role !== 'owner' && hasAtLeastRole(target.role, 'admin')) {
    return { allowed: false, reason: 'admin-cannot-manage-elevated' };
  }
  return { allowed: true };
}

/**
 * Membership-CREATION decision (for future invite flows): the assigned role
 * must be valid, must NOT be `owner` (owners are minted only by workspace
 * creation itself — `createWorkspaceWithOwner` — or a future transfer flow),
 * and the creator must be at least admin. `insufficient-role-level` /
 * `invalid-role` / `cannot-grant-owner` mirror the change evaluator.
 */
export function evaluateMembershipCreation(input: {
  actor: MembershipRef;
  newRole: string;
}): RbacDecision {
  const { actor, newRole } = input;

  if (!isValidWorkspaceRole(newRole)) {
    return { allowed: false, reason: 'invalid-role' };
  }
  if (newRole === 'owner') {
    return { allowed: false, reason: 'cannot-grant-owner' };
  }
  if (!hasAtLeastRole(actor.role, 'admin')) {
    return { allowed: false, reason: 'insufficient-role-level' };
  }
  if (actor.role !== 'owner' && hasAtLeastRole(newRole, 'admin')) {
    return { allowed: false, reason: 'admin-target-role-too-high' };
  }
  return { allowed: true };
}

/**
 * Consistency guard used wherever a workspace+membership pair is loaded for
 * authorization: the workspace's `ownerId` must be covered by an owner
 * membership. TRUE when consistent; FALSE surfaces the integrity anomaly the
 * effective-role resolver (middleware) also detects and self-heals at read
 * time. Exported for verification drivers and future repair tooling.
 */
export function isOwnerMembershipConsistent(input: {
  workspace: WorkspaceRef;
  memberships: readonly MembershipRef[];
}): boolean {
  return input.memberships.some(
    (membership) =>
      membership.role === 'owner' &&
      membership.userId === input.workspace.ownerId &&
      membership.status === 'active',
  );
}
