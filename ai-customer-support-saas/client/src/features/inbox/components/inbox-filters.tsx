import type { JSX } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SearchInput } from '@/components/ui/search-input';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from '@/features/tickets/types';
import { TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS } from '@/features/tickets/labels';

export interface InboxFiltersProps {
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly status: TicketStatus | '';
  readonly onStatusChange: (value: TicketStatus | '') => void;
  readonly priority: TicketPriority | '';
  readonly onPriorityChange: (value: TicketPriority | '') => void;
  readonly isFiltered: boolean;
  readonly onReset: () => void;
  readonly disabled: boolean;
}

/**
 * Inbox search and filters.
 *
 * Every control maps onto a validated `GET …/tickets` parameter, because the
 * conversation index is built from the workspace's tickets (one primary
 * conversation per ticket). Nothing here filters client-side.
 */
export function InboxFilters({
  search,
  onSearchChange,
  status,
  onStatusChange,
  priority,
  onPriorityChange,
  isFiltered,
  onReset,
  disabled,
}: InboxFiltersProps): JSX.Element {
  return (
    <div className="space-y-2">
      <SearchInput
        value={search}
        onChange={onSearchChange}
        label="Search conversations"
        placeholder="Search by ticket number or subject…"
        disabled={disabled}
      />
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="sr-only">Filter by ticket status</span>
          <Select
            aria-label="Filter by ticket status"
            value={status}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              onStatusChange(value === '' ? '' : (value as TicketStatus));
            }}
          >
            <option value="">All statuses</option>
            {TICKET_STATUSES.map((option) => (
              <option key={option} value={option}>
                {TICKET_STATUS_LABELS[option]}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="sr-only">Filter by priority</span>
          <Select
            aria-label="Filter by priority"
            value={priority}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              onPriorityChange(value === '' ? '' : (value as TicketPriority));
            }}
          >
            <option value="">All priorities</option>
            {TICKET_PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {TICKET_PRIORITY_LABELS[option]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {isFiltered ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          leftIcon={<RotateCcw aria-hidden className="h-3.5 w-3.5" />}
          className="-ml-2"
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
