import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { ArchiveRestore } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableMessageRow,
  TableRow,
} from '@/components/ui/table';
import { customerPath } from '@/app/routes/route-paths';
import { formatDate } from '@/utils/format-date.util';
import { CUSTOMER_STATUS_LABELS, CUSTOMER_STATUS_TONES } from '../labels';
import type { CustomerDto } from '../types';

export interface CustomerTableProps {
  readonly customers: readonly CustomerDto[];
  /** `customer.update` — owners/admins only; gates the restore action. */
  readonly canUpdate: boolean;
  readonly onRestore: (customer: CustomerDto) => void;
  readonly restoringId: string | null;
}

/** Columns present when the restore action is available. */
function columnCount(canUpdate: boolean): number {
  return canUpdate ? 6 : 5;
}

/** Responsive customer directory table; wide content scrolls inside the card. */
export function CustomerTable({
  customers,
  canUpdate,
  onRestore,
  restoringId,
}: CustomerTableProps): JSX.Element {
  return (
    <Table caption="Customers in the current workspace">
      <TableHeader>
        <TableRow>
          <TableHead>Customer</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden md:table-cell">Tags</TableHead>
          <TableHead className="hidden lg:table-cell">Last interaction</TableHead>
          <TableHead>Created</TableHead>
          {canUpdate ? (
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {customers.length === 0 ? (
          <TableMessageRow colSpan={columnCount(canUpdate)}>No customers to show.</TableMessageRow>
        ) : (
          customers.map((customer) => {
            const archived = customer.archivedAt !== null;
            return (
              <TableRow key={customer.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Avatar
                      name={customer.name}
                      size="sm"
                      {...(customer.avatarUrl !== null ? { src: customer.avatarUrl } : {})}
                    />
                    <div className="min-w-0">
                      <Link
                        to={customerPath(customer.id)}
                        className="block truncate font-medium text-foreground transition-colors duration-150 hover:text-primary hover:underline"
                      >
                        {customer.name}
                      </Link>
                      <p className="truncate text-xs text-muted">
                        {customer.email ?? 'No email on file'}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={CUSTOMER_STATUS_TONES[customer.status]} dot>
                      {CUSTOMER_STATUS_LABELS[customer.status]}
                    </Badge>
                    {archived ? (
                      <Badge tone="neutral" appearance="outline">
                        Archived
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {customer.tags.length === 0 ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1">
                      {customer.tags.slice(0, 2).map((tag) => (
                        <Badge key={tag} tone="neutral">
                          {tag}
                        </Badge>
                      ))}
                      {customer.tags.length > 2 ? (
                        <span className="text-xs text-muted">+{customer.tags.length - 2}</span>
                      ) : null}
                    </div>
                  )}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap lg:table-cell">
                  {formatDate(customer.lastInteractionAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(customer.createdAt)}
                </TableCell>
                {canUpdate ? (
                  <TableCell className="text-right">
                    {archived ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onRestore(customer);
                        }}
                        isLoading={restoringId === customer.id}
                        leftIcon={<ArchiveRestore aria-hidden className="h-3.5 w-3.5" />}
                      >
                        Restore
                      </Button>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
