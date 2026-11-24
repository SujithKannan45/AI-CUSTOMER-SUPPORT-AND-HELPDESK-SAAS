import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { authService } from '@/features/auth/auth.service';
import { ResetPasswordPage } from './reset-password.page';

const TOKEN = 'a'.repeat(64);

function renderPage(url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ResetPasswordPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a malformed link without calling the API', async () => {
    renderPage('/reset-password?email=ada@example.com&token=short');

    expect(await screen.findByText('Reset link unavailable')).toBeInTheDocument();
    expect(screen.getByText(/missing information or has been altered/)).toBeInTheDocument();
  });

  it('validates the new password and confirmation locally', async () => {
    const reset = vi.spyOn(authService, 'resetPassword');
    renderPage(`/reset-password?email=ada@example.com&token=${TOKEN}`);

    await userEvent.type(screen.getByLabelText(/New password/), 'short1');
    await userEvent.type(screen.getByLabelText(/Confirm new password/), 'short2');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();
  });

  it('submits the real token contract and returns to sign-in', async () => {
    const reset = vi.spyOn(authService, 'resetPassword').mockResolvedValue({ passwordReset: true });
    renderPage(`/reset-password?email=ada@example.com&token=${TOKEN}`);

    await userEvent.type(screen.getByLabelText(/New password/), 'new-password1');
    await userEvent.type(screen.getByLabelText(/Confirm new password/), 'new-password1');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(reset).toHaveBeenCalledWith({
      email: 'ada@example.com',
      token: TOKEN,
      password: 'new-password1',
    });
  });
});
