import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { authService } from '@/features/auth/auth.service';
import { useSessionStore } from '@/features/auth/auth.store';
import { resetAuthStores, TEST_USER } from '@/test/fixtures';
import { LoginPage } from './login.page';

function renderPage(entry: string | { pathname: string; state: unknown } = '/login'): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<p>Dashboard page</p>} />
        <Route path="/workspaces/select" element={<p>Workspace picker</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    resetAuthStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the sign-in form to an anonymous visitor', async () => {
    useSessionStore.setState({ status: 'anonymous', user: null, error: null });
    vi.spyOn(authService, 'getCurrentUser').mockRejectedValue(new Error('no session'));

    renderPage();

    expect(await screen.findByLabelText(/Work email/)).toBeInTheDocument();
    expect(screen.queryByText('Dashboard page')).not.toBeInTheDocument();
  });

  it('redirects an already-restored session away from the form', async () => {
    vi.spyOn(authService, 'getCurrentUser').mockResolvedValue(TEST_USER);

    renderPage();

    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Work email/)).not.toBeInTheDocument();
  });

  it('honours the original protected destination', async () => {
    vi.spyOn(authService, 'getCurrentUser').mockResolvedValue(TEST_USER);

    renderPage({ pathname: '/login', state: { from: '/workspaces/select' } });

    expect(await screen.findByText('Workspace picker')).toBeInTheDocument();
  });
});
