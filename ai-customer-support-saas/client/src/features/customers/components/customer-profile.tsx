import type { JSX, ReactNode } from 'react';
import { Archive, Pencil } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatDateTime } from '@/utils/format-date.util';
import { CUSTOMER_STATUS_LABELS, CUSTOMER_STATUS_TONES } from '../labels';
import type { CustomerDto } from '../types';

function DetailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2 first:pt-0 last:pb-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

export interface CustomerProfileProps {
  readonly customer: CustomerDto;
  readonly canUpdate: boolean;
  readonly onEdit: () => void;
  readonly onArchive: () => void;
  readonly isArchiving: boolean;
}

/**
 * Customer summary surface: identity, lifecycle, contact details, record
 * timestamps and the metadata keys the API returns. Nothing is derived beyond
 * formatting; a field the API reports as null renders as an explicit absence.
 */
export function CustomerProfile({
  customer,
  canUpdate,
  onEdit,
  onArchive,
  isArchiving,
}: CustomerProfileProps): JSX.Element {
  const metadataEntries = Object.entries(customer.metadata).sort(([a], [b]) => a.localeCompare(b));
  const archived = customer.archivedAt !== null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <Avatar
              name={customer.name}
              size="lg"
              {...(customer.avatarUrl !== null ? { src: customer.avatarUrl } : {})}
            />
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold tracking-tight text-foreground">
                  {customer.name}
                </h2>
                <Badge tone={CUSTOMER_STATUS_TONES[customer.status]} dot>
                  {CUSTOMER_STATUS_LABELS[customer.status]}
                </Badge>
                {archived ? (
                  <Badge tone="neutral" appearance="outline">
                    Archived
                  </Badge>
                ) : null}
              </div>
              <p className="text-sm text-muted">{customer.email ?? 'No email on file'}</p>
              {customer.tags.length > 0 ? (
                <ul aria-label="Customer tags" className="flex flex-wrap gap-1.5 pt-0.5">
                  {customer.tags.map((tag) => (
                    <li key={tag}>
                      <Badge tone="neutral">{tag}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">No tags</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canUpdate ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onEdit}
                leftIcon={<Pencil aria-hidden className="h-3.5 w-3.5" />}
              >
                Edit
              </Button>
            ) : null}
            {canUpdate && !archived ? (
              <Button
                variant="danger"
                size="sm"
                onClick={onArchive}
                isLoading={isArchiving}
                leftIcon={<Archive aria-hidden className="h-3.5 w-3.5" />}
              >
                Archive
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="divide-y divide-border">
              <DetailRow label="Email">{customer.email ?? '—'}</DetailRow>
              <DetailRow label="Phone">{customer.phone ?? '—'}</DetailRow>
              <DetailRow label="Last interaction">{formatDateTime(customer.lastInteractionAt)}</DetailRow>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Record</CardTitle>
            <CardDescription>Timestamps are stored and shown in UTC</CardDescription>
          </CardHeader>
          <CardBody>
            <dl className="divide-y divide-border">
              <DetailRow label="Created">{formatDateTime(customer.createdAt)}</DetailRow>
              <DetailRow label="Updated">{formatDateTime(customer.updatedAt)}</DetailRow>
              {archived ? (
                <DetailRow label="Archived">{formatDateTime(customer.archivedAt)}</DetailRow>
              ) : null}
              <DetailRow label="Customer ID">
                <span className="font-mono text-xs">{customer.id}</span>
              </DetailRow>
            </dl>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Metadata</CardTitle>
            <CardDescription>Application-managed keys stored on the customer record</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {metadataEntries.length === 0 ? (
            <p className="text-sm text-muted">No metadata keys on this record.</p>
          ) : (
            <dl className="divide-y divide-border">
              {metadataEntries.map(([key, value]) => (
                <DetailRow key={key} label={key}>
                  <span className="font-mono text-xs">
                    {value === null ? '—' : String(value)}
                  </span>
                </DetailRow>
              ))}
            </dl>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-muted">Created {formatDate(customer.createdAt)} · Updated {formatDate(customer.updatedAt)}</p>
    </div>
  );
}
