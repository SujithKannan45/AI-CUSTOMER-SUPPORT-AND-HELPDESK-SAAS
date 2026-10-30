import type { Request } from 'express';
import { Types } from 'mongoose';

import { env } from '../../config/env.config.js';
import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import { ChatProviderError, type ChatMessage } from '../ai/chat/chat-provider.interface.js';
import { getChatProvider } from '../ai/chat/chat.factory.js';
import { findConversationInWorkspace } from '../conversations/conversation.repository.js';
import { listMessages } from '../conversations/message.repository.js';
import { findDocumentInWorkspace } from '../documents/document.repository.js';
import type { DocumentFile } from '../documents/document.types.js';
import { findArticleInWorkspace } from '../knowledge-base/kb-article.repository.js';
import type { KbArticleDocument } from '../knowledge-base/kb.types.js';
import { EmbeddingProviderError } from '../rag/embeddings/embedding-provider.interface.js';
import {
  retrievePassages,
} from '../rag/rag-retrieval.service.js';

import { recordAgentAudit, AGENT_AUDIT_ACTIONS } from './agent-audit.js';
import {
  INVALID_RESPONSE_SENTINEL,
  agentPolicyFromEnv,
  assembleContext,
  citationSourceIds,
  evaluateEvidence,
  parseModelAnswer,
  toCitations,
  validateModelAnswer,
  type ContextPassage,
  type GroundingPassage,
} from './agent-grounding.js';
import {
  buildHistorySection,
  buildSystemPrompt,
  buildUserPrompt,
  type PromptHistoryEntry,
} from './agent.prompts.js';
import type { AgentAnswer, AgentCitation } from './agent.types.js';

/**
 * AI support-agent service (Prompt 14) — orchestration only:
 *
 *   validate (controller) → authorized conversation read → Prompt 13
 *   retrieval → MEASURED evidence gate → bounded context → provider
 *   generation → strict output contract → citation validation → payload.
 *
 * Isolation law: every lookup below is workspace-scoped and server-side.
 * Retrieval is Prompt 13's internal service (tenant scope applied INSIDE
 * the store query); conversation ids not owned by the authorized workspace
 * read as not-found; citation metadata resolves through the same scoped
 * repositories. No client field can influence scope.
 *
 * Abstention law: answerability comes from MEASURED signals only (passage
 * count, similarity floor, citation validity). Model self-confidence is
 * never trusted; a fluent-but-uncited answer is refused.
 */

/** Latest-first history window, derived from the ascending paginated read. */
async function readConversationHistory(
  workspaceId: Types.ObjectId,
  conversationId: Types.ObjectId,
): Promise<readonly PromptHistoryEntry[]> {
  // First pass reads the total to aim the window at the END of the thread.
  const totalProbe = await listMessages({
    workspaceId,
    conversationId,
    page: 1,
    limit: 1,
    publicOnly: true, // internal notes NEVER enter AI grounding context
  });
  const total = totalProbe.total;
  if (total === 0) return [];

  const take = Math.min(env.AI_AGENT_HISTORY_MAX_MESSAGES, total);
  const page = Math.floor((total - 1) / take) + 1;
  const tail = await listMessages({
    workspaceId,
    conversationId,
    page,
    limit: take,
    publicOnly: true,
  });

  // Bounded per-message and total traversal (characters AND messages).
  const entries: PromptHistoryEntry[] = [];
  for (const message of [...tail.items].slice(-take)) {
    if (entries.length >= env.AI_AGENT_HISTORY_MAX_MESSAGES) break;
    entries.push({
      senderKind: message.senderType,
      body: message.body.slice(0, env.AI_AGENT_HISTORY_MESSAGE_MAX_CHARS),
    });
  }
  return entries;
}

/** Workspace-scoped title resolution for citations (article title / document filename). */
async function resolveCitationTitles(
  workspaceId: Types.ObjectId,
  sourceIds: readonly string[],
): Promise<Map<string, string | null>> {
  const titles = new Map<string, string | null>();
  await Promise.all(
    sourceIds.map(async (sourceId) => {
      const key = sourceId;
      try {
        const articleId = sourceId;
        if (!/^[0-9a-fA-F]{24}$/.test(articleId)) {
          titles.set(key, null);
          return;
        }
        const id = new Types.ObjectId(articleId);
        const article: KbArticleDocument | null = await findArticleInWorkspace(workspaceId, id);
        if (article !== null) {
          titles.set(key, article.title);
          return;
        }
        const document: DocumentFile | null = await findDocumentInWorkspace(workspaceId, id);
        titles.set(key, document?.['originalFilename'] ?? null);
      } catch {
        // A vanished source loses its title, never its citation binding.
        titles.set(key, null);
      }
    }),
  );
  return titles;
}

/** Maps Prompt 13 retrieval/infrastructure failures to SAFE agent errors. */
function retrievalFailure(error: unknown): AppError {
  if (error instanceof AppError) {
    // Retrieval already surfaces safely-coded operational errors
    // (RAG_EMBEDDING_NOT_CONFIGURED, RAG_VECTOR_SEARCH_FAILED, ...).
    return error;
  }
  if (error instanceof EmbeddingProviderError) {
    logger.warn({ code: error.code }, 'agent query embedding failed');
    return new AppError('Semantic search is currently unavailable', {
      statusCode: 503,
      code: 'RAG_EMBEDDING_PROVIDER_FAILED',
      isOperational: true,
    });
  }
  logger.error({ err: error }, 'agent retrieval failed unexpectedly');
  return new AppError('Semantic search is currently unavailable', {
    statusCode: 503,
    code: 'RAG_RETRIEVAL_FAILED',
    isOperational: true,
  });
}

/** Maps chat-provider failures to SAFE top-level agent errors. */
function providerFailure(error: unknown): AppError {
  if (error instanceof ChatProviderError) {
    const message =
      error.code === 'CHAT_INVALID_RESPONSE'
        ? 'The AI provider returned an unusable response'
        : 'The AI provider is temporarily unavailable';
    return new AppError(message, {
      statusCode: 503,
      code: error.code === 'CHAT_INVALID_RESPONSE' ? INVALID_RESPONSE_SENTINEL : 'AGENT_AI_PROVIDER_FAILED',
      isOperational: true,
      // Log the machine code; the HTTP surface stays safe.
      details: { loggedCode: error.code },
    });
  }
  logger.error({ err: error }, 'chat provider failed unexpectedly');
  return new AppError('The AI provider failed to generate an answer', {
    statusCode: 503,
    code: 'AGENT_AI_PROVIDER_FAILED',
    isOperational: true,
  });
}

export interface AskAgentInput {
  readonly workspaceId: Types.ObjectId;
  /** The authenticated member performing the ask — never a client field. */
  readonly requesterId: Types.ObjectId;
  readonly question: string;
  /** Optional conversation whose PUBLIC history grounds the answer. */
  readonly conversationId?: Types.ObjectId;
  /** Optional HTTP context — audit trail captures ip/user-agent ONLY. */
  readonly request?: Request;
}

/**
 * One agent request (staff answer preview). NOTE: the answer is NOT
 * persisted into the conversation — posting messages has lifecycle
 * side effects (last-message metadata, socket broadcast, audit) owned by
 * the conversation feature. The integration point for Prompt 15's
 * handoff/customer path is this function's structured result, not a
 * message write.
 */
export async function askSupportAgent(input: AskAgentInput): Promise<AgentAnswer> {
  const startedAt = Date.now();

  const conversation = input.conversationId === undefined
    ? null
    : await findConversationInWorkspace(input.workspaceId, input.conversationId);
  if (input.conversationId !== undefined && conversation === null) {
    // Foreign or unknown ids read as not-found — no existence oracle.
    throw AppError.notFound('Conversation not found');
  }

  const history = conversation === null ? [] : await readConversationHistory(input.workspaceId, conversation._id);

  let retrieved: readonly GroundingPassage[];
  try {
    retrieved = await retrievePassages({
      workspaceId: input.workspaceId,
      query: input.question,
    });
  } catch (error: unknown) {
    throw retrievalFailure(error);
  }

  const passages = retrieved.map((passage) => ({ ...passage }));
  const policy = agentPolicyFromEnv();
  const evidence = evaluateEvidence(passages, policy);

  const topScore = passages.length > 0 ? Math.max(...passages.map((passage) => passage.score)) : null;

  if (!evidence.sufficient) {
    const abstained: AgentAnswer = {
      status: 'ABSTAINED',
      abstentionReason: evidence.reason,
      topScore,
      passagesRetrieved: passages.length,
      model: null,
      tokenUsage: null,
    };
    logOutcome(input, abstained, startedAt);
    auditOutcome(input, abstained);
    return abstained;
  }

  // Bounded context assembly — best passages first, capped both ways.
  const context: readonly ContextPassage[] = assembleContext(evidence.usable, policy);

  const provider = getChatProvider();
  if (provider === null) {
    throw new AppError('The AI agent is not configured for this deployment', {
      statusCode: 503,
      code: 'AGENT_AI_NOT_CONFIGURED',
    });
  }

  const messages: readonly ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt({
      question: input.question,
      historySection: buildHistorySection(history),
      context,
    }) },
  ];

  let content: string;
  let providerUsage: { inputTokens: number | null; outputTokens: number | null } | null = null;
  try {
    const completion = await provider.complete({
      messages,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
    content = completion.content;
    providerUsage = completion.usage;
  } catch (error: unknown) {
    throw providerFailure(error);
  }

  let modelAnswer;
  try {
    modelAnswer = parseModelAnswer(content);
  } catch {
    throw new AppError('The AI provider returned an unusable response', {
      statusCode: 503,
      code: INVALID_RESPONSE_SENTINEL,
      isOperational: true,
    });
  }

  const validated = validateModelAnswer(modelAnswer, context, policy);
  if (validated.verdict === 'ABSTAINED') {
    const abstained: AgentAnswer = {
      status: 'ABSTAINED',
      abstentionReason: validated.reason,
      topScore,
      passagesRetrieved: passages.length,
      model: provider.model,
      tokenUsage: providerUsage,
    };
    logOutcome(input, abstained, startedAt);
    auditOutcome(input, abstained);
    return abstained;
  }

  const titlesById = await resolveCitationTitles(
    input.workspaceId,
    citationSourceIds(validated.citationIndexes),
  );
  const citations: readonly AgentCitation[] = toCitations(validated.citationIndexes, titlesById);

  const answered: AgentAnswer = {
    status: 'ANSWERED',
    answer: validated.answer,
    citations,
    topScore: topScore ?? 0,
    passagesRetrieved: passages.length,
    model: provider.model,
    tokenUsage: providerUsage,
  };
  logOutcome(input, answered, startedAt);
  auditOutcome(input, answered);
  return answered;
}

/** Structured, content-free outcome log (no question/answer/prompt text). */
function logOutcome(input: AskAgentInput, answer: AgentAnswer, startedAt: number): void {
  logger.info({
    workspaceId: input.workspaceId.toHexString(),
    outcome: answer.status,
    abstentionReason: answer.status === 'ABSTAINED' ? answer.abstentionReason : null,
    passagesRetrieved: answer.passagesRetrieved,
    topScore: answer.topScore,
    citationsCount: answer.status === 'ANSWERED' ? answer.citations.length : 0,
    model: answer.model,
    tokenUsage: answer.tokenUsage,
    durationMs: Date.now() - startedAt,
  }, 'agent question processed');
}

/** Fire-safe audit (same convention as rag-audit) — no content. */
function auditOutcome(input: AskAgentInput, answer: AgentAnswer): void {
  recordAgentAudit({
    action: AGENT_AUDIT_ACTIONS.questionAnswered,
    workspaceId: input.workspaceId,
    actorId: input.requesterId,
    // The "resource" of an agent interaction is the request itself; a
    // conversation reference anchors it when one grounds the answer.
    resourceId: input.conversationId?.toHexString() ?? 'ask',
    metadata: {
      outcome: answer.status,
      abstentionReason: answer.status === 'ABSTAINED' ? answer.abstentionReason : null,
      passagesRetrieved: answer.passagesRetrieved,
      citationsCount: answer.status === 'ANSWERED' ? answer.citations.length : 0,
      model: answer.model,
      tokenUsage: answer.tokenUsage,
    },
    ...(input.request !== undefined ? { request: input.request } : {}),
  });
}
