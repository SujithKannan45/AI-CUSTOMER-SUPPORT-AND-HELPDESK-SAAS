import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { authService } from '@/features/auth/auth.service';
import { HttpApiError } from '@/services/http-client.service';
import { ForgotPasswordDialog } from './forgot-password-dialog';

describe('ForgotPasswordDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves initial focus into the email field', async () => {
    render(<ForgotPasswordDialog open onClose={() => undefined} initialEmail="" />);

    expect(await screen.findByLabelText(/Email/)).toHaveFocus();
  });

  it('requests a reset link and shows the anti-enumeration confirmation', async () => {
    const request = vi.spyOn(authService, 'requestPasswordReset').mockResolvedValue({ queued: true });
    render(<ForgotPasswordDialog open onClose={() => undefined} initialEmail="ada@example.com" />);

    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText(/If an account exists for/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('ada@example.com');
    expect(screen.queryByLabelText(/Email/)).not.toBeInTheDocument();
  });

  it('validates the email before calling the API', async () => {
    const request = vi.spyOn(authService, 'requestPasswordReset');
    render(<ForgotPasswordDialog open onClose={() => undefined} />);

    await userEvent.type(screen.getByLabelText(/Email/), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the form available when the request fails', async () => {
    vi.spyOn(authService, 'requestPasswordReset').mockRejectedValue(
      new HttpApiError('Network unreachable.', { status: 0, code: 'NETWORK_ERROR' }),
    );
    render(<ForgotPasswordDialog open onClose={() => undefined} initialEmail="ada@example.com" />);

    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText('Network unreachable.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
  });
});
