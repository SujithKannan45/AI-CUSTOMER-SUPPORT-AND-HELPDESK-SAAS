import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from './tabs';

const TABS = [
  { id: 'overview', label: 'Overview', content: <p>Overview panel</p> },
  { id: 'activity', label: 'Activity', content: <p>Activity panel</p> },
  { id: 'internal', label: 'Internal', content: <p>Internal panel</p> },
] as const;

describe('Tabs', () => {
  it('selects the first tab by default and shows its panel', () => {
    render(<Tabs tabs={TABS} />);

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Overview panel');
  });

  it('switches panels on click', async () => {
    render(<Tabs tabs={TABS} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Activity panel')).toBeInTheDocument();
  });

  it('supports arrow-key navigation with a roving tabindex', async () => {
    render(<Tabs tabs={TABS} />);

    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveFocus();
    expect(overview).toHaveAttribute('tabindex', '-1');
  });

  it('wraps from the last tab back to the first with End then ArrowRight', async () => {
    render(<Tabs tabs={TABS} />);

    screen.getByRole('tab', { name: 'Overview' }).focus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Internal' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });
});
