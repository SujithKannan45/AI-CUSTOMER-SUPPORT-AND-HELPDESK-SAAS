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
