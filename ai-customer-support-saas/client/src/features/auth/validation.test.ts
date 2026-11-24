import { describe, expect, it } from 'vitest';
import { hasFieldErrors, validateEmail, validateResetPassword, validateSignIn } from './validation';

describe('auth validation', () => {
  it('requires an email and a password', () => {
    const errors = validateSignIn({ email: '   ', password: '' });

    expect(errors.email).toBe('Enter your email address.');
    expect(errors.password).toBe('Enter your password.');
    expect(hasFieldErrors(errors)).toBe(true);
  });

  it('rejects a malformed email and accepts a trimmed valid one', () => {
    expect(validateEmail('not-an-email')).toBe('Enter a valid email address.');
    expect(validateEmail(' ada@example.com ')).toBeUndefined();
    expect(validateSignIn({ email: ' ada@example.com ', password: 'secret' })).toEqual({});
  });

  it('does not trim or rewrite the password', () => {
    const errors = validateSignIn({ email: 'ada@example.com', password: '   ' });

    expect(errors.password).toBeUndefined();
  });

  it('applies the backend password policy and confirmation match', () => {
    expect(validateResetPassword({ password: 'short1', confirmPassword: 'short1' }).password).toBe(
      'Use at least 8 characters.',
    );
    expect(validateResetPassword({ password: 'lettersonly', confirmPassword: 'lettersonly' }).password).toBe(
      'Include at least one digit.',
    );
    expect(validateResetPassword({ password: 'letters1', confirmPassword: 'letters2' }).confirmPassword).toBe(
      'Passwords do not match.',
    );
    expect(validateResetPassword({ password: 'letters1', confirmPassword: 'letters1' })).toEqual({});
  });
});
