import { useState, type JSX } from 'react';
import { Building2, Lock, RotateCw, Ticket } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { PageTransition } from '@/components/common/page-transition';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonTable } from '@/components/ui/skeleton';
import { useDebounce } from '@/hooks/use-debounce';
import { TicketFilters } from '@/features/tickets/components/ticket-filters';
import { TicketTable } from '@/features/tickets/components/ticket-table';
import { useTickets } from '@/features/tickets/use-tickets';
import {
  TICKET_PAGE_SIZE,
  type TicketPriority,
  type TicketStatus,
} from '@/features/tickets/types';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';

function countLabel(total: number): string {
  return `${total} ${total === 1 ? 'ticket' : 'tickets'}`;
}

/**
 * Ticket list (Prompt 22).
 *
 * One tenant-scoped `GET …/tickets` read per filter/page change. Search, status
 * and priority are the backend's own parameters; pagination is server-side. No
 * ticket-create form is rendered: ticket creation is outside this prompt's
 * scope (see docs/frontend.md).
 */
export function TicketsPage(): JSX.Element {
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id ?? null;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [priority, setPriority] = useState<TicketPriority | ''>('');
  const [page, setPage] = useState(1);

  const list = useTickets({
    workspaceId,
    filters: { search: debouncedSearch, status, priority, page, limit: TICKET_PAGE_SIZE },
  });

  const isFiltered = debouncedSearch.length > 0 || status !== '' || priority !== '';
  const data = list.data;

  function resetFilters(): void {
    setSearch('');
    setStatus('');
    setPriority('');
    setPage(1);
  }

  return (
    <PageTransition className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: 'Support' }, { label: 'Tickets' }]}
        title="Tickets"
        description="Support requests in the current workspace. Open a ticket to see its customer, description and the status and priority actions the server allows."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={list.refresh}
            isLoading={list.status === 'refreshing'}
            leftIcon={<RotateCw aria-hidden className="h-3.5 w-3.5" />}
          >
            Refresh
          </Button>
        }
      />

      {workspace === null ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<Building2 aria-hidden className="h-6 w-6" />}
            title="No workspace selected"
            message="Choose a workspace to see its tickets."
          />
        </div>
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-border bg-surface px-3 py-3">
            <TicketFilters
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
            <p className="text-xs text-muted" aria-live="polite">
              {data !== null ? `${countLabel(data.total)}${isFiltered ? ' matching your filters' : ''}` : 'Loading tickets…'}
              {list.status === 'refreshing' ? ' · Refreshing…' : ''}
            </p>
          </div>

          {list.status === 'error' ? (
            list.forbidden ? (
              <div className="rounded-xl border border-border bg-surface">
                <EmptyState
                  icon={<Lock aria-hidden className="h-6 w-6 text-warning" />}
                  title="Ticket access required"
                  message="Your role cannot read tickets in this workspace. Ask a workspace administrator for access."
                />
              </div>
            ) : (
              <ErrorState
                title="Tickets unavailable"
                message={list.error ?? 'The ticket list could not be loaded.'}
                onRetry={list.refresh}
              />
            )
          ) : data === null ? (
            <SkeletonTable rows={6} columns={6} />
          ) : data.items.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface">
              <EmptyState
                icon={<Ticket aria-hidden className="h-6 w-6" />}
                title={isFiltered ? 'No tickets match' : 'No tickets yet'}
                message={
                  isFiltered
                    ? 'Try a different search, status or priority, or clear the filters.'
                    : 'Tickets opened in this workspace will appear here.'
                }
                action={
                  isFiltered ? (
                    <Button variant="outline" size="sm" onClick={resetFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <PageTransition
              key={`${workspaceId ?? ''}:${debouncedSearch}:${status}:${priority}:${page}`}
              className="space-y-3"
            >
              <TicketTable tickets={data.items} />
              <Pagination
                page={data.page}
                pageSize={data.limit}
                total={data.total}
                onPageChange={setPage}
                disabled={list.status === 'refreshing'}
                itemLabel="tickets"
              />
            </PageTransition>
          )}
        </>
      )}
    </PageTransition>
  );
}
