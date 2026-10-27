/**
 * Centralized permission registry — the ONLY place in the codebase that maps
 * roles to permissions. Controllers, services and middleware never compare
 * role names against resource logic; they ask this registry.
 *
 * Why a registry instead of scattered `role === 'admin'` checks:
 * - Grants are reviewable in one file (least-privilege audit trail).
 * - New modules append permissions here and immediately inherit consistent
 *   role semantics — no authorization logic to duplicate.
 * - The Zod-validated membership role guarantees validity upstream, so the
 *   registry only ever sees defined `WorkspaceRole` values.
 *
 * Conventions:
 * - Permission ids are `<domain>.<verb>` lowercase dotted identifiers (same
 *   pattern as audit actions).
 * - Every permission grants BY EXPLICIT ENTRY. A role missing a permission in
 *   `ROLE_PERMISSIONS` is denied it — absence is denial, so new permissions
 *   default to least privilege for every existing role.
 */

/**
 * Every permission ever granted in the platform. New modules APPEND entries
 * here (a tuple edit) — existing roles stay denied until the registry gains
 * the grant, which is the safe default.
 */
export const WORKSPACE_PERMISSIONS = {
  /** GET workspace details (Prompt 5 endpoints). */
  viewWorkspace: 'workspace.view',
  /** PATCH workspace name/settings (Prompt 5 endpoints). */
  updateWorkspaceSettings: 'workspace.settings.update',
  /** Invite/remove members and change membership roles (future endpoints; the service-level policy in rbac-policy.ts further restricts owners-only actions). */
  manageMembership: 'workspace.membership.manage',
  /** List workspace members (future member-directory endpoints). */
  listMembers: 'workspace.members.list',
  /** Read customer records (customers module, later phase). */
  viewCustomers: 'customer.view',
  /** Create customer records. */
  createCustomer: 'customer.create',
  /** Edit customer records. */
  updateCustomer: 'customer.update',
  /** Read tickets. */
  viewTickets: 'ticket.view',
  /** Open tickets on behalf of customers. */
  createTicket: 'ticket.create',
  /** Edit tickets — agents remain capped by the assignment rule (resource-access.ts). */
  updateTicket: 'ticket.update',
  /** Re-assign tickets to other members. */
  assignTicket: 'ticket.assign',
  /** Read conversations. */
  viewConversations: 'conversation.view',
  /** Send replies in conversations. */
  replyToConversations: 'conversation.reply',
  /** Read knowledge-base content: articles, categories and revision history. */
  viewKnowledgeBase: 'kb.view',
  /** Create/edit/publish/archive knowledge-base articles and categories, and restore revisions. */
  manageKnowledgeBase: 'kb.manage',
  /** Read document/file metadata and extracted text (documents module, Prompt 12). */
  viewDocuments: 'document.view',
  /** Upload/download documents, re-run text extraction, delete documents. */
  manageDocuments: 'document.manage',
  /** Read RAG indexing status and the chunk inventory (Prompt 13, AI pipeline internals). */
  viewRag: 'rag.view',
  /** Trigger indexing/reindexing and purge indexed chunks (Prompt 13). */
  indexRag: 'rag.index',
  /** Viewing workspace analytics dashboards. */
  viewAnalytics: 'analytics.view',
  /** Workspace-level security settings (security keys, workspace-wide policies). */
  manageWorkspaceSecurity: 'workspace.security.manage',
} as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[keyof typeof WORKSPACE_PERMISSIONS];

import type { WorkspaceRole } from '../workspaces/workspace.types.js';

/** Typed shorthand to keep the grant tables readable. */
type P = readonly WorkspacePermission[];

/**
 * Role → permission grants, with the security rationale per role:
 *
 * - `owner` — full tenant control by definition (workspace settings,
 *   membership administration, security, everything). Existing solely to
 *   give workers of 1-person workspaces zero-friction access; the RBAC
 *   policy layer (rbac-policy.ts) still restricts the DANGEROUS mutations:
 *   the single owner membership itself cannot be demoted, self role-changes
 *   are denied, and ownership transfer is a dedicated flow that does not
 *   exist yet.
 * - `admin` — day-to-day operations: workspace settings, membership
 *   administration (excluding owners and owner grants — policy layer),
 *   customers, tickets/assignments, conversations, KB, analytics. Deliberately
 *   denied `workspace.security.manage`: workspace-wide security settings may
 *   only change by owner decision.
 * - `agent` — exactly what desk work needs: read customers, work tickets
 *   (create/update capped to assigned resources by resource-access.ts),
 *   reply in conversations. No membership admin, no analytics, no customer
 *   registry edits, no KB MANAGEMENT (read-only KB: authoring/publishing is a
 *   knowledge-ownership decision, not desk work), no settings — support work
 *   must not imply administration.
 * - `viewer` — strictly read access to explicitly permitted information
 *   (workspace details, member directory, customers, tickets, conversations,
 *   knowledge-base content). Nothing mutating; analytics excluded because
 *   aggregates leak business trends beyond what "view a ticket" means, and
 *   membership listing stays allowed as directory-visibility, not
 *   administration.
 */
const ROLE_PERMISSIONS: { readonly [K in WorkspaceRole]: P } = {
  owner: [
    WORKSPACE_PERMISSIONS.viewWorkspace,
    WORKSPACE_PERMISSIONS.updateWorkspaceSettings,
    WORKSPACE_PERMISSIONS.manageMembership,
    WORKSPACE_PERMISSIONS.listMembers,
    WORKSPACE_PERMISSIONS.viewCustomers,
    WORKSPACE_PERMISSIONS.createCustomer,
    WORKSPACE_PERMISSIONS.updateCustomer,
    WORKSPACE_PERMISSIONS.viewTickets,
    WORKSPACE_PERMISSIONS.createTicket,
    WORKSPACE_PERMISSIONS.updateTicket,
    WORKSPACE_PERMISSIONS.assignTicket,
    WORKSPACE_PERMISSIONS.viewConversations,
    WORKSPACE_PERMISSIONS.replyToConversations,
    WORKSPACE_PERMISSIONS.viewKnowledgeBase,
    WORKSPACE_PERMISSIONS.manageKnowledgeBase,
    WORKSPACE_PERMISSIONS.viewDocuments,
    WORKSPACE_PERMISSIONS.manageDocuments,
    WORKSPACE_PERMISSIONS.viewRag,
    WORKSPACE_PERMISSIONS.indexRag,
    WORKSPACE_PERMISSIONS.viewAnalytics,
    WORKSPACE_PERMISSIONS.manageWorkspaceSecurity,
  ],
  admin: [
    WORKSPACE_PERMISSIONS.viewWorkspace,
    WORKSPACE_PERMISSIONS.updateWorkspaceSettings,
    WORKSPACE_PERMISSIONS.manageMembership,
    WORKSPACE_PERMISSIONS.listMembers,
    WORKSPACE_PERMISSIONS.viewCustomers,
    WORKSPACE_PERMISSIONS.createCustomer,
    WORKSPACE_PERMISSIONS.updateCustomer,
    WORKSPACE_PERMISSIONS.viewTickets,
    WORKSPACE_PERMISSIONS.createTicket,
    WORKSPACE_PERMISSIONS.updateTicket,
    WORKSPACE_PERMISSIONS.assignTicket,
    WORKSPACE_PERMISSIONS.viewConversations,
    WORKSPACE_PERMISSIONS.replyToConversations,
    WORKSPACE_PERMISSIONS.viewKnowledgeBase,
    WORKSPACE_PERMISSIONS.manageKnowledgeBase,
    WORKSPACE_PERMISSIONS.viewDocuments,
    WORKSPACE_PERMISSIONS.manageDocuments,
    WORKSPACE_PERMISSIONS.viewRag,
    WORKSPACE_PERMISSIONS.indexRag,
    WORKSPACE_PERMISSIONS.viewAnalytics,
  ],
  agent: [
    WORKSPACE_PERMISSIONS.viewWorkspace,
    WORKSPACE_PERMISSIONS.listMembers,
    WORKSPACE_PERMISSIONS.viewCustomers,
    WORKSPACE_PERMISSIONS.viewTickets,
    WORKSPACE_PERMISSIONS.createTicket,
    WORKSPACE_PERMISSIONS.updateTicket,
    WORKSPACE_PERMISSIONS.viewConversations,
    WORKSPACE_PERMISSIONS.replyToConversations,
    WORKSPACE_PERMISSIONS.viewKnowledgeBase,
    WORKSPACE_PERMISSIONS.viewDocuments,
    WORKSPACE_PERMISSIONS.manageDocuments,
  ],
  viewer: [
    WORKSPACE_PERMISSIONS.viewWorkspace,
    WORKSPACE_PERMISSIONS.listMembers,
    WORKSPACE_PERMISSIONS.viewCustomers,
    WORKSPACE_PERMISSIONS.viewTickets,
    WORKSPACE_PERMISSIONS.viewConversations,
    WORKSPACE_PERMISSIONS.viewKnowledgeBase,
  ],
};

/** The permission set of one role — order/iteration source for future UIs. */
export function permissionsOfRole(role: WorkspaceRole): readonly WorkspacePermission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * The single authorization decision function: "may this role perform this
 * permission?". Pure, synchronous, framework-free — middleware composes it
 * with the DB-derived context; unit tests exercise it without Express.
 * Unknown permission ids are typed `never` at compile time and return false
 * at runtime, so a renamed permission can never silently grant.
 */
export function roleHasPermission(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}

/**
 * Roles that outrank agents — used by resource-access.ts for the
 * assignment-based cap on agent modifications. `owner`/`admin` bypass the
 * assignment rule because administration includes triage re-assignment.
 */
export function isWorkspacePrivilegedRole(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}
