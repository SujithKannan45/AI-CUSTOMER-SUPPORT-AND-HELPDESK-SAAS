import { useState, type JSX } from 'react';
import { Building2, Lock, Plus, Users } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { PageTransition } from '@/components/common/page-transition';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonTable } from '@/components/ui/skeleton';
import { useDebounce } from '@/hooks/use-debounce';
import { useToast } from '@/hooks/use-toast';
import { roleCan } from '@/features/access/workspace-permissions';
import { CustomerFilters } from '@/features/customers/components/customer-filters';
import { CustomerFormDialog } from '@/features/customers/components/customer-form-dialog';
import { CustomerTable } from '@/features/customers/components/customer-table';
import { customerService } from '@/features/customers/customer.service';
import { useCustomers } from '@/features/customers/use-customers';
import {
  CUSTOMER_PAGE_SIZE,
  type CustomerArchiveState,
  type CustomerDto,
  type CustomerStatus,
} from '@/features/customers/types';
import { describeMutationError } from '@/features/shared/errors';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';

function countLabel(total: number): string {
  return `${total} ${total === 1 ? 'customer' : 'customers'}`;
}

/**
 * Customer directory (Prompt 22).
 *
 * Reads only `GET …/customers` through the shared HTTP client for the active
 * workspace. Search is debounced, every filter maps to a backend parameter, and
 * pagination is server-side. Mutations (create/edit/archive/restore) go through
 * their dedicated endpoints and are re-read from the server afterwards.
 */
export function CustomersPage(): JSX.Element {
  const { workspace, role } = useActiveWorkspace();
  const { toast } = useToast();
  const workspaceId = workspace?.id ?? null;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [status, setStatus] = useState<CustomerStatus | ''>('');
  const [archiveState, setArchiveState] = useState<CustomerArchiveState>('live');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const list = useCustomers({
    workspaceId,
    filters: { search: debouncedSearch, status, archiveState, page, limit: CUSTOMER_PAGE_SIZE },
  });

  const canCreate = roleCan(role, 'customer.create');
  const canUpdate = roleCan(role, 'customer.update');
  const isFiltered = debouncedSearch.length > 0 || status !== '' || archiveState !== 'live';
  const data = list.data;

  function resetFilters(): void {
    setSearch('');
    setStatus('');
    setArchiveState('live');
    setPage(1);
  }

  async function restoreCustomer(customer: CustomerDto): Promise<void> {
    if (workspaceId === null || restoringId !== null) return;

    setRestoringId(customer.id);
    try {
      await customerService.restore(workspaceId, customer.id);
      toast({ title: 'Customer restored', description: customer.name, tone: 'success' });
      list.refresh();
    } catch (error) {
      toast({
        title: 'Could not restore customer',
        description: describeMutationError(error, {
          fallback: 'The customer could not be restored. Please try again.',
        }),
        tone: 'error',
      });
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <PageTransition className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: 'Support' }, { label: 'Customers' }]}
        title="Customers"
        description="People who contacted this workspace. Search, status and archive filters run against the customer API for the current workspace."
        actions={
          canCreate ? (
            <Button
              size="sm"
              onClick={() => {
                setFormOpen(true);
              }}
              leftIcon={<Plus aria-hidden className="h-3.5 w-3.5" />}
            >
              New customer
            </Button>
          ) : undefined
        }
      />

      {workspace === null ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<Building2 aria-hidden className="h-6 w-6" />}
            title="No workspace selected"
            message="Choose a workspace to see its customers."
          />
        </div>
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-border bg-surface px-3 py-3">
            <CustomerFilters
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
              archiveState={archiveState}
              onArchiveStateChange={(value) => {
                setArchiveState(value);
                setPage(1);
              }}
              isFiltered={isFiltered}
              onReset={resetFilters}
              disabled={list.status === 'loading'}
            />
            <p className="text-xs text-muted" aria-live="polite">
              {data !== null ? `${countLabel(data.total)}${isFiltered ? ' matching your filters' : ''}` : 'Loading customers…'}
              {list.status === 'refreshing' ? ' · Refreshing…' : ''}
            </p>
          </div>

          {list.status === 'error' ? (
            list.forbidden ? (
              <div className="rounded-xl border border-border bg-surface">
                <EmptyState
                  icon={<Lock aria-hidden className="h-6 w-6 text-warning" />}
                  title="Customer access required"
                  message="Your role cannot read customer records in this workspace. Ask a workspace administrator for access."
                />
              </div>
            ) : (
              <ErrorState
                title="Customers unavailable"
                message={list.error ?? 'The customer list could not be loaded.'}
                onRetry={list.refresh}
              />
            )
          ) : data === null ? (
            <SkeletonTable rows={6} columns={5} />
          ) : data.items.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface">
              <EmptyState
                icon={<Users aria-hidden className="h-6 w-6" />}
                title={isFiltered ? 'No customers match' : 'No customers yet'}
                message={
                  isFiltered
                    ? 'Try a different search or clear the filters.'
                    : 'Customer records appear here once someone contacts this workspace or you add them.'
                }
                action={
                  isFiltered ? (
                    <Button variant="outline" size="sm" onClick={resetFilters}>
                      Clear filters
                    </Button>
                  ) : canCreate ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        setFormOpen(true);
                      }}
                    >
                      Add your first customer
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <PageTransition
              key={`${workspaceId ?? ''}:${debouncedSearch}:${status}:${archiveState}:${page}`}
              className="space-y-3"
            >
              <CustomerTable
                customers={data.items}
                canUpdate={canUpdate}
                onRestore={(customer) => {
                  void restoreCustomer(customer);
                }}
                restoringId={restoringId}
              />
              <Pagination
                page={data.page}
                pageSize={data.limit}
                total={data.total}
                onPageChange={setPage}
                disabled={list.status === 'refreshing'}
                itemLabel="customers"
              />
            </PageTransition>
          )}
        </>
      )}

      {workspaceId !== null ? (
        <CustomerFormDialog
          open={formOpen}
          mode="create"
          workspaceId={workspaceId}
          customer={null}
          onClose={() => {
            setFormOpen(false);
          }}
          onSaved={() => {
            setPage(1);
            list.refresh();
          }}
        />
      ) : null}
    </PageTransition>
  );
}
