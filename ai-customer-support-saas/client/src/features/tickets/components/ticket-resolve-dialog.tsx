import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { fieldDescribedBy } from '@/components/ui/field-ids';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/input';
import { describeMutationError } from '@/features/shared/errors';
import { ticketService } from '../ticket.service';
import { TICKET_RESOLUTION_NOTE_MAX, type TicketDto, type TicketDetailPayload } from '../types';

const NOTE_ID = 'ticket-resolution-note';

export interface TicketResolveDialogProps {
  readonly open: boolean;
  readonly workspaceId: string;
  readonly ticket: TicketDto;
  readonly onClose: () => void;
  readonly onResolved: (payload: TicketDetailPayload) => void;
}

/**
 * Resolve dialog (`POST …/tickets/:id/resolve`).
 *
 * The note is optional on the server, so an empty note resolves without one.
 * The submit path is guarded against duplicate requests.
 */
export function TicketResolveDialog({
  open,
  workspaceId,
  ticket,
  onClose,
  onResolved,
}: TicketResolveDialogProps): JSX.Element {
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNote('');
    setFormError(null);
    setIsSubmitting(false);
  }, [open, ticket.id]);

  async function handleSubmit(): Promise<void> {
    if (isSubmitting) return;

    const trimmed = note.trim();
    if (trimmed.length > TICKET_RESOLUTION_NOTE_MAX) {
      setFormError(`Use at most ${TICKET_RESOLUTION_NOTE_MAX} characters.`);
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const payload = await ticketService.resolve(
        workspaceId,
        ticket.id,
        trimmed.length > 0 ? trimmed : undefined,
      );
      onResolved(payload);
      onClose();
    } catch (error) {
      setFormError(
        describeMutationError(error, {
          fallback: 'The ticket could not be resolved. Please try again.',
          conflict: 'This ticket cannot move to Resolved from its current state. Reload and try again.',
        }),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const description = `Optional plain-text note, up to ${TICKET_RESOLUTION_NOTE_MAX.toLocaleString('en-US')} characters. It is stored on the ticket as its resolution note.`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Resolve ${ticket.number}`}
      description="The server moves the ticket to Resolved and stamps the resolution time."
      size="md"
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
            Resolve ticket
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

        <p className="text-sm leading-6 text-foreground">{ticket.subject}</p>

        <Field id={NOTE_ID} label="Resolution note" description={description}>
          <Textarea
            id={NOTE_ID}
            name="resolutionNote"
            rows={4}
            maxLength={TICKET_RESOLUTION_NOTE_MAX}
            placeholder="What fixed this for the customer?"
            value={note}
            disabled={isSubmitting}
            aria-describedby={fieldDescribedBy(NOTE_ID, { description })}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </Field>
      </form>
    </Modal>
  );
}
