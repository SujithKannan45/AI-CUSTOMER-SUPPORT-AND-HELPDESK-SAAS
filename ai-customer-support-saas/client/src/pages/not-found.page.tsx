import type { JSX } from 'react';
import { Compass } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { ROUTES } from '@/app/routes/route-paths';

export function NotFoundPage(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <div className="rounded-full bg-surface-hover p-4 text-muted">
        <Compass aria-hidden className="h-8 w-8" />
      </div>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Page not found</h1>
        <p className="mt-1 text-sm text-muted">The page you are looking for does not exist or has moved.</p>
      </div>
      <ButtonLink to={ROUTES.dashboard} variant="outline">
        Back to dashboard
      </ButtonLink>
    </div>
  );
}
