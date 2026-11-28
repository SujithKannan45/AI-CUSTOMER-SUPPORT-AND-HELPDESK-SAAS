import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HttpApiError } from '@/services/http-client.service';
import { MessageComposer } from './message-composer';
import type { MessageVisibility } from '../types';

function renderComposer(
  overrides: Partial<{
    canReply: boolean;
    readOnlyReason: string | null;
    onSend: (body: string, visibility: MessageVisibility) => Promise<void>;
  }> = {},
): { onSend: ReturnType<typeof vi.fn> } {
  const onSend = vi.fn(overrides.onSend ?? ((): Promise<void> => Promise.resolve()));
  render(
    <MessageComposer
      canReply={overrides.canReply ?? true}
      readOnlyReason={overrides.readOnlyReason ?? null}
      onSend={onSend}
    />,
  );
  return { onSend };
}

describe('MessageComposer', () => {
  it('rejects an empty message without calling the API', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(await screen.findByText('Write a message before sending.')).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('treats a whitespace-only body as empty', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    await user.type(screen.getByRole('textbox'), '    ');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Write a message before sending.')).toBeInTheDocument();
  });

  it('sends a trimmed public reply and clears the draft on success', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    await user.type(screen.getByRole('textbox'), '  We refunded order 8812.  ');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('We refunded order 8812.', 'PUBLIC');
    });
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('keeps the typed text and reports the failure when the server rejects it', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      onSend: () =>
        Promise.reject(
          new HttpApiError('server detail that must not be shown', {
            status: 500,
            code: 'INTERNAL',
          }),
        ),
    });

    await user.type(screen.getByRole('textbox'), 'Draft that matters');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(await screen.findByText('Your message was not sent. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('server detail that must not be shown')).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('Draft that matters');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('maps a 404 to a conversation-specific message', async () => {
    const user = userEvent.setup();
    renderComposer({
      onSend: () => Promise.reject(new HttpApiError('gone', { status: 404, code: 'NOT_FOUND' })),
    });

    await user.type(screen.getByRole('textbox'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(
      await screen.findByText('This conversation no longer exists in the current workspace.'),
    ).toBeInTheDocument();
  });

  it('prevents duplicate submissions while a send is in flight', async () => {
    const user = userEvent.setup();
    let resolveSend: () => void = () => undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    render(<MessageComposer canReply readOnlyReason={null} onSend={onSend} />);

    await user.type(screen.getByRole('textbox'), 'One message only');
    const button = screen.getByRole('button', { name: 'Send reply' });
    await user.click(button);
    await user.click(button);
    fireEvent.submit(screen.getByRole('textbox').closest('form') as HTMLFormElement);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    resolveSend();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send reply' })).not.toBeDisabled();
    });
  });

  it('sends an internal note only after the agent selects that mode', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    const noteMode = screen.getByRole('button', { name: 'Internal note' });
    expect(noteMode).toHaveAttribute('aria-pressed', 'false');

    await user.click(noteMode);

    expect(noteMode).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByText('Visible to workspace staff only. The customer never receives it.'),
    ).toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), 'Refund checked with finance');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Refund checked with finance', 'INTERNAL');
    });
  });

  it('sends with Ctrl+Enter but keeps Enter as a newline', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'line one');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('line one', 'PUBLIC');
    });
  });

  it('rejects a body above the server limit before sending', async () => {
    const { onSend } = renderComposer();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a'.repeat(10_001) } });
    fireEvent.submit(screen.getByRole('textbox').closest('form') as HTMLFormElement);

    expect(await screen.findByText('Messages are limited to 10000 characters.')).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders a read-only explanation instead of a composer without reply permission', () => {
    renderComposer({ canReply: false, readOnlyReason: 'Your role can read conversations but not send messages.' });

    expect(screen.getByText('Your role can read conversations but not send messages.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send reply' })).toBeNull();
  });
});
