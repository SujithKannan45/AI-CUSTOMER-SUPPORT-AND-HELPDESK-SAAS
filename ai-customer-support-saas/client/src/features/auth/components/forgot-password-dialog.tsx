import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { MailCheck } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { fieldDescribedBy } from '@/components/ui/field-ids';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { authService } from '@/features/auth/auth.service';
import { describePasswordResetRequestError } from '@/features/auth/auth.errors';
import { validateEmail } from '@/features/auth/validation';

const EMAIL_ID = 'forgot-password-email';

export interface ForgotPasswordDialogProps {
  open: boolean;
  onClose: () => void;
  initialEmail?: string;
}

/**
 * Password-reset request dialog.
 *
 * The backend exposes `POST /api/v1/auth/forgot-password` and deliberately
 * returns the same `{ queued: true }` answer for every address (no account
 * enumeration), so the confirmation copy mirrors that: "if an account exists".
 */
export function ForgotPasswordDialog({ open, onClose, initialEmail = '' }: ForgotPasswordDialogProps): JSX.Element {
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail(initialEmail);
    setError(undefined);
    setFormError(null);
    setSentTo(null);
  }, [open, initialEmail]);

  async function handleSubmit(): Promise<void> {
    if (isSubmitting) return;

    const emailError = validateEmail(email);
    setError(emailError);
    setFormError(null);
    if (emailError !== undefined) return;

    setIsSubmitting(true);
    const target = email.trim();
    try {
      await authService.requestPasswordReset(target);
      setSentTo(target);
    } catch (requestError) {
      setFormError(describePasswordResetRequestError(requestError));
    } finally {
      setIsSubmitting(false);
    }
  }

  const sent = sentTo !== null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reset your password"
      description={
        sent
          ? undefined
          : 'Enter the email address you sign in with and we will send a one-time reset link.'
      }
      // Keep initial focus on the email field; Cancel and Escape close the dialog.
      hideCloseButton
      footer={
        sent ? (
          <Button onClick={onClose}>Back to sign in</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              isLoading={isSubmitting}
              onClick={() => {
                void handleSubmit();
              }}
            >
              Send reset link
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <div className="space-y-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success-soft">
            <MailCheck aria-hidden className="h-5 w-5 text-success" />
          </div>
          <p className="text-sm leading-6 text-foreground">
            If an account exists for <span className="font-medium">{sentTo}</span>, a reset link is on its
            way.
          </p>
          <p className="text-sm leading-6 text-muted">
            The link can be used once and expires. Nothing arrived? Check spam, or ask a workspace owner to
            confirm the address on your account.
          </p>
        </div>
      ) : (
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
          <Field id={EMAIL_ID} label="Email" error={error} required>
            <Input
              id={EMAIL_ID}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              placeholder="you@company.com"
              value={email}
              disabled={isSubmitting}
              invalid={error !== undefined}
              aria-describedby={fieldDescribedBy(EMAIL_ID, { error })}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(undefined);
              }}
            />
          </Field>
        </form>
      )}
    </Modal>
  );
}
