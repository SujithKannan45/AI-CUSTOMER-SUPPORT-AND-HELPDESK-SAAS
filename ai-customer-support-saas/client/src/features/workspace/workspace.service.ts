import { httpClient } from '@/services/http-client.service';
import type { WorkspaceDetailPayload, WorkspaceListPayload } from './types';

/**
 * Workspace endpoints (backend: `server/src/modules/workspaces`).
 *
 * The tenant id is part of the URL, but it is a *routing* input only: the
 * server resolves membership from the database on every request
 * (`requireWorkspaceContext`), so a tampered id returns 404 and grants nothing.
 */
export const workspaceService = {
  list(params: { page?: number; limit?: number } = {}): Promise<WorkspaceListPayload> {
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const query = search.toString();
    return httpClient.get<WorkspaceListPayload>(`/api/v1/workspaces${query.length > 0 ? `?${query}` : ''}`);
  },

  get(workspaceId: string): Promise<WorkspaceDetailPayload> {
    return httpClient.get<WorkspaceDetailPayload>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  },
};
