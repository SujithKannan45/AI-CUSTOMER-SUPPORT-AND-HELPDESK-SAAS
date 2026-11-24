import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useToast } from '@/hooks/use-toast';
import { ToastProvider } from './toast.provider';

function ToastTrigger() {
  const { toast } = useToast();

  return (
    <button
      type="button"
      onClick={() => {
        toast({ title: 'Ticket archived', description: 'It is no longer in the queue.', tone: 'success', durationMs: 0 });
      }}
    >
      Archive
    </button>
  );
}

function TransientToastTrigger() {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        toast({ title: 'Saved', durationMs: 120 });
      }}
    >
      Save
    </button>
  );
}

describe('ToastProvider', () => {
  it('announces a toast and allows dismissing it', async () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(screen.getByText('Ticket archived')).toBeInTheDocument();
    expect(screen.getByText('It is no longer in the queue.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Ticket archived')).not.toBeInTheDocument();
  });

  it('auto-dismisses after its duration', async () => {
    render(
      <ToastProvider>
        <TransientToastTrigger />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await waitFor(
      () => {
        expect(screen.queryByText('Saved')).not.toBeInTheDocument();
      },
      { timeout: 1_000 },
    );
  });
});
