import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pagination } from './pagination';

describe('Pagination', () => {
  it('summarises the visible range and marks the current page', () => {
    render(<Pagination page={2} pageSize={10} total={35} onPageChange={vi.fn()} itemLabel="tickets" />);

    expect(screen.getByText(/Showing/)).toHaveTextContent('Showing 11–20 of 35 tickets');
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
  });

  it('reports the neighbouring pages', async () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageSize={10} total={35} onPageChange={onPageChange} />);

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(3);

    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('disables the direction that would leave the range', () => {
    render(<Pagination page={1} pageSize={10} total={35} onPageChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
  });

  it('handles an empty result set without offering navigation', () => {
    render(<Pagination page={1} pageSize={10} total={0} onPageChange={vi.fn()} />);

    expect(screen.getByText(/Showing/)).toHaveTextContent('Showing 0–0 of 0 results');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});
