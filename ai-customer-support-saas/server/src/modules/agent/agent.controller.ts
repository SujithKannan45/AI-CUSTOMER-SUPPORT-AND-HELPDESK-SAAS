import type { Request, RequestHandler } from 'express';
import { Types } from 'mongoose';

import { asyncHandler, sendSuccess } from '../../core/http/api-response.js';

import type { AgentAnswerPayload } from './agent.dto.js';
import { askSupportAgent } from './agent.service.js';
import type { AgentQuestionBody, AgentQuestionParams } from './agent.validation.js';

/**
 * Agent controller — HTTP shape only (parse → service → respond), same thin
 * composition as the other modules. Authorization has ALREADY happened in
 * middleware:
 *
 *   requireAuth → validate(...) → requireWorkspaceContext() → requirePermission(...)
 *
 * Express 5 note: `req.params` is a live getter backed by the matched route —
 * plain assignment cannot replace it, so the shared validate middleware does
 * NOT install parsed params as `req.params`. It exposes the SAME workspaceId
 * to the service via BOTH the schema-validated `req.validated.params.slot`
 * (the pattern other workspace-scoped modules use) and the raw matched
 * getter-backed `req.params.workspaceId`, because the WORKSPACE MIDDLEWARE
 * requires a real string property to promote into its context.
 */

export interface AgentValidatedRequest extends Request {
  readonly validated?: {
    readonly params?: AgentQuestionParams;
  };
}

/** POST /ask — one grounded question against the authorized workspace. */
export const askAgentController: RequestHandler = asyncHandler(async (req, res) => {
  const validated = (req as AgentValidatedRequest).validated;
  const body = req.body as AgentQuestionBody;
  const validatedWorkspaceId = validated?.params?.['workspaceId'];
  const workspaceId = new Types.ObjectId(
    typeof validatedWorkspaceId === 'string' ? validatedWorkspaceId : String(req.params['workspaceId']),
  );
  const requesterId = new Types.ObjectId(req.auth!.userId);

  const result = await askSupportAgent({
    workspaceId,
    requesterId,
    question: body.question,
    ...(body.conversationId !== undefined
      ? { conversationId: new Types.ObjectId(body.conversationId) }
      : {}),
    // Audit-trail context (ip / user-agent) — never conversation content.
    request: req,
  });

  const payload: AgentAnswerPayload = result;
  sendSuccess(res, 200, payload, req);
});
