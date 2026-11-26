/**
 * Central route table.
 *
 * Paths are declared here so guards, navigation and pages never hard-code
 * strings. Feature routes mount inside the protected `AppLayout` subtree.
 */
export const ROUTES = {
  root: '/',
  login: '/login',
  resetPassword: '/reset-password',
  workspacesSelect: '/workspaces/select',
  dashboard: '/dashboard',
  customers: '/customers',
  /** Route pattern; build real links with `customerPath()`. */
  customerDetail: '/customers/:customerId',
  tickets: '/tickets',
  /** Route pattern; build real links with `ticketPath()`. */
  ticketDetail: '/tickets/:ticketId',
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];

/** Link to one customer. Ids are encoded, never interpolated raw. */
export function customerPath(customerId: string): string {
  return `${ROUTES.customers}/${encodeURIComponent(customerId)}`;
}

/** Link to one ticket. */
export function ticketPath(ticketId: string): string {
  return `${ROUTES.tickets}/${encodeURIComponent(ticketId)}`;
}
