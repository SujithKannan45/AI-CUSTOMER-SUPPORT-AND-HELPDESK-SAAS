import { useEffect, useRef, useState } from 'react';
import { analyticsService } from '@/features/analytics/analytics.service';

export type ConversationTotalStatus = 'unavailable' | 'loading' | 'ready' | 'error';

export interface ConversationTotalState {
  readonly status: ConversationTotalStatus;
  /** Workspace-wide conversation total, or null while unknown. */
  readonly total: number | null;
}

/**
 * The workspace's real conversation total.
 *
 * Why this is not simply the inbox list's `total`: the only conversation
 * listing endpoint is ticket-scoped (`GET …/tickets/:ticketId/conversations`),
 * so the inbox index — which uses the ticket list — paginates TICKETS. A ticket
 * has at most one conversation and may have none until one is started, so the
 * ticket count is an upper bound, never a conversation count.
 *
 * The one existing read that returns an accurate total across the workspace is
 * the analytics overview (`GET …/analytics/overview` →
 * `conversations.total`, computed over live tickets and not limited to the
 * requested window). It requires `analytics.view`, which the RBAC registry
 * grants to owner/admin only, so `enabled` is passed by the caller from the UI
 * permission mirror. When it is false — or the request fails — the hook reports
 * `unavailable`/`error` and the page says so instead of showing a number that
 * is not a conversation count. No number is ever estimated client-side.
 */
export function useConversationTotal({
  workspaceId,
  enabled,
  refreshToken,
}: {
  readonly workspaceId: string | null;
  readonly enabled: boolean;
  /** Bumped by the page after an activity that can create a conversation. */
  readonly refreshToken: number;
}): ConversationTotalState {
  const [state, setState] = useState<ConversationTotalState>({
    status: 'unavailable',
    total: null,
  });
  const requestSeq = useRef(0);

  useEffect(() => {
    if (workspaceId === null || !enabled) {
      requestSeq.current += 1;
      setState({ status: 'unavailable', total: null });
      return;
    }

    const seq = ++requestSeq.current;
    const controller = new AbortController();

    setState({ status: 'loading', total: null });

    void (async () => {
      try {
        // The endpoint requires a window even though `conversations.total` is
        // the workspace-wide figure; the range only bounds `createdInPeriod`.
        const payload = await analyticsService.getOverview(
          workspaceId,
          { range: '30d' },
          controller.signal,
        );
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        setState({ status: 'ready', total: payload.conversations.total });
      } catch {
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        // 403 and transport failures both end as "not shown" — the page must
        // never substitute the ticket count for a conversation count.
        setState({ status: 'error', total: null });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [workspaceId, enabled, refreshToken]);

  return state;
}
