import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { authService } from '@/features/auth/auth.service';
import { useSessionStore } from '@/features/auth/auth.store';
import { HttpApiError } from '@/services/http-client.service';
import { RequireAuth } from './require-auth';

const USER = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  status: 'active',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route
          path="/dashboard"
          element={
            <RequireAuth>
              <p>Protected content</p>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  beforeEach(() => {
    useSessionStore.setState({ status: 'idle', user: null, error: null });
  });

  it('renders protected content for an authenticated session', async () => {
    vi.spyOn(authService, 'getCurrentUser').mockResolvedValue(USER);

    renderGuard();

    expect(await screen.findByText('Protected content')).toBeInTheDocument();
    expect(useSessionStore.getState().status).toBe('authenticated');
  });

  it('redirects to the login route when the session is rejected', async () => {
    vi.spyOn(authService, 'getCurrentUser').mockRejectedValue(
      new HttpApiError('Session expired', { status: 401, code: 'UNAUTHORIZED' }),
    );

    renderGuard();

    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(useSessionStore.getState().status).toBe('anonymous');
  });

  it('shows a retryable error when the API cannot be reached', async () => {
    vi.spyOn(authService, 'getCurrentUser').mockRejectedValue(
      new HttpApiError('Network unreachable', { status: 0, code: 'NETWORK_ERROR' }),
    );

    renderGuard();

    expect(await screen.findByText('Cannot reach the API')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });
});
