import { useState, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import { Building2, Lock, Ticket as TicketIcon, UserX } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/navigation/breadcrumbs';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageTransition } from '@/components/common/page-transition';
import { ROUTES, customerPath } from '@/app/routes/route-paths';
import { useToast } from '@/hooks/use-toast';
import { useSessionStore } from '@/features/auth/auth.store';
import { canModifyTicket } from '@/features/access/workspace-permissions';
import { useCustomerDetail } from '@/features/customers/use-customer-detail';
import { CUSTOMER_STATUS_LABELS, CUSTOMER_STATUS_TONES } from '@/features/customers/labels';
import { describeMutationError } from '@/features/shared/errors';
import { TicketControls } from '@/features/tickets/components/ticket-controls';
import { TicketDetails } from '@/features/tickets/components/ticket-details';
import { TicketHeader } from '@/features/tickets/components/ticket-header';
import { TicketResolveDialog } from '@/features/tickets/components/ticket-resolve-dialog';
import { ticketService } from '@/features/tickets/ticket.service';
import { useTicketDetail } from '@/features/tickets/use-ticket-detail';
import type { TicketDetailPayload, TicketPriority, TicketStatus } from '@/features/tickets/types';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';

type PendingAction = 'status' | 'priority' | 'reopen';

/** Linked customer card: one supported `GET …/customers/:id` read. */
function LinkedCustomer({
  workspaceId,
  customerId,
}: {
  readonly workspaceId: string;
  readonly customerId: string;
}): JSX.Element {
  const detail = useCustomerDetail(workspaceId, customerId);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Customer</CardTitle>
          <CardDescription>The customer this ticket belongs to</CardDescription>
        </div>
      </CardHeader>
      <CardBody>
        {detail.status === 'not-found' ? (
          <p className="text-sm text-muted">
            The linked customer is not available — it may have been archived.
          </p>
        ) : detail.status === 'error' ? (
          <p role="alert" className="text-sm text-muted">
            The linked customer could not be loaded.
          </p>
        ) : detail.customer === null ? (
          <div role="status" aria-live="polite" className="space-y-2">
            <span className="sr-only">Loading customer…</span>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-52" />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <ButtonLink to={customerPath(detail.customer.id)} variant="ghost" size="sm" className="-ml-2">
                {detail.customer.name}
              </ButtonLink>
              <Badge tone={CUSTOMER_STATUS_TONES[detail.customer.status]} dot>
                {CUSTOMER_STATUS_LABELS[detail.customer.status]}
              </Badge>
            </div>
            <p className="text-sm text-muted">{detail.customer.email ?? 'No email on file'}</p>
            <ButtonLink to={customerPath(detail.customer.id)} variant="outline" size="sm">
              View customer
            </ButtonLink>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Ticket detail (Prompt 22).
 *
 * Reads the ticket (and the single linked customer) and exposes exactly the
 * mutations the backend supports here: status, priority, resolve with note and
 * reopen. Reassignment and internal notes are intentionally absent — there is
 * no member-directory endpoint, and messaging belongs to Prompt 23.
 */
export function TicketDetailPage(): JSX.Element {
  const { ticketId } = useParams<{ ticketId: string }>();
  const { workspace, role } = useActiveWorkspace();
  const userId = useSessionStore((state) => state.user?.id ?? null);
  const { toast } = useToast();

  const workspaceId = workspace?.id ?? null;
  const detail = useTicketDetail(workspaceId, ticketId);
  const ticket = detail.ticket;

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);

  const canModify = ticket !== null && canModifyTicket(role, userId, ticket);
  const readOnlyReason =
    ticket !== null && !canModify
      ? role === 'agent'
        ? 'Only the assigned agent, the agent who opened this ticket, or a workspace administrator can change it.'
        : 'Your role can read tickets but not change them.'
      : null;

  const isBusy = pending !== null;

  async function changeStatus(status: TicketStatus): Promise<void> {
    if (workspaceId === null || ticket === null || isBusy) return;

    setPending('status');
    setMutationError(null);
    try {
      const payload = await ticketService.setStatus(workspaceId, ticket.id, status);
      toast({ title: 'Status updated', description: `${payload.ticket.number} is now ${payload.ticket.status.replaceAll('_', ' ').toLowerCase()}.`, tone: 'success' });
      detail.refresh();
    } catch (error) {
      setMutationError(
        describeMutationError(error, {
          fallback: 'The status could not be changed. Please try again.',
          conflict: 'The server rejected that status change from the ticket’s current state.',
        }),
      );
    } finally {
      setPending(null);
    }
  }

  async function changePriority(priority: TicketPriority): Promise<void> {
    if (workspaceId === null || ticket === null || isBusy) return;

    setPending('priority');
    setMutationError(null);
    try {
      await ticketService.setPriority(workspaceId, ticket.id, priority);
      toast({ title: 'Priority updated', description: `${ticket.number} priority changed.`, tone: 'success' });
      detail.refresh();
    } catch (error) {
      setMutationError(
        describeMutationError(error, {
          fallback: 'The priority could not be changed. Please try again.',
        }),
      );
    } finally {
      setPending(null);
    }
  }

  async function reopen(): Promise<void> {
    if (workspaceId === null || ticket === null || isBusy) return;

    setPending('reopen');
    setMutationError(null);
    try {
      await ticketService.reopen(workspaceId, ticket.id);
      toast({ title: 'Ticket reopened', description: `${ticket.number} is back in the open queue.`, tone: 'success' });
      detail.refresh();
    } catch (error) {
      setMutationError(
        describeMutationError(error, {
          fallback: 'The ticket could not be reopened. Please try again.',
          conflict: 'This ticket cannot be reopened from its current state.',
        }),
      );
    } finally {
      setPending(null);
    }
  }

  function handleResolved(payload: TicketDetailPayload): void {
    toast({ title: 'Ticket resolved', description: payload.ticket.number, tone: 'success' });
    setMutationError(null);
    detail.refresh();
  }

  return (
    <PageTransition className="space-y-4">
      {workspace === null ? (
        <>
          <Breadcrumbs items={[{ label: 'Tickets', to: ROUTES.tickets }, { label: 'Ticket' }]} />
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState
              icon={<Building2 aria-hidden className="h-6 w-6" />}
              title="No workspace selected"
              message="Choose a workspace to open its tickets."
            />
          </div>
        </>
      ) : detail.status === 'invalid' ? (
        <>
          <Breadcrumbs items={[{ label: 'Tickets', to: ROUTES.tickets }, { label: 'Ticket' }]} />
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState
              icon={<UserX aria-hidden className="h-6 w-6" />}
              title="Invalid ticket link"
              message="This address does not contain a valid ticket identifier."
              action={
                <ButtonLink to={ROUTES.tickets} variant="outline" size="sm">
                  Back to tickets
                </ButtonLink>
              }
            />
          </div>
        </>
      ) : detail.status === 'not-found' ? (
        <>
          <Breadcrumbs items={[{ label: 'Tickets', to: ROUTES.tickets }, { label: 'Ticket' }]} />
          <div className="rounded-xl border border-border bg-surface">
            <EmptyState
              icon={<TicketIcon aria-hidden className="h-6 w-6" />}
              title="Ticket not found"
              message="This ticket does not exist in the current workspace, or was archived."
              action={
                <ButtonLink to={ROUTES.tickets} variant="outline" size="sm">
                  Back to tickets
                </ButtonLink>
              }
            />
          </div>
        </>
      ) : detail.status === 'error' ? (
        <>
          <Breadcrumbs items={[{ label: 'Tickets', to: ROUTES.tickets }, { label: 'Ticket' }]} />
          {detail.forbidden ? (
            <div className="rounded-xl border border-border bg-surface">
              <EmptyState
                icon={<Lock aria-hidden className="h-6 w-6 text-warning" />}
                title="Ticket access required"
                message="Your role cannot read tickets in this workspace. Ask a workspace administrator for access."
              />
            </div>
          ) : (
            <ErrorState
              title="Ticket unavailable"
              message={detail.error ?? 'The ticket could not be loaded.'}
              onRetry={detail.refresh}
            />
          )}
        </>
      ) : ticket === null ? (
        <>
          <Breadcrumbs items={[{ label: 'Tickets', to: ROUTES.tickets }, { label: 'Ticket' }]} />
          <div role="status" aria-live="polite" className="space-y-4">
            <span className="sr-only">Loading ticket…</span>
            <Skeleton className="h-6 w-64" />
            <div className="grid gap-4 lg:grid-cols-3">
              <Skeleton className="h-64 lg:col-span-2" />
              <Skeleton className="h-64" />
            </div>
          </div>
        </>
      ) : (
        <>
          <TicketHeader
            ticket={ticket}
            canModify={canModify}
            isBusy={isBusy}
            onResolve={() => {
              setResolveOpen(true);
            }}
            onReopen={() => {
              void reopen();
            }}
          />

          {mutationError !== null ? <Alert tone="error">{mutationError}</Alert> : null}

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <TicketDetails ticket={ticket} />
            </div>
            <div className="space-y-4">
              <TicketControls
                ticket={ticket}
                canModify={canModify}
                readOnlyReason={readOnlyReason}
                isBusy={isBusy}
                onStatusChange={(status) => {
                  void changeStatus(status);
                }}
                onPriorityChange={(priority) => {
                  void changePriority(priority);
                }}
              />
              <LinkedCustomer workspaceId={workspace.id} customerId={ticket.customerId} />
            </div>
          </div>

          <TicketResolveDialog
            open={resolveOpen}
            workspaceId={workspace.id}
            ticket={ticket}
            onClose={() => {
              setResolveOpen(false);
            }}
            onResolved={handleResolved}
          />
        </>
      )}
    </PageTransition>
  );
}
