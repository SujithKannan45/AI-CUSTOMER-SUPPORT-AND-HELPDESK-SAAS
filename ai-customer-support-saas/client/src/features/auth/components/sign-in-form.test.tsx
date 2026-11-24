import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { authService } from '@/features/auth/auth.service';
import { useSessionStore } from '@/features/auth/auth.store';
import { HttpApiError } from '@/services/http-client.service';
import { getAccessToken } from '@/services/auth-token.store';
import { makeSessionPayload, resetAuthStores } from '@/test/fixtures';
import { SignInForm } from './sign-in-form';

function renderForm(state?: unknown): void {
  render(
    <MemoryRouter initialEntries={[state === undefined ? '/login' : { pathname: '/login', state }]}>
      <Routes>
        <Route path="/login" element={<SignInForm />} />
        <Route path="/dashboard" element={<p>Dashboard page</p>} />
        <Route path="/workspaces/select" element={<p>Workspace picker</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillCredentials(email = 'ada@example.com', password = 'secret-password'): Promise<void> {
  await userEvent.type(screen.getByLabelText(/Work email/), email);
  await userEvent.type(screen.getByLabelText(/Password/), password);
}

describe('SignInForm', () => {
  beforeEach(() => {
    resetAuthStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks submission and reports required fields', async () => {
    const login = vi.spyOn(authService, 'login');
    renderForm();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('rejects a malformed email before calling the API', async () => {
    const login = vi.spyOn(authService, 'login');
    renderForm();

    await fillCredentials('not-an-email', 'secret-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('toggles password visibility with an accessible control', async () => {
    renderForm();
    const password = screen.getByLabelText(/Password/);

    expect(password).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(password).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('signs in and keeps the token in memory only', async () => {
    const login = vi.spyOn(authService, 'login').mockResolvedValue(makeSessionPayload());
    renderForm();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'secret-password',
    });
    expect(useSessionStore.getState().status).toBe('authenticated');
    expect(getAccessToken()).toBe('memory-only-token');
    expect(JSON.stringify(window.localStorage)).not.toContain('memory-only-token');
    expect(JSON.stringify(window.localStorage)).not.toContain('secret-password');
  });

  it('returns to the protected route the user originally requested', async () => {
    vi.spyOn(authService, 'login').mockResolvedValue(makeSessionPayload());
    renderForm({ from: '/workspaces/select' });

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Workspace picker')).toBeInTheDocument();
  });

  it('shows a safe message for invalid credentials and clears the password', async () => {
    vi.spyOn(authService, 'login').mockRejectedValue(
      new HttpApiError('Invalid email or password', { status: 401, code: 'UNAUTHORIZED' }),
    );
    renderForm();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/)).toHaveValue('');
    expect(screen.queryByText('Dashboard page')).not.toBeInTheDocument();
  });

  it('reports a network failure without navigating', async () => {
    vi.spyOn(authService, 'login').mockRejectedValue(
      new HttpApiError('Network unreachable. Check your connection and try again.', {
        status: 0,
        code: 'NETWORK_ERROR',
      }),
    );
    renderForm();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText('Network unreachable. Check your connection and try again.'),
    ).toBeInTheDocument();
    expect(useSessionStore.getState().status).toBe('idle');
  });

  it('prevents duplicate submissions while a request is in flight', async () => {
    let resolveLogin: (value: ReturnType<typeof makeSessionPayload>) => void = () => undefined;
    const pending = new Promise<ReturnType<typeof makeSessionPayload>>((resolve) => {
      resolveLogin = resolve;
    });
    const login = vi.spyOn(authService, 'login').mockReturnValue(pending);
    renderForm();

    await fillCredentials();
    const submit = screen.getByRole('button', { name: 'Sign in' });
    await userEvent.click(submit);
    await userEvent.click(submit);

    expect(login).toHaveBeenCalledTimes(1);

    resolveLogin(makeSessionPayload());
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
  });
});
