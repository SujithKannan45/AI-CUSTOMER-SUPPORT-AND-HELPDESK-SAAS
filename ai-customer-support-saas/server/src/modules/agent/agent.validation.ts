import { z } from 'zod';

/**
 * Agent API validation — allowlisted, bounded Zod schemas following the
 * conventions of kb.validation.ts / rag.validation.ts. The workspace path
 * parameter is validated like every other workspace-scoped route; the
 * conversation reference is a 24-hex id whose ownership the SERVICE verifies
 * against the authorized workspace.
 */

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-hex-character ObjectId');

export const agentQuestionParamsSchema = z
  .object({
    workspaceId: objectIdSchema,
  })
  .strict();
export interface AgentQuestionParams {
  readonly workspaceId: string;
}

export const agentQuestionBodySchema = z
  .object({
    // Optional: knowledge-only asks omit it; when supplied, the service
    // verifies the conversation belongs to the authorized workspace (404).
    conversationId: objectIdSchema.optional(),
    question: z
      .string()
      .trim()
      .min(1, 'The question must not be empty')
      .max(2_000, 'The question is too long'),
  })
  .strict();
export interface AgentQuestionBody {
  readonly conversationId?: string;
  readonly question: string;
}
