import { useRef, useState, type FormEvent, type JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { fieldDescribedBy } from '@/components/ui/field-ids';
import { ThemeToggle } from '@/layouts/components/theme-toggle';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { PasswordInput } from '@/features/auth/components/password-input';
import { authService } from '@/features/auth/auth.service';
import { describePasswordResetError } from '@/features/auth/auth.errors';
import {
  EMAIL_PATTERN,
  hasFieldErrors,
  validateResetPassword,
  type ResetPasswordFieldErrors,
} from '@/features/auth/validation';
import { ROUTES } from '@/app/routes/route-paths';

const PASSWORD_ID = 'reset-password-password';
const CONFIRM_ID = 'reset-password-confirm';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * `/reset-password?email=…&token=…` — the destination of the email the
 * backend sends. The token is validated for shape only; the server decides
 * whether it is live, and revokes every session when it is consumed.
 */
export function ResetPasswordPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const email = (searchParams.get('email') ?? '').trim();
  const token = searchParams.get('token') ?? '';
  const linkValid = EMAIL_PATTERN.test(email) && TOKEN_PATTERN.test(token);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<ResetPasswordFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(): Promise<void> {
    if (submittingRef.current || !linkValid) return;

    const nextErrors = validateResetPassword({ password, confirmPassword });
    setErrors(nextErrors);
    setFormError(null);
    if (hasFieldErrors(nextErrors)) {
      passwordRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await authService.resetPassword({ email, token, password });
      void navigate(ROUTES.login, {
        replace: true,
        state: { notice: 'Your password has been reset. Sign in with your new password.' },
      });
    } catch (error) {
      setFormError(describePasswordResetError(error));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (!linkValid) {
    return (
      <AuthShell
        title="Reset link unavailable"
        description="This page needs the one-time link from the password reset email."
        actions={<ThemeToggle />}
      >
        <div className="space-y-4">
          <Alert tone="error">
            This reset link is missing information or has been altered. Request a new link from the sign-in
            page.
          </Alert>
          <ButtonLink to={ROUTES.login} variant="outline" className="w-full">
            Back to sign in
          </ButtonLink>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      description={`Set a new password for ${email}. All other sessions will be signed out.`}
      actions={<ThemeToggle />}
    >
      <form
        noValidate
        aria-busy={isSubmitting}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void handleSubmit();
        }}
        className="space-y-4"
      >
        {formError !== null ? <Alert tone="error">{formError}</Alert> : null}

        <Field
          id={PASSWORD_ID}
          label="New password"
          description="At least 8 characters, including a letter and a digit."
          error={errors.password}
          required
        >
          <PasswordInput
            ref={passwordRef}
            id={PASSWORD_ID}
            name="new-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            disabled={isSubmitting}
            invalid={errors.password !== undefined}
            aria-describedby={fieldDescribedBy(PASSWORD_ID, {
              description: 'At least 8 characters, including a letter and a digit.',
              error: errors.password,
            })}
            onChange={(event) => {
              setPassword(event.target.value);
              setErrors((current) => ({ ...current, password: undefined }));
            }}
          />
        </Field>

        <Field id={CONFIRM_ID} label="Confirm new password" error={errors.confirmPassword} required>
          <PasswordInput
            id={CONFIRM_ID}
            name="confirm-password"
            autoComplete="new-password"
            value={confirmPassword}
            disabled={isSubmitting}
            invalid={errors.confirmPassword !== undefined}
            aria-describedby={fieldDescribedBy(CONFIRM_ID, { error: errors.confirmPassword })}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              setErrors((current) => ({ ...current, confirmPassword: undefined }));
            }}
          />
        </Field>

        <Button type="submit" className="w-full" isLoading={isSubmitting}>
          {isSubmitting ? 'Resetting…' : 'Reset password'}
        </Button>

        <p className="text-center text-sm text-muted">
          <ButtonLink to={ROUTES.login} variant="ghost" size="sm">
            Back to sign in
          </ButtonLink>
        </p>
      </form>
    </AuthShell>
  );
}
