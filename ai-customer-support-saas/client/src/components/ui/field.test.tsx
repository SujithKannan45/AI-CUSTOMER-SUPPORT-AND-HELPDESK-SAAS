import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from './field';
import { fieldDescribedBy } from './field-ids';
import { Input } from './input';

describe('Field', () => {
  it('links label, description and error to the control', () => {
    render(
      <Field id="email" label="Email" description="We reply to this address." error="Email is required" required>
        <Input
          id="email"
          aria-describedby={fieldDescribedBy('email', {
            description: 'We reply to this address.',
            error: 'Email is required',
          })}
          required
        />
      </Field>,
    );

    const input = screen.getByLabelText(/Email/);
    expect(input).toHaveAttribute('aria-describedby', 'email-description email-error');
    expect(input).toBeRequired();
    expect(screen.getByText('We reply to this address.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Email is required');
  });

  it('omits the description and error nodes when they are not provided', () => {
    render(
      <Field id="subject" label="Subject">
        <Input id="subject" />
      </Field>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fieldDescribedBy('subject', {})).toBeUndefined();
  });

  it('marks invalid inputs for assistive technology', () => {
    render(<Input aria-label="Search query" invalid />);

    const input = screen.getByRole('textbox', { name: 'Search query' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveClass('border-danger');
  });
});
