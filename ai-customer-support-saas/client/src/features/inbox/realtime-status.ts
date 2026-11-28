/**
 * Real-time availability — a documented seam, not a working transport.
 *
 * Verified in `server/src/sockets/README.md`: the real-time layer is PREPARED
 * but not implemented. There is no Socket.IO package in `server/package.json`,
 * no server instance attached in `server/src/server.ts`, and no event registry
 * (only the planned `ClientToServerEvents` / `ServerToClientEvents` pair is
 * documented). The backend does publish a module-local event seam
 * (`conversation.events.ts`) after a message is persisted, but nothing bridges
 * it to a socket.
 *
 * Consequently the inbox does NOT open a socket, does not poll, and does not
 * claim live updates. It shows this explicit status and offers a manual
 * refresh; the API server remains the only source of messages.
 *
 * Backend work still required before this can flip to `available: true`:
 *  1. install `socket.io` and attach it to the existing http.Server;
 *  2. JWT handshake auth middleware (reject anonymous connections);
 *  3. tenant room joins derived from the verified membership, never from a
 *     client-supplied workspace id;
 *  4. bridge the `conversationEventBus` message-created event to
 *     `conversation:{id}` rooms with body-free payloads;
 *  5. a shared event-type module the client can import.
 */
export interface RealtimeAvailability {
  readonly available: boolean;
  readonly label: string;
  readonly detail: string;
  readonly missingBackend: readonly string[];
}

export const inboxRealtime: RealtimeAvailability = {
  available: false,
  label: 'Live updates unavailable',
  detail:
    'This release has no Socket.IO server attached, so new messages are not pushed. Refresh to load messages sent by other people — your own sends appear immediately.',
  missingBackend: [
    'Socket.IO server bound to the existing HTTP server',
    'JWT handshake authentication for socket connections',
    'Workspace/conversation room authorization derived from membership',
    'Bridge from the conversation event bus to socket rooms',
    'Shared client/server event-type contract',
  ],
};
