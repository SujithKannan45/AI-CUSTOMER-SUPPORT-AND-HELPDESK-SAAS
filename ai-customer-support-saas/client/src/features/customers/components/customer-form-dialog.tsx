import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { fieldDescribedBy } from '@/components/ui/field-ids';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { describeMutationError, fieldErrorsFrom } from '@/features/shared/errors';
import { customerService } from '../customer.service';
import {
  CUSTOMER_NAME_MAX,
  EMPTY_CUSTOMER_FORM,
  customerToFormValues,
  hasChanges,
  toCreateInput,
  toUpdateInput,
  validateCustomerForm,
  type CustomerFormErrors,
  type CustomerFormValues,
} from '../customer-form';
import type { CustomerDto } from '../types';

const FORM_FIELDS = ['name', 'email', 'phone', 'avatarUrl', 'status', 'tags'] as const;

export interface CustomerFormDialogProps {
  readonly open: boolean;
  readonly mode: 'create' | 'edit';
  readonly workspaceId: string;
  /** Required in edit mode; ignored when creating. */
  readonly customer: CustomerDto | null;
  readonly onClose: () => void;
  /** Called with the server-returned record after a successful save. */
  readonly onSaved: (customer: CustomerDto) => void;
}

/**
 * Create/edit customer dialog.
 *
 * Writes go through `POST`/`PATCH …/customers` only; the dialog never mutates
 * local list state itself — the caller refetches after `onSaved`. Validation
 * mirrors the server bounds, and a 422's per-field messages replace the local
 * ones, so the backend stays authoritative.
 */
export function CustomerFormDialog({
  open,
  mode,
  workspaceId,
  customer,
  onClose,
  onSaved,
}: CustomerFormDialogProps): JSX.Element {
  const { toast } = useToast();

  const [values, setValues] = useState<CustomerFormValues>(EMPTY_CUSTOMER_FORM);
  const [errors, setErrors] = useState<CustomerFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(mode === 'edit' && customer !== null ? customerToFormValues(customer) : EMPTY_CUSTOMER_FORM);
    setErrors({});
    setFormError(null);
    setIsSubmitting(false);
  }, [open, mode, customer]);

  function update<K extends keyof CustomerFormValues>(field: K, value: CustomerFormValues[K]): void {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  }

  async function handleSubmit(): Promise<void> {
    if (isSubmitting) return;

    const validationErrors = validateCustomerForm(values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      setFormError('Fix the highlighted fields before saving.');
      return;
    }

    setErrors({});
    setFormError(null);
    setIsSubmitting(true);

    try {
      if (mode === 'edit') {
        if (customer === null) return;
        const input = toUpdateInput(customer, values);
        if (!hasChanges(input)) {
          toast({ title: 'No changes to save', tone: 'info' });
          onClose();
          return;
        }
        const payload = await customerService.update(workspaceId, customer.id, input);
        toast({ title: 'Customer updated', description: payload.customer.name, tone: 'success' });
        onSaved(payload.customer);
      } else {
        const payload = await customerService.create(workspaceId, toCreateInput(values));
        toast({ title: 'Customer created', description: payload.customer.name, tone: 'success' });
        onSaved(payload.customer);
      }
      onClose();
    } catch (error) {
      setErrors(fieldErrorsFrom(error, FORM_FIELDS));
      setFormError(
        describeMutationError(error, {
          fallback: 'The customer could not be saved. Please try again.',
          conflict: 'A customer with this email already exists in this workspace.',
        }),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const nameDescription = `Required, ${CUSTOMER_NAME_MAX} characters or fewer.`;
  const tagsDescription = 'Comma-separated labels, e.g. “vip, billing”. A customer must carry all selected tags to match a tag filter.';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'New customer' : 'Edit customer'}
      description={
        mode === 'create'
          ? 'Create a customer record in this workspace.'
          : 'Update the customer record. Only changed fields are sent.'
      }
      size="lg"
      footer={
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
            {mode === 'create' ? 'Create customer' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="animate-page-enter">
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

          <Field id="customer-name" label="Name" description={nameDescription} error={errors.name} required>
            <Input
              id="customer-name"
              name="name"
              autoComplete="name"
              autoFocus
              maxLength={CUSTOMER_NAME_MAX}
              placeholder="Jordan Lee"
              value={values.name}
              disabled={isSubmitting}
              invalid={errors.name !== undefined}
              aria-describedby={fieldDescribedBy('customer-name', {
                description: nameDescription,
                ...(errors.name !== undefined ? { error: errors.name } : {}),
              })}
              onChange={(event) => {
                update('name', event.target.value);
              }}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="customer-email"
              label="Email"
              description="Optional. Unique per workspace."
              error={errors.email}
            >
              <Input
                id="customer-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="jordan@example.com"
                value={values.email}
                disabled={isSubmitting}
                invalid={errors.email !== undefined}
                aria-describedby={fieldDescribedBy('customer-email', {
                  description: 'Optional. Unique per workspace.',
                  ...(errors.email !== undefined ? { error: errors.email } : {}),
                })}
                onChange={(event) => {
                  update('email', event.target.value);
                }}
              />
            </Field>

            <Field id="customer-phone" label="Phone" description="Optional, up to 20 characters." error={errors.phone}>
              <Input
                id="customer-phone"
                name="phone"
                type="tel"
                autoComplete="tel"
                placeholder="+1 555 010 0100"
                value={values.phone}
                disabled={isSubmitting}
                invalid={errors.phone !== undefined}
                aria-describedby={fieldDescribedBy('customer-phone', {
                  description: 'Optional, up to 20 characters.',
                  ...(errors.phone !== undefined ? { error: errors.phone } : {}),
                })}
                onChange={(event) => {
                  update('phone', event.target.value);
                }}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="customer-status" label="Status" error={errors.status}>
              <Select
                id="customer-status"
                value={values.status}
                disabled={isSubmitting}
                onChange={(event) => {
                  update('status', event.target.value === 'blocked' ? 'blocked' : 'active');
                }}
              >
                <option value="active">Active</option>
                <option value="blocked">Blocked</option>
              </Select>
            </Field>

            <Field id="customer-avatar" label="Avatar URL" description="Optional absolute http(s) URL." error={errors.avatarUrl}>
              <Input
                id="customer-avatar"
                name="avatarUrl"
                type="url"
                placeholder="https://example.com/avatar.png"
                value={values.avatarUrl}
                disabled={isSubmitting}
                invalid={errors.avatarUrl !== undefined}
                aria-describedby={fieldDescribedBy('customer-avatar', {
                  description: 'Optional absolute http(s) URL.',
                  ...(errors.avatarUrl !== undefined ? { error: errors.avatarUrl } : {}),
                })}
                onChange={(event) => {
                  update('avatarUrl', event.target.value);
                }}
              />
            </Field>
          </div>

          <Field id="customer-tags" label="Tags" description={tagsDescription} error={errors.tags}>
            <Input
              id="customer-tags"
              name="tags"
              placeholder="vip, billing"
              value={values.tags}
              disabled={isSubmitting}
              invalid={errors.tags !== undefined}
              aria-describedby={fieldDescribedBy('customer-tags', {
                description: tagsDescription,
                ...(errors.tags !== undefined ? { error: errors.tags } : {}),
              })}
              onChange={(event) => {
                update('tags', event.target.value);
              }}
            />
          </Field>

          {mode === 'edit' ? (
            <p className="text-xs leading-5 text-muted">
              Clearing an optional field removes that value from the record. Custom metadata keys are
              read-only in this release.
            </p>
          ) : null}
        </form>
      </div>
    </Modal>
  );
}
