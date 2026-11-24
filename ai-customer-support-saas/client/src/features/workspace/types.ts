/** Workspace contracts shared with the server's workspaces module. */

export const WORKSPACE_ROLES = ['owner', 'admin', 'agent', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export interface WorkspaceSettings {
  timezone: string;
  locale: string;
}

/** Client-safe workspace (see server workspace.dto.ts). */
export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  status: 'active' | 'archived';
  settings: WorkspaceSettings;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembershipDto {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: 'active' | 'invited' | 'suspended';
  joinedAt: string;
}

/** One row of `GET /workspaces`: the workspace plus the caller's membership. */
export interface WorkspaceListItem {
  workspace: WorkspaceDto;
  membership: WorkspaceMembershipDto;
}

export interface WorkspaceListPayload {
  items: readonly WorkspaceListItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface WorkspaceDetailPayload {
  workspace: WorkspaceDto;
  membership: WorkspaceMembershipDto;
}

/** Human-readable role labels used by the shell (never for authorization). */
export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  viewer: 'Viewer',
};
