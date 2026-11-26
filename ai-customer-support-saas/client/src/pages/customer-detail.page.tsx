import { useState, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Building2, Lock, UserX } from 'lucide-react';
import { Breadcrumbs } from '@/components/navigation/breadcrumbs';
import { PageTransition } from '@/components/common/page-transition';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { ButtonLink } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { ROUTES } from '@/app/routes/route-paths';
import { useToast } from '@/hooks/use-toast';
import { roleCan } from '@/features/access/workspace-permissions';
import { CustomerFormDialog } from '@/features/customers/components/customer-form-dialog';
import { CustomerProfile } from '@/features/customers/components/customer-profile';
import { CustomerRelatedTickets } from '@/features/customers/components/customer-related-tickets';
import { customerService } from '@/features/customers/customer.service';
import { useCustomerDetail } from '@/features/customers/use-customer-detail';
import { describeMutationError } from '@/features/shared/errors';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';

/**
 * Customer detail (Prompt 22).
 *
 * One tenant-scoped `GET …/customers/:id` read (invalid ids are rejected
 * without a request, unknown/foreign ids resolve to the server's 404), plus the
 * related-ticket list and the two supported mutations: edit and archive.
 */
export function CustomerDetailPage(): JSX.Element {
  const { customerId } = useParams<{ customerId: string }>();
  const { workspace, role } = useActiveWorkspace();
  const { toast } = useToast();
  const navigate = useNavigate();

  const workspaceId = workspace?.id ?? null;
  const detail = useCustomerDetail(workspaceId, customerId);
  const customer = detail.customer;

  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const canUpdate = roleCan(role, 'customer.update');

  async function confirmArchive(): Promise<void> {
    if (workspaceId === null || customer === null || isArchiving) return;

    setIsArchiving(true);
    try {
      await customerService.archive(workspaceId, customer.id);
      toast({
        title: 'Customer archived',
        description: `${customer.name} was moved out of the active customer list.`,
        tone: 'success',
      });
      setArchiveOpen(false);
      void navigate(ROUTES.customers);
    } catch (error) {
      toast({
        title: 'Could not archive customer',
        description: describeMutationError(error, {
          fallback: 'The customer could not be archived. Please try again.',
          notFound: 'This customer no longer exists in the current workspace.',
        }),
        tone: 'error',
      });
    } finally {
      setIsArchiving(false);
    }
  }

  const breadcrumbLabel = customer?.name ?? 'Customer';

  return (
    <PageTransition className="space-y-4">
      <Breadcrumbs
        items={[
          { label: 'Customers', to: ROUTES.customers },
          { label: breadcrumbLabel },
        ]}
      />

      {workspace === null ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<Building2 aria-hidden className="h-6 w-6" />}
            title="No workspace selected"
            message="Choose a workspace to open its customers."
          />
        </div>
      ) : detail.status === 'invalid' ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<UserX aria-hidden className="h-6 w-6" />}
            title="Invalid customer link"
            message="This address does not contain a valid customer identifier."
            action={
              <ButtonLink to={ROUTES.customers} variant="outline" size="sm">
                Back to customers
              </ButtonLink>
            }
          />
        </div>
      ) : detail.status === 'not-found' ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<UserX aria-hidden className="h-6 w-6" />}
            title="Customer not found"
            message="This customer does not exist in the current workspace, or was archived. Archived customers are listed with the archive filter on the customers page."
            action={
              <ButtonLink to={ROUTES.customers} variant="outline" size="sm">
                Back to customers
              </ButtonLink>
            }
          />
        </div>
      ) : detail.status === 'error' ? (
        detail.forbidden ? (
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState
              icon={<Lock aria-hidden className="h-6 w-6 text-warning" />}
              title="Customer access required"
              message="Your role cannot read customer records in this workspace. Ask a workspace administrator for access."
            />
          </div>
        ) : (
          <ErrorState
            title="Customer unavailable"
            message={detail.error ?? 'The customer record could not be loaded.'}
            onRetry={detail.refresh}
          />
        )
      ) : customer === null ? (
        <div role="status" aria-live="polite" className="space-y-4">
          <span className="sr-only">Loading customer…</span>
          <div className="rounded-xl border border-border bg-surface p-5">
            <div className="flex items-start gap-3">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-3.5 w-64" />
              </div>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface p-5">
              <SkeletonText lines={4} />
            </div>
            <div className="rounded-xl border border-border bg-surface p-5">
              <SkeletonText lines={4} />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <CustomerProfile
            customer={customer}
            canUpdate={canUpdate}
            onEdit={() => {
              setEditOpen(true);
            }}
            onArchive={() => {
              setArchiveOpen(true);
            }}
            isArchiving={isArchiving}
          />

          <CustomerRelatedTickets workspaceId={workspace.id} customerId={customer.id} />

          {canUpdate ? (
            <CustomerFormDialog
              open={editOpen}
              mode="edit"
              workspaceId={workspace.id}
              customer={customer}
              onClose={() => {
                setEditOpen(false);
              }}
              onSaved={() => {
                detail.refresh();
              }}
            />
          ) : null}

          <ConfirmDialog
            open={archiveOpen}
            title={`Archive ${customer.name}?`}
            confirmLabel="Archive customer"
            isConfirming={isArchiving}
            onCancel={() => {
              setArchiveOpen(false);
            }}
            onConfirm={() => {
              void confirmArchive();
            }}
          >
            <p className="text-sm leading-6 text-muted">
              The customer is removed from the active customer list. The record is kept and can be
              restored from the customers page with the archive filter, so nothing is permanently
              deleted.
            </p>
          </ConfirmDialog>
        </div>
      )}
    </PageTransition>
  );
}
