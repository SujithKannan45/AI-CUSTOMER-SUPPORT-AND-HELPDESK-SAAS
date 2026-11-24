import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ChevronRight, LogOut, Plus } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BrandMark } from '@/components/common/brand-mark';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { ThemeToggle } from '@/layouts/components/theme-toggle';
import { useSessionStore } from '@/features/auth/auth.store';
import { useSignOut } from '@/features/auth/use-sign-out';
import { CreateWorkspaceDialog } from '@/features/workspace/components/create-workspace-dialog';
import { useWorkspaceBootstrap } from '@/features/workspace/use-workspace';
import { ROLE_LABELS } from '@/features/workspace/types';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { ROUTES } from '@/app/routes/route-paths';

function formatJoinedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Member';
  return `Member since ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

/**
 * `/workspaces/select` — protected, but intentionally outside the workspace
 * gate so an account with no active membership still has a real destination.
 *
 * The list is exactly `GET /api/v1/workspaces` (active memberships only). A
 * choice here is presentation state; every later request re-checks membership
 * on the server.
 */
export function WorkspacesSelectPage(): JSX.Element {
  useWorkspaceBootstrap();

  const navigate = useNavigate();
  const user = useSessionStore((state) => state.user);
  const { signOut, isSigningOut } = useSignOut();

  const status = useWorkspaceStore((state) => state.status);
  const items = useWorkspaceStore((state) => state.items);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const error = useWorkspaceStore((state) => state.error);
  const load = useWorkspaceStore((state) => state.load);
  const setActive = useWorkspaceStore((state) => state.setActive);

  const [createOpen, setCreateOpen] = useState(false);

  function selectWorkspace(workspaceId: string): void {
    setActive(workspaceId);
    void navigate(ROUTES.dashboard, { replace: true });
  }

  const isLoading = status === 'idle' || status === 'loading';

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between gap-3 px-4 sm:px-6">
          <BrandMark />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {user !== null ? (
              <span className="hidden min-w-0 max-w-56 text-right sm:block">
                <span className="block truncate text-sm font-medium text-foreground">{user.name}</span>
                <span className="block truncate text-xs text-muted">{user.email}</span>
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              isLoading={isSigningOut}
              leftIcon={<LogOut aria-hidden className="h-3.5 w-3.5" />}
              onClick={() => {
                void signOut();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Choose a workspace</h1>
            <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted">
              Your account can belong to more than one workspace. Pick the one you want to work in — you can
              switch later from the sidebar.
            </p>
          </div>
          {status === 'ready' && items.length > 0 ? (
            <Button
              variant="outline"
              leftIcon={<Plus aria-hidden className="h-4 w-4" />}
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              New workspace
            </Button>
          ) : null}
        </div>

        <div className="mt-8">
          {isLoading ? (
            <div>
              <p role="status" aria-live="polite" className="sr-only">
                Loading your workspaces…
              </p>
              <div aria-hidden className="space-y-3">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            </div>
          ) : null}

          {status === 'error' ? (
            <ErrorState
              title="Cannot load your workspaces"
              message={error ?? undefined}
              onRetry={() => {
                void load();
              }}
            />
          ) : null}

          {status === 'ready' && items.length === 0 ? (
            <EmptyState
              icon={<Building2 aria-hidden className="h-6 w-6" />}
              title="No workspace yet"
              message="You are not an active member of any workspace. Create one to start using the helpdesk."
              action={
                <Button
                  leftIcon={<Plus aria-hidden className="h-4 w-4" />}
                  onClick={() => {
                    setCreateOpen(true);
                  }}
                >
                  Create workspace
                </Button>
              }
            />
          ) : null}

          {status === 'ready' && items.length > 0 ? (
            <ul aria-label="Your workspaces" className="space-y-3">
              {items.map(({ workspace, membership }) => {
                const isActive = workspace.id === activeWorkspaceId;
                return (
                  <li key={workspace.id}>
                    <button
                      type="button"
                      onClick={() => {
                        selectWorkspace(workspace.id);
                      }}
                      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3.5 text-left shadow-card transition-colors hover:border-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <Avatar name={workspace.name} size="lg" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">{workspace.name}</span>
                          <Badge tone={membership.role === 'owner' ? 'brand' : 'neutral'}>
                            {ROLE_LABELS[membership.role]}
                          </Badge>
                          {isActive ? <Badge tone="success">Current</Badge> : null}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted">
                          <span className="font-mono">{workspace.slug}</span> ·{' '}
                          {formatJoinedAt(membership.joinedAt)}
                        </span>
                      </span>
                      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </main>

      <CreateWorkspaceDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={() => {
          void navigate(ROUTES.dashboard, { replace: true });
        }}
      />
    </div>
  );
}
