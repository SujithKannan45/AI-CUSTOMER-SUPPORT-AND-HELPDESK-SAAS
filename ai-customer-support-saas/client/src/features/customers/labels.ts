import type { BadgeTone } from '@/components/ui/badge';
import type { CustomerStatus } from './types';

/** Human labels for the actual backend customer lifecycle enum. */
export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  active: 'Active',
  blocked: 'Blocked',
};

export const CUSTOMER_STATUS_TONES: Record<CustomerStatus, BadgeTone> = {
  active: 'success',
  blocked: 'danger',
};
