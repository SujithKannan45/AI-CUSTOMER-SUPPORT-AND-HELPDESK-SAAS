import { httpClient } from '@/services/http-client.service';

/**
 * Notification endpoints (`server/src/modules/notifications`). Only the
 * unread count is used by the Prompt 19 shell; the inbox itself belongs to a
 * later prompt.
 */
export const notificationService = {
  getUnreadCount(workspaceId: string, options?: { signal?: AbortSignal }): Promise<{ unreadCount: number }> {
    return httpClient.get<{ unreadCount: number }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/notifications/unread-count`,
      options,
    );
  },
};
