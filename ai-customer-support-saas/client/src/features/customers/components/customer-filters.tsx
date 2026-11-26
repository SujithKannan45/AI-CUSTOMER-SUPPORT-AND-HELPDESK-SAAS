import type { JSX } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import type { CustomerArchiveState, CustomerStatus } from '../types';

export interface CustomerFiltersProps {
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly status: CustomerStatus | '';
  readonly onStatusChange: (value: CustomerStatus | '') => void;
  readonly archiveState: CustomerArchiveState;
  readonly onArchiveStateChange: (value: CustomerArchiveState) => void;
  readonly isFiltered: boolean;
  readonly onReset: () => void;
  readonly disabled?: boolean;
}

/**
 * Filter bar for the customer directory. Every control maps 1:1 to a backend
 * list parameter (`search`, `status`, `archiveState`); filtering happens on the
 * server, never in the browser.
 */
export function CustomerFilters({
  search,
  onSearchChange,
  status,
  onStatusChange,
  archiveState,
  onArchiveStateChange,
  isFiltered,
  onReset,
  disabled = false,
}: CustomerFiltersProps): JSX.Element {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <SearchInput
        value={search}
        onChange={onSearchChange}
        label="Search customers"
        placeholder="Search by name or email…"
        disabled={disabled}
        className="min-w-0 flex-1"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Filter by customer status"
          value={status}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            onStatusChange(value === 'active' || value === 'blocked' ? value : '');
          }}
          className="w-full sm:w-40"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="blocked">Blocked</option>
        </Select>

        <Select
          aria-label="Filter by archive state"
          value={archiveState}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            onArchiveStateChange(value === 'archived' || value === 'all' ? value : 'live');
          }}
          className="w-full sm:w-44"
        >
          <option value="live">Active customers</option>
          <option value="archived">Archived only</option>
          <option value="all">All customers</option>
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
