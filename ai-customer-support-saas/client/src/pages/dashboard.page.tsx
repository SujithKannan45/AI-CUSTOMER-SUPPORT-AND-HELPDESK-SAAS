import type { JSX } from 'react';
import { Building2, ShieldCheck, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { PageTransition } from '@/components/common/page-transition';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiStatusCard } from '@/features/dashboard/components/api-status-card';
import { useSessionStore } from '@/features/auth/auth.store';
import { useActiveWorkspace } from '@/features/workspace/use-workspace';
import { ROLE_LABELS } from '@/features/workspace/types';

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * Landing surface for the signed-in shell. Everything rendered here comes from
 * the API (session + workspace) or from a live health probe — no invented
 * metrics, no fake activity feed.
 */
export function DashboardPage(): JSX.Element {
  const user = useSessionStore((state) => state.user);
  const { workspace, role } = useActiveWorkspace();

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Workspace' }, { label: 'Dashboard' }]}
        title={user !== null ? `Welcome back, ${firstName(user.name)}` : 'Dashboard'}
        description="Your support workspace is connected. Tickets, conversations, knowledge and analytics surfaces arrive in the next prompts on top of this shell."
      />

      <section aria-label="Workspace summary" className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Building2 aria-hidden className="h-4 w-4 text-muted" />
                Workspace
              </CardTitle>
              <CardDescription>Resolved from your membership via GET /api/v1/workspaces</CardDescription>
            </div>
            {role !== null ? <Badge tone="brand">{ROLE_LABELS[role]}</Badge> : null}
          </CardHeader>
          <CardBody className="space-y-1.5">
            {workspace !== null ? (
              <>
                <p className="text-sm font-medium text-foreground">{workspace.name}</p>
                <p className="text-xs text-muted">
                  <span className="font-mono">{workspace.slug}</span> · {workspace.settings.timezone} ·{' '}
                  {workspace.settings.locale}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">No workspace is available for this account yet.</p>
            )}
          </CardBody>
        </Card>

        <ApiStatusCard />
      </section>

      <section aria-label="Foundation status" className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck aria-hidden className="h-4 w-4 text-muted" />
                Session &amp; security
              </CardTitle>
              <CardDescription>How this build handles identity</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2 text-sm leading-6 text-muted">
              <li>Access tokens live in memory only; the refresh token is an HttpOnly cookie.</li>
              <li>Failed requests refresh once, then the session is dropped — never a loop.</li>
              <li>Every workspace call is authorized by the API from your membership row.</li>
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Sparkles aria-hidden className="h-4 w-4 text-muted" />
                Design system
              </CardTitle>
              <CardDescription>Foundation available to every feature</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="brand">Buttons</Badge>
              <Badge tone="info">Forms</Badge>
              <Badge tone="success">Tables</Badge>
              <Badge tone="warning">Dialogs</Badge>
              <Badge tone="neutral">Toasts</Badge>
              <Badge tone="danger">Errors</Badge>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted">
              Semantic tokens drive light and dark themes; components are shared from
              <span className="font-mono text-xs text-foreground"> components/ui</span>.
            </p>
          </CardBody>
        </Card>
      </section>
    </PageTransition>
  );
}
