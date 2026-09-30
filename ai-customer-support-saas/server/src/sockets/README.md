# Real-time layer (prepared, not yet implemented)

The HTTP server in `server.ts` is created explicitly (`app.listen` returns the
`http.Server`) so Socket.IO can attach to the **same** port and process when
the real-time phase begins:

```ts
import { Server } from 'socket.io';
const io = new Server(httpServer, { path: env.SOCKET_PATH, cors: { origin: env.CORS_ALLOWED_ORIGINS } });
```

## Planned structure

```
sockets/
├── io.ts                  # Socket.IO bootstrap + shared instance accessor
├── auth.middleware.ts     # JWT handshake auth → socket.data { userId, workspaceId, role }
├── tenant.room.ts         # Room helpers: workspace:{id}, conversation:{id}
├── conversation.handlers.ts  # join/typing/message events
└── index.ts               # Event-type registry shared with the client
```

## Contracts (decided now, implemented later)

- **Auth**: handshake must carry a valid access token; connections without one
  are rejected. `socket.data` carries `userId`, `workspaceId`, `role`.
- **Tenancy**: every event handler resolves rooms as `workspace:{workspaceId}` /
  `conversation:{conversationId}`; a socket may only join rooms for its own
  workspace (same isolation rule as REST).
- **Client handoff**: the customer-facing chat widget and the agent inbox both
  subscribe to `conversation:{id}` rooms; human handoff flips conversation
  state, which the AI worker listens to.
- **Events** are typed via a shared `ClientToServerEvents` / `ServerToClientEvents`
  interface pair so client and server can never drift.

`VITE_SOCKET_URL` + `SOCKET_PATH` in `.env.example` are reserved for this phase.
