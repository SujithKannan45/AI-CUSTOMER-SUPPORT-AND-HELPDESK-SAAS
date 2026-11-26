import { Suspense, lazy, type JSX } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppLayout } from '@/layouts/app-layout';
import { LoadingState } from '@/components/feedback/states';
import { RequireAuth } from '@/app/guards/require-auth';
import { RequireWorkspace } from '@/app/guards/require-workspace';
import { ROUTES } from '@/app/routes/route-paths';
import { LoginPage } from '@/pages/login.page';
import { ResetPasswordPage } from '@/pages/reset-password.page';
import { WorkspacesSelectPage } from '@/pages/workspaces-select.page';
import { NotFoundPage } from '@/pages/not-found.page';

/** Route-level code splitting: the shell renders instantly, pages stream in. */
const DashboardPage = lazy(() =>
  import('@/pages/dashboard.page').then((module) => ({ default: module.DashboardPage })),
);
const CustomersPage = lazy(() =>
  import('@/pages/customers.page').then((module) => ({ default: module.CustomersPage })),
);
const CustomerDetailPage = lazy(() =>
  import('@/pages/customer-detail.page').then((module) => ({ default: module.CustomerDetailPage })),
);
const TicketsPage = lazy(() =>
  import('@/pages/tickets.page').then((module) => ({ default: module.TicketsPage })),
);
const TicketDetailPage = lazy(() =>
  import('@/pages/ticket-detail.page').then((module) => ({ default: module.TicketDetailPage })),
);

/**
 * Route map.
 *
 * - Public: `/login` and `/reset-password` (the emailed token destination).
 * - `/workspaces/select` requires a session but NOT a workspace — it is the
 *   destination for accounts without an active membership.
 * - Everything else sits inside `RequireAuth` → `RequireWorkspace` →
 *   `AppLayout`, so neither protected content nor a tenant-less shell renders.
 * - `/customers` and `/tickets` (Prompt 22) are workspace-scoped: their pages
 *   read the active workspace from the store and the server re-authorizes every
 *   request.
 */
const router = createBrowserRouter([
  { path: ROUTES.login, element: <LoginPage /> },
  { path: ROUTES.resetPassword, element: <ResetPasswordPage /> },
  {
    path: ROUTES.workspacesSelect,
    element: (
      <RequireAuth>
        <WorkspacesSelectPage />
      </RequireAuth>
    ),
  },
  {
    path: ROUTES.root,
    element: (
      <RequireAuth>
        <RequireWorkspace>
          <AppLayout />
        </RequireWorkspace>
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'customers', element: <CustomersPage /> },
      { path: 'customers/:customerId', element: <CustomerDetailPage /> },
      { path: 'tickets', element: <TicketsPage /> },
      { path: 'tickets/:ticketId', element: <TicketDetailPage /> },
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
