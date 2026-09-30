/** Contracts shared by API services. Mirrors the server's response shapes. */

export interface ApiErrorPayload {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export interface HealthCheckResponse {
  status: 'ok';
}

export interface HealthReadinessResponse {
  status: 'ok' | 'degraded';
  checks: {
    database: 'ok' | 'unavailable';
  };
  requestId?: string;
}
