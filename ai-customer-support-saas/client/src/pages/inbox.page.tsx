import { useEffect, useState, type JSX } from 'react';
import { Building2, Inbox as InboxIcon, Info, Lock, RotateCw } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { PageTransition } from '@/components/common/page-transition';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonTable } from '@/components/ui/skeleton';
import { useDebounce } from '@/hooks/use-debounce';
import { canReplyToConversation, roleCan } from '@/features/access/workspace-permissions';
import { useSessionStore } from '@/features/auth/auth.store';
import { ConversationList } from '@/features/inbox/components/conversation-list';
import { ConversationPanel } from '@/features/inbox/components/conversation-panel';
import { InboxFilters } from '@/features/inbox/components/inbox-filters';
import { inboxRealtime } from '@/features/inbox/realtime-status';
import { INBOX_THREAD_PAGE_SIZE } from '@/features/inbox/types';
import {
  useConversationTotal,
  type ConversationTotalState,
} from '@/features/inbox/use-conversation-total';
import { useTickets } from '@/features/tickets/use-tickets';
import type { TicketDto, TicketPriority, TicketStatus } from '@/features/tickets/types';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';
import { cn } from '@/utils/cn.util';

/** The list paginates TICKETS, so its total is labelled as tickets. */
function ticketCountLabel(total: number, isFiltered: boolean): string {
  return `${total} ${total === 1 ? 'ticket' : 'tickets'}${isFiltered ? ' matching your filters' : ''}`;
}

/**
 * The conversation total is a separate, workspace-wide figure. It is shown only
 * when the API returned it; otherwise the page states why it is missing rather
 * than presenting the ticket count as a conversation count.
 */
function conversationTotalLabel(state: ConversationTotalState): string {
  if (state.status === 'ready' && state.total !== null) {
    const total = state.total;
    return `${total} ${total === 1 ? 'conversation' : 'conversations'} in this workspace`;
  }
  if (state.status === 'loading') return 'Counting conversations…';
  if (state.status === 'error') return 'Conversation total unavailable right now';
  if (state.status === 'unavailable') return 'Conversation total requires workspace analytics access';
  return '';
}

/**
 * Support inbox (Prompt 23).
 *
 * The index is the workspace's ticket list: the backend gives a ticket exactly
 * ONE primary conversation (unique `{workspaceId, ticketId}` index) and exposes
 * NO workspace-wide conversation listing endpoint, so conversations are read
 * per ticket on selection (`GET …/tickets/:id/conversations` then
 * `…/conversations/:id/messages`). Search, filters, sorting by recent activity
 * and pagination all use the ticket endpoint's own validated parameters.
 *
 * Counts are deliberately two different numbers: the list's `total` counts
 * TICKETS (a ticket may not have a conversation yet), while the workspace's
 * real conversation total comes from the analytics overview, which requires
 * `analytics.view` — see `use-conversation-total.ts`.
 *
 * Real-time is NOT implemented in this release (no Socket.IO server exists —
 * see `features/inbox/realtime-status.ts`): the page says so and offers an
 * explicit refresh instead of polling.
 */
export function InboxPage(): JSX.Element {
  const { workspace, role } = useActiveWorkspace();
  const workspaceId = workspace?.id ?? null;
  const userId = useSessionStore((state) => state.user?.id ?? null);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [priority, setPriority] = useState<TicketPriority | ''>('');
  const [page, setPage] = useState(1);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  // Bumped when a conversation may have been created, so the workspace total
  // is re-read (conversations are created lazily, per ticket).
  const [activityToken, setActivityToken] = useState(0);

  // Workspace switch: drop the selection immediately so no thread from the
  // previous tenant can be rendered while the new list loads.
  useEffect(() => {
    setSelectedTicketId(null);
    setPage(1);
  }, [workspaceId]);

  const list = useTickets({
    workspaceId,
    filters: {
      search: debouncedSearch,
      status,
      priority,
      page,
      limit: INBOX_THREAD_PAGE_SIZE,
      sort: 'updatedAt',
    },
  });

  const conversationTotal = useConversationTotal({
    workspaceId,
    enabled: roleCan(role, 'analytics.view'),
    refreshToken: activityToken,
  });

  const threads = list.data?.items ?? [];
  const selectedTicket: TicketDto | null =
    selectedTicketId === null ? null : (threads.find((ticket) => ticket.id === selectedTicketId) ?? null);

  const isFiltered = debouncedSearch.length > 0 || status !== '' || priority !== '';

  function resetFilters(): void {
    setSearch('');
    setStatus('');
    setPriority('');
    setPage(1);
  }

  const canReply =
    selectedTicket !== null && canReplyToConversation(role, userId, selectedTicket);
  const readOnlyReason =
    selectedTicket === null || canReply
      ? null
      : role === 'agent' || role === 'admin' || role === 'owner'
        ? 'Only the assigned agent, the agent who opened this ticket, or a workspace administrator can reply on this ticket.'
        : 'Your role can read conversations but not send messages.';

  return (
    <PageTransition className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: 'Support' }, { label: 'Inbox' }]}
        title="Inbox"
        description="Conversations of the tickets in this workspace. A ticket has at most one conversation, started on demand; replies and internal notes are recorded server-side and audited."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" dot>
              {inboxRealtime.label}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={list.refresh}
              isLoading={list.status === 'refreshing'}
              leftIcon={<RotateCw aria-hidden className="h-3.5 w-3.5" />}
            >
              Refresh
            </Button>
          </div>
        }
      />

      <p className="flex items-start gap-1.5 text-xs leading-5 text-muted" title={inboxRealtime.missingBackend.join(' · ')}>
        <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{inboxRealtime.detail}</span>
      </p>

      {workspace === null ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<Building2 aria-hidden className="h-6 w-6" />}
            title="No workspace selected"
            message="Choose a workspace to open its inbox."
          />
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          {/* Conversation list panel */}
          <section
            aria-label="Conversations"
            className={cn(
              'flex h-[calc(100dvh-15rem)] min-h-[24rem] flex-col overflow-hidden rounded-xl border border-border bg-surface lg:h-[calc(100dvh-12rem)]',
              selectedTicket !== null ? 'hidden lg:flex' : 'flex',
            )}
          >
            <div className="space-y-2 border-b border-border px-3 py-3">
              <InboxFilters
                search={search}
                onSearchChange={(value) => {
                  setSearch(value);
                  setPage(1);
                }}
                status={status}
                onStatusChange={(value) => {
                  setStatus(value);
                  setPage(1);
                }}
                priority={priority}
                onPriorityChange={(value) => {
                  setPriority(value);
                  setPage(1);
                }}
                isFiltered={isFiltered}
                onReset={resetFilters}
                disabled={list.status === 'loading'}
              />
              <p
                className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted"
                aria-live="polite"
                title="The list counts tickets; the conversation total is computed by the workspace analytics endpoint."
              >
                {list.data !== null ? (
                  <>
                    <span>{ticketCountLabel(list.data.total, isFiltered)}</span>
                    <span aria-hidden>·</span>
                    <span data-testid="conversation-total">
                      {conversationTotalLabel(conversationTotal)}
                    </span>
                  </>
                ) : (
                  <span>Loading conversations…</span>
                )}
                {list.status === 'refreshing' ? <span>· Refreshing…</span> : null}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto">
              {list.status === 'error' ? (
                list.forbidden ? (
                  <EmptyState
                    icon={<Lock aria-hidden className="h-6 w-6 text-warning" />}
                    title="Inbox access required"
                    message="Your role cannot read tickets or conversations in this workspace."
                  />
                ) : (
                  <ErrorState
                    title="Inbox unavailable"
                    message={list.error ?? 'The conversation list could not be loaded.'}
                    onRetry={list.refresh}
                  />
                )
              ) : list.data === null ? (
                <div className="px-3 py-3">
                  <SkeletonTable rows={5} columns={2} />
                </div>
              ) : list.data.items.length === 0 ? (
                <EmptyState
                  icon={<InboxIcon aria-hidden className="h-6 w-6" />}
                  title={isFiltered ? 'No conversations match' : 'No conversations yet'}
                  message={
                    isFiltered
                      ? 'Try a different search, status or priority, or clear the filters.'
                      : 'Every ticket in this workspace is listed here — open one to read or start its conversation.'
                  }
                  action={
                    isFiltered ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ConversationList
                  threads={list.data.items}
                  selectedId={selectedTicketId}
                  onSelect={setSelectedTicketId}
                />
              )}
            </div>

            {list.data !== null && list.data.items.length > 0 ? (
              <div className="border-t border-border px-3 py-2">
                <Pagination
                  page={list.data.page}
                  pageSize={list.data.limit}
                  total={list.data.total}
                  onPageChange={(next) => {
                    setPage(next);
                    setSelectedTicketId(null);
                  }}
                  disabled={list.status === 'refreshing'}
                  itemLabel="tickets"
                />
              </div>
            ) : null}
          </section>

          {/* Selected conversation panel */}
          {selectedTicket === null ? (
            <section
              aria-label="Conversation"
              className="hidden h-[calc(100dvh-12rem)] min-h-[24rem] items-center justify-center rounded-xl border border-border bg-surface lg:flex"
            >
              <EmptyState
                icon={<InboxIcon aria-hidden className="h-6 w-6" />}
                title="Select a conversation"
                message="Choose a conversation on the left to read its messages and reply."
              />
            </section>
          ) : (
            <ConversationPanel
              key={`${workspace.id}:${selectedTicket.id}`}
              workspaceId={workspace.id}
              ticket={selectedTicket}
              currentUserId={userId}
              canReply={canReply}
              readOnlyReason={readOnlyReason}
              showBack
              onBack={() => {
                setSelectedTicketId(null);
              }}
              onActivity={() => {
                list.refresh();
                setActivityToken((token) => token + 1);
              }}
            />
          )}
        </div>
      )}
    </PageTransition>
  );
}
