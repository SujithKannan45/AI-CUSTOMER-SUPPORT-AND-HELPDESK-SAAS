import { Suspense, type JSX } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppLayout } from '@/layouts/app-layout';
import { LoadingState } from '@/components/feedback/states';
import { NotFoundPage } from '@/pages/not-found.page';
import { DashboardPage } from '@/pages/dashboard.page';

/**
 * Route map. Feature routes are code-split behind React.lazy so the initial
 * bundle stays small; they mount inside AppLayout once their phase lands.
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      // Phase 2+ routes (auth guard wraps these when authentication lands):
      // { path: 'tickets', lazy: () => import('@/features/tickets/routes') },
      // { path: 'conversations', ... },
      // { path: 'knowledge-base', ... },
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
