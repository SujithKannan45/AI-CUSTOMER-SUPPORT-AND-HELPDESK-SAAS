import { Suspense, lazy, type JSX } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppLayout } from '@/layouts/app-layout';
import { LoadingState } from '@/components/feedback/states';
import { RequireAuth } from '@/app/guards/require-auth';
import { ROUTES } from '@/app/routes/route-paths';
import { LoginPage } from '@/pages/login.page';
import { NotFoundPage } from '@/pages/not-found.page';

/** Route-level code splitting: the shell renders instantly, pages stream in. */
const DashboardPage = lazy(() =>
  import('@/pages/dashboard.page').then((module) => ({ default: module.DashboardPage })),
);

/**
 * Route map.
 *
 * - `/login` is public (Prompt 20 fills it in).
 * - Everything else sits inside `RequireAuth` → `AppLayout`, so protected
 *   content is never rendered for an unauthenticated visitor.
 * - Feature routes mount as `children` when their prompts land.
 */
const router = createBrowserRouter([
  { path: ROUTES.login, element: <LoginPage /> },
  {
    path: ROUTES.root,
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function AppRouter(): JSX.Element {
  return (
    <Suspense fallback={<LoadingState label="Loading application…" />}>
      <RouterProvider router={router} />
    </Suspense>
  );
}
