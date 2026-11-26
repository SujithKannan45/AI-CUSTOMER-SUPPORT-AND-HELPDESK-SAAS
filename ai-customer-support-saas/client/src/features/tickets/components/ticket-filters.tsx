import type { JSX } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import { TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS } from '../labels';
import { isTicketPriority, isTicketStatus } from '../ticket.service';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from '../types';

export interface TicketFiltersProps {
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly status: TicketStatus | '';
  readonly onStatusChange: (value: TicketStatus | '') => void;
  readonly priority: TicketPriority | '';
  readonly onPriorityChange: (value: TicketPriority | '') => void;
  readonly isFiltered: boolean;
  readonly onReset: () => void;
  readonly disabled?: boolean;
}

/**
 * Ticket filter bar. Search, status and priority are the backend's own list
 * parameters — the filtering (including the AND-combination) happens in
 * MongoDB, not in the browser.
 */
export function TicketFilters({
  search,
  onSearchChange,
  status,
  onStatusChange,
  priority,
  onPriorityChange,
  isFiltered,
  onReset,
  disabled = false,
}: TicketFiltersProps): JSX.Element {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <SearchInput
        value={search}
        onChange={onSearchChange}
        label="Search tickets"
        placeholder="Search by number or subject…"
        disabled={disabled}
        className="min-w-0 flex-1"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Filter by ticket status"
          value={status}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            onStatusChange(isTicketStatus(value) ? value : '');
          }}
          className="w-full sm:w-44"
        >
          <option value="">All statuses</option>
          {TICKET_STATUSES.map((value) => (
            <option key={value} value={value}>
              {TICKET_STATUS_LABELS[value]}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Filter by ticket priority"
          value={priority}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            onPriorityChange(isTicketPriority(value) ? value : '');
          }}
          className="w-full sm:w-40"
        >
          <option value="">All priorities</option>
          {TICKET_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {TICKET_PRIORITY_LABELS[value]}
            </option>
          ))}
        </Select>

        {isFiltered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={disabled}
            leftIcon={<X aria-hidden className="h-3.5 w-3.5" />}
          >
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
}
