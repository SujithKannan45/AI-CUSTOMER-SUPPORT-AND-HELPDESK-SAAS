import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { fieldDescribedBy } from '@/components/ui/field-ids';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/hooks/use-toast';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { describeWorkspaceCreateError } from '@/features/workspace/workspace.errors';
import type { WorkspaceDetailPayload } from '@/features/workspace/types';

const NAME_ID = 'create-workspace-name';
const NAME_MIN = 3;
const NAME_MAX = 100;

export interface CreateWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called only after the server confirmed creation. */
  onCreated?: (workspace: WorkspaceDetailPayload) => void;
}

/**
 * Create-workspace dialog (`POST /api/v1/workspaces`).
 *
 * The backend makes the authenticated caller the owner; the client only sends
 * the name. Nothing is added to the list until the server returns the created
 * workspace.
 */
export function CreateWorkspaceDialog({ open, onClose, onCreated }: CreateWorkspaceDialogProps): JSX.Element {
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setFieldError(undefined);
    setFormError(null);
  }, [open]);

  async function handleSubmit(): Promise<void> {
    if (isSubmitting) return;

    const trimmed = name.trim();
    if (trimmed.length < NAME_MIN) {
      setFieldError(`Use at least ${NAME_MIN} characters.`);
      return;
    }
    if (trimmed.length > NAME_MAX) {
      setFieldError(`Use at most ${NAME_MAX} characters.`);
      return;
    }

    setFieldError(undefined);
    setFormError(null);
    setIsSubmitting(true);

    try {
      const created = await createWorkspace({ name: trimmed });
      toast({ title: 'Workspace created', description: created.workspace.name, tone: 'success' });
      onCreated?.(created);
      onClose();
    } catch (error) {
      setFormError(describeWorkspaceCreateError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create workspace"
      description="You become the owner of a new workspace. Its URL slug is generated from the name."
      size="sm"
      // Focus must land in the name field, not on a close control, so the form
      // is usable immediately from the keyboard. Cancel and Escape still close.
      hideCloseButton
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
            Create workspace
          </Button>
        </>
      }
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
          id={NAME_ID}
          label="Workspace name"
          description="3–100 characters. Use your team or company name."
          error={fieldError}
          required
        >
          <Input
            id={NAME_ID}
            name="name"
            autoComplete="organization"
            autoFocus
            maxLength={NAME_MAX}
            placeholder="Acme Support"
            value={name}
            disabled={isSubmitting}
            invalid={fieldError !== undefined}
            aria-describedby={fieldDescribedBy(NAME_ID, {
              description: '3–100 characters. Use your team or company name.',
              error: fieldError,
            })}
            onChange={(event) => {
              setName(event.target.value);
              setFieldError(undefined);
            }}
          />
        </Field>
      </form>
    </Modal>
  );
}
