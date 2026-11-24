/** Contracts shared by API services. Mirrors the server's response shapes. */

/** Standard success envelope: `{ success: true, data, requestId? }`. */
export interface ApiSuccessBody<TData> {
  success: true;
  data: TData;
  requestId?: string;
}

/** Central error envelope produced by the server's error middleware. */
export interface ApiErrorPayload {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

/** Pagination envelope used by list endpoints (tickets, customers, …). */
export interface PaginatedPayload<TItem> {
  items: readonly TItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/** Observability probes are deliberately un-enveloped (see server health module). */
export interface HealthCheckResponse {
  success: true;
  status: 'ok';
  timestamp: string;
  services: {
    api: 'up';
  };
}

export interface HealthReadinessResponse {
  success: true;
  status: 'ok' | 'degraded';
  timestamp: string;
  services: {
    api: 'up';
    database: 'up' | 'down';
  };
  environment: string;
  requestId?: string;
}
