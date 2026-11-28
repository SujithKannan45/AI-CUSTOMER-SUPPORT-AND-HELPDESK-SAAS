import { useEffect, useRef, type JSX } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Lock, MessagesSquare, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/feedback/states';
import { messageVariants } from '@/components/common/motion';
import { cn } from '@/utils/cn.util';
import { formatDateTime } from '@/utils/format-date.util';
import { senderLabel } from '../labels';
import type { MessageDto } from '../types';

export interface MessageListProps {
  readonly messages: readonly MessageDto[];
  readonly currentUserId: string | null;
  readonly hasEarlier: boolean;
  readonly loadingEarlier: boolean;
  readonly onLoadEarlier: () => void;
}

function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Chronological message thread.
 *
 * Privacy is a rendering rule as well as a server rule: `INTERNAL` notes are
 * visually distinct and labelled “Internal note · staff only”, and the backend
 * never returns them to a role without `conversation.reply` in the first place
 * (the exclusion happens inside the query). Message bodies are rendered as text
 * nodes — HTML in a message can never execute.
 *
 * New messages animate in through `AnimatePresence` (a short fade/rise), which
 * also gives the exit path for a message that is removed by a refresh. Reduced
 * motion users get the same DOM without transforms.
 */
export function MessageList({
  messages,
  currentUserId,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
}: MessageListProps): JSX.Element {
  const prefersReducedMotion = useReducedMotion();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view. `scrollIntoView` is optional so jsdom and
  // older engines simply skip it; nothing depends on scrolling succeeding.
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="px-3">
        <EmptyState
          icon={<MessagesSquare aria-hidden className="h-6 w-6" />}
          title="No messages yet"
          message="Nothing has been said in this conversation. Send the first reply below."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {hasEarlier ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={onLoadEarlier} isLoading={loadingEarlier}>
            Load earlier messages
          </Button>
        </div>
      ) : null}

      <div
        role="log"
        aria-label="Conversation messages"
        aria-live="polite"
        aria-relevant="additions"
        className="space-y-3"
      >
        <AnimatePresence initial={false}>
          {messages.map((message) => {
            const internal = message.visibility === 'INTERNAL';
            const fromAgent = message.senderType === 'AGENT';
            const own = currentUserId !== null && message.senderId === currentUserId;
            const attachmentBytes = message.attachments
              .map((attachment) => formatBytes(attachment.sizeBytes))
              .filter((size): size is string => size !== null);

            return (
              <motion.article
                key={message.id}
                variants={messageVariants(prefersReducedMotion === true)}
                initial="hidden"
                animate="visible"
                exit={{ opacity: 0 }}
                className={cn('flex', fromAgent ? 'justify-end' : 'justify-start')}
                aria-label={`${internal ? 'Internal note' : 'Message'} from ${senderLabel(message, currentUserId)}`}
              >
                <div
                  className={cn(
                    'max-w-[85%] rounded-xl border px-3 py-2 text-sm shadow-card sm:max-w-[75%]',
                    internal
                      ? 'border-dashed border-warning/50 bg-warning-soft text-foreground'
                      : fromAgent
                        ? 'border-transparent bg-primary text-primary-foreground'
                        : 'border-border bg-surface-subtle text-foreground',
                  )}
                >
                  <div
                    className={cn(
                      'mb-1 flex flex-wrap items-center gap-1.5 text-[11px]',
                      internal
                        ? 'text-warning-strong'
                        : fromAgent
                          ? 'text-primary-foreground/80'
                          : 'text-muted',
                    )}
                  >
                    <span className="font-semibold">{senderLabel(message, currentUserId)}</span>
                    {own ? <span className="sr-only"> (you)</span> : null}
                    <span aria-hidden>·</span>
                    <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)} UTC</time>
                    {internal ? (
                      <span className="inline-flex items-center gap-1 font-semibold">
                        <Lock aria-hidden className="h-3 w-3" />
                        Internal note · staff only
                      </span>
                    ) : null}
                  </div>

                  <p className="whitespace-pre-wrap break-words leading-6">{message.body}</p>

                  {message.attachments.length > 0 ? (
                    <ul className="mt-2 space-y-1 border-t border-border/40 pt-2 text-[11px]">
                      {message.attachments.map((attachment, index) => (
                        <li key={attachment.fileKey} className="flex items-center gap-1.5">
                          <Paperclip aria-hidden className="h-3 w-3" />
                          <span className="truncate">{attachment.filename}</span>
                          {attachmentBytes[index] !== undefined ? (
                            <span className="opacity-70">{attachmentBytes[index]}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </motion.article>
            );
          })}
        </AnimatePresence>
      </div>
      <div ref={bottomRef} aria-hidden className="h-px" />
    </div>
  );
}
