import type { JSX } from 'react';
import { Lock, MessageSquarePlus, RotateCw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useToast } from '@/hooks/use-toast';
import type { TicketDto } from '@/features/tickets/types';
import { inboxService } from '../inbox.service';
import type { MessageVisibility } from '../types';
import { useConversationMessages } from '../use-conversation-messages';
import { useTicketConversation } from '../use-ticket-conversation';
import { ConversationHeader } from './conversation-header';
import { MessageComposer } from './message-composer';
import { MessageList } from './message-list';

export interface ConversationPanelProps {
  readonly workspaceId: string;
  readonly ticket: TicketDto;
  readonly currentUserId: string | null;
  readonly canReply: boolean;
  readonly readOnlyReason: string | null;
  readonly showBack: boolean;
  readonly onBack: () => void;
  /**
   * Called after a confirmed write (a sent message, or a conversation that was
   * just created) so the list and the conversation count can refresh.
   */
  readonly onActivity: () => void;
}

function MessageSkeleton(): JSX.Element {
  return (
    <div role="status" aria-live="polite" className="space-y-3 px-3 py-3">
      <span className="sr-only">Loading messages…</span>
      <div className="flex justify-start">
        <Skeleton className="h-16 w-2/3" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-20 w-3/5" />
      </div>
      <div className="flex justify-start">
        <Skeleton className="h-12 w-1/2" />
      </div>
    </div>
  );
}

/**
 * Selected conversation: header, message thread and composer.
 *
 * Data flow is deliberately READ-THEN-WRITE against the API only — there is no
 * socket transport in this release (see `realtime-status.ts`), so the panel
 * offers an explicit refresh and never pretends to be live.
 *
 * A ticket with no conversation resolves to an explicit "start" state: the
 * conversation is created by `POST …/tickets/:id/conversations`, which the
 * server gates with `conversation.reply` and audits. Nothing is fabricated to
 * fill the panel.
 */
export function ConversationPanel({
  workspaceId,
  ticket,
  currentUserId,
  canReply,
  readOnlyReason,
  showBack,
  onBack,
  onActivity,
}: ConversationPanelProps): JSX.Element {
  const thread = useTicketConversation(workspaceId, ticket.id);
  const conversationId = thread.conversation?.id ?? null;
  const messages = useConversationMessages(workspaceId, conversationId);
  const { toast } = useToast();

  async function send(body: string, visibility: MessageVisibility): Promise<void> {
    if (conversationId === null) {
      // The composer is only rendered with a conversation; this guards races.
      throw new Error('No conversation is available for this ticket');
    }

    const payload = await inboxService.sendMessage(workspaceId, conversationId, {
      body,
      visibility,
    });

    // The server's own record is appended (never a locally fabricated one) and
    // id-deduplicated, so a later refresh cannot double it.
    messages.appendMessage(payload.message);
    toast({
      title: visibility === 'INTERNAL' ? 'Internal note added' : 'Reply sent',
      description:
        visibility === 'INTERNAL'
          ? `${ticket.number} · visible to workspace staff only`
          : `${ticket.number} · visible to the customer`,
      tone: 'success',
    });
    thread.refresh();
    onActivity();
  }

  return (
    <section
      aria-label={`Conversation for ${ticket.number}`}
      className="flex h-[calc(100dvh-15rem)] min-h-[24rem] flex-col overflow-hidden rounded-xl border border-border bg-surface lg:h-[calc(100dvh-12rem)]"
    >
      <ConversationHeader
        workspaceId={workspaceId}
        ticket={ticket}
        conversation={thread.conversation}
        showBack={showBack}
        onBack={onBack}
      />

      <div className="flex flex-1 flex-col overflow-y-auto">
        {thread.status === 'loading' ? (
          <MessageSkeleton />
        ) : thread.status === 'error' ? (
          thread.forbidden ? (
            <EmptyState
              icon={<Lock aria-hidden className="h-6 w-6 text-warning" />}
              title="Conversation access required"
              message="Your role cannot read conversations in this workspace. Ask a workspace administrator for access."
            />
          ) : (
            <ErrorState
              title="Conversation unavailable"
              message={thread.error ?? 'This conversation could not be loaded.'}
              onRetry={thread.refresh}
            />
          )
        ) : thread.status === 'invalid' ? (
          <EmptyState
            icon={<MessageSquarePlus aria-hidden className="h-6 w-6" />}
            title="Invalid conversation link"
            message="This address does not contain a valid ticket identifier."
          />
        ) : thread.status === 'none' ? (
          <div className="px-3">
            <EmptyState
              icon={<MessageSquarePlus aria-hidden className="h-6 w-6" />}
              title="No conversation yet"
              message={
                canReply
                  ? 'This ticket has no messages. Start its conversation to reply to the customer or add an internal note.'
                  : 'This ticket has no messages yet. A workspace member with reply permission can start the conversation.'
              }
              action={
                canReply ? (
                  <Button
                    size="sm"
                    isLoading={thread.starting}
                    disabled={thread.starting}
                    onClick={() => {
                      // Starting a conversation CREATES a record, so the list
                      // (recent-activity order) and the workspace conversation
                      // count must be re-read once the server confirms it.
                      void thread.start().then((started) => {
                        if (started) onActivity();
                      });
                    }}
                  >
                    Start conversation
                  </Button>
                ) : undefined
              }
            />
            {thread.startError !== null ? (
              <div className="pb-4">
                <Alert tone="error">{thread.startError}</Alert>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
              <p className="text-xs text-muted" aria-live="polite">
                {messages.status === 'ready'
                  ? `${messages.messages.length} ${messages.messages.length === 1 ? 'message' : 'messages'} loaded${messages.hasEarlier ? ' · earlier messages available' : ''}`
                  : 'Loading messages…'}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={messages.refresh}
                isLoading={messages.status === 'loading'}
                leftIcon={<RotateCw aria-hidden className="h-3.5 w-3.5" />}
              >
                Refresh
              </Button>
            </div>

            {messages.status === 'error' ? (
              messages.forbidden ? (
                <EmptyState
                  icon={<Lock aria-hidden className="h-6 w-6 text-warning" />}
                  title="Message access required"
                  message="Your role cannot read messages in this workspace."
                />
              ) : (
                <ErrorState
                  title="Messages unavailable"
                  message={messages.error ?? 'The message thread could not be loaded.'}
                  onRetry={messages.refresh}
                />
              )
            ) : messages.status === 'loading' ? (
              <MessageSkeleton />
            ) : (
              <MessageList
                messages={messages.messages}
                currentUserId={currentUserId}
                hasEarlier={messages.hasEarlier}
                loadingEarlier={messages.loadingEarlier}
                onLoadEarlier={messages.loadEarlier}
              />
            )}
          </>
        )}
      </div>

      {conversationId !== null ? (
        <MessageComposer canReply={canReply} readOnlyReason={readOnlyReason} onSend={send} />
      ) : null}
    </section>
  );
}
