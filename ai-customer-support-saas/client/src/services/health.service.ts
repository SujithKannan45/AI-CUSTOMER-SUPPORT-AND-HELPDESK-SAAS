import { httpClient } from './http-client.service';
import type { HealthCheckResponse, HealthReadinessResponse } from '../types/api.types';

/** Observability endpoints (unversioned by design — see server health module). */
export const healthService = {
  getLiveness(): Promise<HealthCheckResponse> {
    return httpClient.get<HealthCheckResponse>('/health');
  },
  getReadiness(): Promise<HealthReadinessResponse> {
    return httpClient.get<HealthReadinessResponse>('/health/ready');
  },
};
