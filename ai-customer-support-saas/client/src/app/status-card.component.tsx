import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { CloudCheck, CloudOff, Loader2 } from 'lucide-react';
import { Card, CardBody, CardTitle } from '@/components/ui/card';
import { healthService } from '@/services/health.service';
import type { HealthReadinessResponse } from '@/types/api.types';

type Status = 'checking' | 'ok' | 'degraded' | 'offline';

/**
 * Live readiness probe against `/health/ready` through the dev proxy.
 * Demonstrates the API service foundation end-to-end; remains useful as a
 * genuine environment check until real features replace this surface.
 */
export function ClientStatusCard(): JSX.Element {
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

  const label: Record<Status, string> = {
    checking: 'Checking API…',
    ok: 'API operational',
    degraded: 'API degraded — database unreachable',
    offline: 'API unreachable',
  };

  return (
    <Card>
      <CardBody className="flex items-center gap-4">
        {status === 'checking' ? (
          <Loader2 aria-hidden className="h-6 w-6 animate-spin text-ink-400" />
        ) : status === 'ok' ? (
          <CloudCheck aria-hidden className="h-6 w-6 text-success" />
        ) : (
          <CloudOff aria-hidden className="h-6 w-6 text-danger" />
        )}
        <div>
          <CardTitle>{label[status]}</CardTitle>
          <p className="mt-0.5 text-xs text-ink-500">
            {detail ? `Database: ${detail.services.database}` : 'GET /health/ready'}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
