import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { fieldDescribedBy } from '@/components/ui/field-ids';
import { Input } from '@/components/ui/input';
import { useSessionStore } from '@/features/auth/auth.store';
import { authService } from '@/features/auth/auth.service';
import { describeSignInError } from '@/features/auth/auth.errors';
import { postLoginDestination } from '@/features/auth/redirect';
import { hasFieldErrors, validateSignIn, type SignInFieldErrors } from '@/features/auth/validation';
import { PasswordInput } from './password-input';
import { ForgotPasswordDialog } from './forgot-password-dialog';

const EMAIL_ID = 'sign-in-email';
const PASSWORD_ID = 'sign-in-password';

/**
 * Sign-in form.
 *
 * The server is the credential authority: this form only trims the email,
 * blocks obviously incomplete input, and renders safe copy for whatever the
 * API returns. On success it starts the in-memory session and routes to the
 * original protected URL; `RequireWorkspace` loads the tenant list and sends
 * accounts without a membership to the picker.
 */
export interface SignInFormProps {
  notice?: string;
  /** Called when a well-formed submission starts (lets the page skip its redirect). */
  onAuthStart?: () => void;
}

export function SignInForm({ notice, onAuthStart }: SignInFormProps): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const startSession = useSessionStore((state) => state.startSession);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<SignInFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  const submittingRef = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      submittingRef.current = false;
    };
  }, []);

  async function handleSubmit(): Promise<void> {
    if (submittingRef.current) return;

    const nextErrors = validateSignIn({ email, password });
    setErrors(nextErrors);
    setFormError(null);

    if (hasFieldErrors(nextErrors)) {
      (nextErrors.email !== undefined ? emailRef : passwordRef).current?.focus();
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    onAuthStart?.();

    try {
      const payload = await authService.login({ email: email.trim(), password });
      startSession({ user: payload.user, accessToken: payload.tokens.accessToken });

      void navigate(postLoginDestination(location.state), { replace: true });
    } catch (error) {
      setFormError(describeSignInError(error));
      setPassword('');
      passwordRef.current?.focus();
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  function clearError(field: keyof SignInFieldErrors): void {
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  return (
    <>
      <form
        noValidate
        aria-busy={isSubmitting}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void handleSubmit();
        }}
        className="space-y-4"
      >
        {notice !== undefined ? <Alert tone="success">{notice}</Alert> : null}
        {formError !== null ? <Alert tone="error">{formError}</Alert> : null}

        <Field id={EMAIL_ID} label="Work email" error={errors.email} required>
          <Input
            ref={emailRef}
            id={EMAIL_ID}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            placeholder="you@company.com"
            value={email}
            disabled={isSubmitting}
            invalid={errors.email !== undefined}
            aria-describedby={fieldDescribedBy(EMAIL_ID, { error: errors.email })}
            onChange={(event) => {
              setEmail(event.target.value);
              clearError('email');
            }}
          />
        </Field>

        <Field id={PASSWORD_ID} label="Password" error={errors.password} required>
          <PasswordInput
            ref={passwordRef}
            id={PASSWORD_ID}
            name="password"
            autoComplete="current-password"
            value={password}
            disabled={isSubmitting}
            invalid={errors.password !== undefined}
            aria-describedby={fieldDescribedBy(PASSWORD_ID, { error: errors.password })}
            onChange={(event) => {
              setPassword(event.target.value);
              clearError('password');
            }}
          />
        </Field>

        <div className="-mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => {
              setForgotOpen(true);
            }}
            className="rounded text-sm font-medium text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Forgot password?
          </button>
        </div>

        <Button type="submit" className="w-full" isLoading={isSubmitting} rightIcon={<ArrowRight aria-hidden className="h-4 w-4" />}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <ForgotPasswordDialog
        open={forgotOpen}
        initialEmail={email}
        onClose={() => {
          setForgotOpen(false);
        }}
      />
    </>
  );
}
