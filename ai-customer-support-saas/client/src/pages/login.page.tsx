import type { JSX } from 'react';
import { Headset, ShieldCheck } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { clientEnv } from '@/config/env.config';

/**
 * Sign-in route placeholder.
 *
 * Prompt 20 owns the authentication screens; this page exists so the route
 * table, the guard redirect and the unauthenticated layout are real and
 * verifiable today. It deliberately contains no form, no demo credentials and
 * no way to bypass the guard.
 */
export function LoginPage(): JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Headset aria-hidden className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight text-foreground">{clientEnv.appName}</span>
      </div>

      <Card className="w-full max-w-md">
        <CardBody className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Sign in</h1>
            <p className="mt-1 text-sm leading-6 text-muted">
              The sign-in experience ships with the authentication prompt. The API already supports it
              (`POST /api/v1/auth/login` → access token in JSON, refresh token in an HttpOnly cookie).
            </p>
          </div>

          <Separator />

          <div className="flex items-start gap-2.5 rounded-lg bg-surface-subtle p-3">
            <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <p className="text-xs leading-5 text-muted">
              Protected routes are served only after the session guard resolves a real session from the
              refresh cookie. There are no demo sessions and no client-side bypass.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
