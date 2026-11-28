import { useRef, useState, type JSX } from 'react';
import { Lock, Send } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { describeMutationError } from '@/features/shared/errors';
import { cn } from '@/utils/cn.util';
import { MESSAGE_BODY_MAX_LENGTH, type MessageVisibility } from '../types';

export interface MessageComposerProps {
  /** False for roles without `conversation.reply`, and for agents outside the cap. */
  readonly canReply: boolean;
  readonly readOnlyReason: string | null;
  /** Parent performs the request; it MUST throw on failure so the text is kept. */
  readonly onSend: (body: string, visibility: MessageVisibility) => Promise<void>;
}

const MODES: readonly { readonly value: MessageVisibility; readonly label: string }[] = [
  { value: 'PUBLIC', label: 'Reply to customer' },
  { value: 'INTERNAL', label: 'Internal note' },
];

/**
 * Message composer.
 *
 * - Empty/whitespace-only bodies are rejected locally and focus returns to the
 *   textarea; the server's 422 remains the authority if anything else fails.
 * - Duplicate submission is blocked twice over: the submit handler returns while
 *   a send is in flight and the button is disabled while it runs.
 * - The text is cleared ONLY after the server confirms; a failed send keeps
 *   what was typed and shows status-derived error copy.
 * - Enter inserts a newline (multi-line notes), Ctrl/⌘+Enter sends.
 * - Internal notes are a visibly different mode with their own label, and the
 *   note banner states the audience. The server authorizes the visibility; the
 *   UI never sends an internal note through a public-reply field.
 */
export function MessageComposer({ canReply, readOnlyReason, onSend }: MessageComposerProps): JSX.Element {
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<MessageVisibility>('PUBLIC');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  if (!canReply) {
    return (
      <div className="border-t border-border bg-surface-subtle px-3 py-3">
        <p className="text-sm text-muted">
          {readOnlyReason ?? 'You do not have permission to send messages in this conversation.'}
        </p>
      </div>
    );
  }

  const internal = visibility === 'INTERNAL';

  async function submit(): Promise<void> {
    if (sending) return;

    const trimmed = body.trim();
    if (trimmed.length === 0) {
      setError('Write a message before sending.');
      textareaRef.current?.focus();
      return;
    }
    if (trimmed.length > MESSAGE_BODY_MAX_LENGTH) {
      setError(`Messages are limited to ${MESSAGE_BODY_MAX_LENGTH} characters.`);
      textareaRef.current?.focus();
      return;
    }

    setSending(true);
    setError(null);
    try {
      await onSend(trimmed, visibility);
      // Confirmed by the server — only now is it safe to clear the draft.
      setBody('');
    } catch (caught) {
      setError(
        describeMutationError(caught, {
          fallback: 'Your message was not sent. Please try again.',
          notFound: 'This conversation no longer exists in the current workspace.',
        }),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="space-y-2 border-t border-border bg-surface px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div role="group" aria-label="Message visibility" className="flex flex-wrap gap-1">
        {MODES.map((mode) => {
          const active = visibility === mode.value;
          return (
            <button
              key={mode.value}
              type="button"
              aria-pressed={active}
              disabled={sending}
              onClick={() => {
                setVisibility(mode.value);
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                active
                  ? mode.value === 'INTERNAL'
                    ? 'border-warning/50 bg-warning-soft text-warning-strong'
                    : 'border-primary bg-primary-soft text-primary'
                  : 'border-border bg-surface text-muted hover:bg-surface-hover hover:text-foreground',
              )}
            >
              {mode.value === 'INTERNAL' ? <Lock aria-hidden className="h-3 w-3" /> : null}
              {mode.label}
            </button>
          );
        })}
      </div>

      {internal ? (
        <Alert tone="warning" title="Internal note">
          Visible to workspace staff only. The customer never receives it.
        </Alert>
      ) : null}

      <label htmlFor="composer-body" className="sr-only">
        {internal ? 'Internal note' : 'Reply to customer'}
      </label>
      <textarea
        id="composer-body"
        ref={textareaRef}
        rows={3}
        value={body}
        disabled={sending}
        aria-describedby="composer-hint"
        aria-invalid={error !== null || undefined}
        placeholder={internal ? 'Add a note for your team…' : 'Write a reply to the customer…'}
        onChange={(event) => {
          setBody(event.target.value);
          if (error !== null) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        className={cn(
          'w-full resize-y rounded-lg border bg-surface px-3 py-2 text-sm leading-6 text-foreground placeholder:text-muted transition-colors duration-150 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-surface-subtle',
          internal
            ? 'border-warning/50 focus:border-warning focus:ring-warning-soft'
            : 'border-border-strong focus:border-primary focus:ring-primary-soft',
          error !== null && 'border-danger focus:border-danger focus:ring-danger-soft',
        )}
      />

      {error !== null ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="composer-hint" className="text-xs text-muted">
          Ctrl/⌘ + Enter sends · {body.length}/{MESSAGE_BODY_MAX_LENGTH}
        </p>
        <Button type="submit" size="sm" isLoading={sending} disabled={sending} rightIcon={<Send aria-hidden className="h-3.5 w-3.5" />}>
          {internal ? 'Add note' : 'Send reply'}
        </Button>
      </div>
    </form>
  );
}
