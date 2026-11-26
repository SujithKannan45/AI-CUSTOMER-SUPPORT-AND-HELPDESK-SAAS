import { describe, expect, it } from 'vitest';
import { makeCustomer } from '@/test/fixtures';
import {
  EMPTY_CUSTOMER_FORM,
  customerToFormValues,
  hasChanges,
  parseTags,
  toCreateInput,
  toUpdateInput,
  validateCustomerForm,
} from './customer-form';

describe('customer form', () => {
  it('requires a name and rejects malformed email and avatar URL', () => {
    const errors = validateCustomerForm({
      ...EMPTY_CUSTOMER_FORM,
      name: '   ',
      email: 'not-an-email',
      avatarUrl: 'javascript:alert(1)',
    });

    expect(errors.name).toBeDefined();
    expect(errors.email).toContain('valid email');
    expect(errors.avatarUrl).toContain('http(s)');
  });

  it('accepts a complete record and parses duplicate tags', () => {
    const errors = validateCustomerForm({
      ...EMPTY_CUSTOMER_FORM,
      name: 'Jordan Lee',
      email: 'jordan@example.com',
      phone: '+1 555 010 0100',
      avatarUrl: 'https://example.com/a.png',
      tags: ' vip, billing , vip ',
    });

    expect(errors).toEqual({});
    expect(parseTags(' vip, billing , vip ')).toEqual(['vip', 'billing']);
  });

  it('bounds the tag count', () => {
    const tags = Array.from({ length: 21 }, (_, index) => `tag-${index}`).join(',');
    expect(validateCustomerForm({ ...EMPTY_CUSTOMER_FORM, name: 'A', tags }).tags).toContain('20');
  });

  it('omits blank optional fields when creating and lowercases the email', () => {
    const input = toCreateInput({
      ...EMPTY_CUSTOMER_FORM,
      name: '  Jordan Lee ',
      email: ' Jordan@Example.com ',
      tags: 'vip',
    });

    expect(input).toEqual({
      name: 'Jordan Lee',
      status: 'active',
      email: 'jordan@example.com',
      tags: ['vip'],
    });
    expect('phone' in input).toBe(false);
    expect('avatarUrl' in input).toBe(false);
  });

  it('sends only changed fields and an explicit null when clearing', () => {
    const customer = makeCustomer();
    const values = { ...customerToFormValues(customer), name: 'Jordan Lee Jr', email: '  ' };

    const input = toUpdateInput(customer, values);

    expect(input).toEqual({ name: 'Jordan Lee Jr', email: null });
    expect(hasChanges(input)).toBe(true);
  });

  it('produces an empty patch when nothing changed', () => {
    const customer = makeCustomer();
    expect(toUpdateInput(customer, customerToFormValues(customer))).toEqual({});
  });
});
