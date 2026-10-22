import { Router } from 'express';

import { env } from '../config/env.config.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import {
  conversationRouter,
  ticketConversationRouter,
} from '../modules/conversations/conversation.routes.js';
import { customerRouter } from '../modules/customers/customer.routes.js';
import { ticketRouter } from '../modules/tickets/ticket.routes.js';
import { workspaceRouter } from '../modules/workspaces/workspace.routes.js';

/**
 * Versioned API root. Feature-module routers are mounted here as they are
 * implemented (auth, workspaces, and future modules).
 *
 * Keeping one assembly point prevents route sprawl and gives every endpoint a
 * consistent `/api/v1/...` prefix.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/workspaces', workspaceRouter);
apiRouter.use('/workspaces/:workspaceId/customers', customerRouter);
apiRouter.use('/workspaces/:workspaceId/tickets', ticketRouter);
// Conversation routes nest under the SAME tenant context: the ticket-scoped
// get-or-create/list endpoints under `/tickets/:ticketId/conversations`, and
// top-level `/conversations` for message threading (mergeParams carries the
// parent's `:workspaceId` into every request).
apiRouter.use('/workspaces/:workspaceId/tickets', ticketConversationRouter);
apiRouter.use('/workspaces/:workspaceId/conversations', conversationRouter);
// Customer routes nest under the workspace tenant context:
// `/api/v1/workspaces/:workspaceId/customers` carries the parent's
// `:workspaceId` param (mergeParams) so every customer request is scoped by
// the same validated workspace-context middleware.
apiRouter.get('/', (_req, res) => {
  res.json({
    name: 'AI Customer Support SaaS API',
    version: '1.0.0',
    environment: env.NODE_ENV,
  });
});
