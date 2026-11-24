import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox, Switch } from './checkbox';

function SwitchHarness() {
  const [checked, setChecked] = useState(false);
  return <Switch checked={checked} onCheckedChange={setChecked} label="Email digest" description="Send a daily summary." />;
}

describe('Checkbox', () => {
  it('toggles from its label and exposes the description', async () => {
    render(<Checkbox label="Notify on assignment" description="Sends an in-app notification." />);

    const checkbox = screen.getByRole('checkbox', { name: 'Notify on assignment' });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAccessibleDescription('Sends an in-app notification.');

    await userEvent.click(screen.getByText('Notify on assignment'));
    expect(checkbox).toBeChecked();
  });
});

describe('Switch', () => {
  it('is a switch with its own accessible label and description', () => {
    render(<SwitchHarness />);

    const toggle = screen.getByRole('switch', { name: 'Email digest' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription('Send a daily summary.');
  });

  it('toggles on click and with the keyboard', async () => {
    render(<SwitchHarness />);
    const toggle = screen.getByRole('switch', { name: 'Email digest' });

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    toggle.focus();
    await userEvent.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
