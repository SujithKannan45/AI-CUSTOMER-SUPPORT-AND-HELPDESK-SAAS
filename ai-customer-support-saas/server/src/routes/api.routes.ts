import { Router } from 'express';

import { env } from '../config/env.config.js';
import { agentRouter } from '../modules/agent/agent.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import {
  conversationRouter,
  ticketConversationRouter,
} from '../modules/conversations/conversation.routes.js';
import { customerRouter } from '../modules/customers/customer.routes.js';
import { documentRouter } from '../modules/documents/document.routes.js';
import { publicKnowledgeBaseRouter } from '../modules/knowledge-base/kb-public.routes.js';
import { knowledgeBaseRouter } from '../modules/knowledge-base/kb.routes.js';
import { ragRouter } from '../modules/rag/rag.routes.js';
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
// Knowledge Base routes nest under the SAME tenant context (mergeParams
// carries the workspace param): `/knowledge-base/categories` and
// `/knowledge-base/articles(…/revisions)` for staff, and a DETACHED public
// read router under `/public/knowledge-base/:workspaceSlug` (anonymous,
// published-only — see kb-public.routes.ts for the safety composition).
apiRouter.use('/workspaces/:workspaceId/knowledge-base', knowledgeBaseRouter);
// Document/file routes nest under the SAME workspace tenant context: the
// router itself owns the `/files…` subpaths (uploads, downloads and
// processing-state reads). No public file surface exists — file bytes are
// only behind authenticated routes.
apiRouter.use('/workspaces/:workspaceId', documentRouter);
// RAG management routes (Prompt 13) nest under the SAME tenant context:
// `/rag/status`, `/rag/chunks` and the per-source index/purge endpoints.
// Retrieval itself stays an internal service until an authorized API pattern
// (Prompt 14's answer surface) consumes it.
apiRouter.use('/workspaces/:workspaceId/rag', ragRouter);
// AI support agent (Prompt 14) under the SAME tenant context:
// `/agent/ask` — staff-only grounded question answering. Retrieval stays the
// Prompt 13 internal service; there is deliberately NO customer-facing agent
// route until customer-portal authentication exists (documented limitation).
apiRouter.use('/workspaces/:workspaceId/agent', agentRouter);
apiRouter.use('/public/knowledge-base', publicKnowledgeBaseRouter);
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
