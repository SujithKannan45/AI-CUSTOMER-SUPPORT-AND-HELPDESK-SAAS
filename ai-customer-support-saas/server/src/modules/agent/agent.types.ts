/**
 * Agent domain vocabulary (Prompt 14) — the domain contract; the service is
 * the orchestration boundary. Same types/dto split as the other modules.
 *
 * Design center: every answer is GROUNDED — produced only from authorized,
 * workspace-scoped retrieval — and every substantive answer carries
 * citations validated against the retrieved passage set. When the evidence
 * policy is not met the agent ABSTAINS with a machine reason; it never
 * invents an answer because a model produced fluent text.
 */

/** Terminal request outcomes surfaced in the response payload. */
export const AGENT_OUTCOMES = ['ANSWERED', 'ABSTAINED'] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

/**
 * Stable machine abstention reasons. Each maps to evidence the APPLICATION
 * measured — never the model's self-reported confidence.
 */
export type AgentAbstentionReason =
  /** Retrieval returned zero passages. */
  | 'NO_KNOWLEDGE'
  /** Passages exist but the best similarity score is below the configured floor. */
  | 'LOW_RELEVANCE'
  /** Fewer usable passages than the configured minimum. */
  | 'INSUFFICIENT_EVIDENCE'
  /** The model itself declined (answerable=false). */
  | 'MODEL_DECLINED'
  /** The model answered but cited nothing from the retrieved passage set. */
  | 'UNCITED_ANSWER';

/** Source metadata available for one citation — verified server-side. */
export interface AgentCitation {
  readonly sourceType: 'KB_ARTICLE' | 'DOCUMENT';
  readonly sourceId: string;
  /** Article title or document original filename; null when the source vanished between retrieval and citation. */
  readonly title: string | null;
  /** The retrieved passage (chunk) reference this citation points at. */
  readonly chunkId: string;
}

/** Token usage as returned by the provider — never estimated. */
export interface AgentTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface AgentAnswered {
  readonly status: 'ANSWERED';
  /** Model-generated content, bounded to the configured cap and stripped of provider decorations. */
  readonly answer: string;
  /** Validated citations: each maps to a passage in this request's retrieved set. */
  readonly citations: readonly AgentCitation[];
  readonly topScore: number;
  readonly passagesRetrieved: number;
  readonly model: string;
  readonly tokenUsage: AgentTokenUsage | null;
}

export interface AgentAbstained {
  readonly status: 'ABSTAINED';
  readonly abstentionReason: AgentAbstentionReason;
  readonly topScore: number | null;
  readonly passagesRetrieved: number;
  readonly model: string | null;
  readonly tokenUsage: AgentTokenUsage | null;
}

export type AgentAnswer = AgentAnswered | AgentAbstained;
