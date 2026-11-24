import { useEffect, useState, type JSX } from 'react';
import { CloudCheck, CloudOff, Loader2 } from 'lucide-react';
import { Card, CardBody, CardDescription, CardTitle } from '@/components/ui/card';
import { healthService } from '@/services/health.service';
import type { HealthReadinessResponse } from '@/types/api.types';

type Status = 'checking' | 'ok' | 'degraded' | 'offline';

const LABEL: Record<Status, string> = {
  checking: 'Checking API…',
  ok: 'API operational',
  degraded: 'API degraded — database unreachable',
  offline: 'API unreachable',
};

/**
 * Live readiness probe against `/health/ready` through the dev proxy.
 * Kept as a genuine environment check: it proves the API client, envelope
 * handling and error path end-to-end without inventing product data.
 */
export function ApiStatusCard(): JSX.Element {
  const [status, setStatus] = useState<Status>('checking');
  const [detail, setDetail] = useState<HealthReadinessResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    healthService
      .getReadiness()
      .then((response) => {
        if (cancelled) return;
        setDetail(response);
        setStatus(response.services.database === 'up' ? 'ok' : 'degraded');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('offline');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardBody className="flex items-start gap-3.5">
        {status === 'checking' ? (
          <Loader2 aria-hidden className="h-5 w-5 animate-spin text-muted" />
        ) : status === 'ok' ? (
          <CloudCheck aria-hidden className="h-5 w-5 text-success" />
        ) : (
          <CloudOff aria-hidden className="h-5 w-5 text-danger" />
        )}
        <div className="min-w-0">
          <CardTitle>{LABEL[status]}</CardTitle>
          <CardDescription>
            {detail !== null ? `Database: ${detail.services.database}` : 'GET /health/ready'}
          </CardDescription>
        </div>
      </CardBody>
    </Card>
  );
}
