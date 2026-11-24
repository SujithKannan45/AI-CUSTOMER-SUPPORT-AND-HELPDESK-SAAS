import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';

describe('Button', () => {
  it('renders its label and defaults to a non-submitting button', () => {
    render(<Button>Save changes</Button>);

    const button = screen.getByRole('button', { name: 'Save changes' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toBeEnabled();
  });

  it('applies variant and size styling', () => {
    render(
      <Button variant="danger" size="sm">
        Delete
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveClass('bg-danger');
    expect(button).toHaveClass('h-8');
  });

  it('blocks interaction and reports a busy state while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button isLoading onClick={onClick}>
        Saving
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('calls onClick when enabled and not loading', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Approve</Button>);

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is reachable and activatable from the keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Reply</Button>);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Reply' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
