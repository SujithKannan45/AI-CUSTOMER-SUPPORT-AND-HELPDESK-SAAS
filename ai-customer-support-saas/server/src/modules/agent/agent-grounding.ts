import { z } from 'zod';

import { env } from '../../config/env.config.js';

import type { AgentAbstentionReason, AgentCitation } from './agent.types.js';

/**
 * Grounding engine (Prompt 14) — the pure, deterministic half of the agent.
 * Owns the answerability policy, citation validation, bounded context
 * assembly, and the strict machine-parseable contract the generation call
 * must satisfy. Knows NOTHING about HTTP or providers, so every branch is
 * unit-testable without Express or credentials.
 *
 * Policy law: model self-reported confidence is INADMISSIBLE on its own. The
 * only signals that decide answerability are the ones the application
 * measures: how many passages retrieval returned, their similarity scores,
 * and whether the generated answer cites passage numbers that actually
 * exist in this request's retrieved set.
 */

/** One retrieved passage as the orchestration layer sees it (from Prompt 13). */
export interface GroundingPassage {
  readonly chunkId: string;
  readonly sourceType: 'KB_ARTICLE' | 'DOCUMENT';
  readonly sourceId: string;
  readonly text: string;
  readonly score: number;
}

export interface EvidencePolicyConfig {
  readonly minPassages: number;
  readonly minScore: number;
  readonly contextMaxPassages: number;
  readonly contextMaxChars: number;
  readonly answerMaxChars: number;
}

export function agentPolicyFromEnv(): EvidencePolicyConfig {
  return {
    minPassages: env.AI_AGENT_MIN_PASSAGES,
    minScore: env.AI_AGENT_MIN_CONTEXT_SCORE,
    contextMaxPassages: env.AI_AGENT_CONTEXT_MAX_PASSAGES,
    contextMaxChars: env.AI_AGENT_CONTEXT_MAX_CHARS,
    answerMaxChars: env.AI_AGENT_ANSWER_MAX_CHARS,
  };
}

export type EvidenceVerdict =
  | { readonly sufficient: true; readonly usable: readonly GroundingPassage[] }
  | { readonly sufficient: false; readonly reason: AgentAbstentionReason };

/**
 * The pre-generation evidence gate. Called BEFORE the provider so a request
 * without usable evidence never costs a provider call.
 */
export function evaluateEvidence(
  passages: readonly GroundingPassage[],
  policy: EvidencePolicyConfig,
): EvidenceVerdict {
  if (passages.length === 0) {
    return { sufficient: false, reason: 'NO_KNOWLEDGE' };
  }
  const best = Math.max(...passages.map((passage) => passage.score));
  if (policy.minScore > 0 && best < policy.minScore) {
    return { sufficient: false, reason: 'LOW_RELEVANCE' };
  }
  if (passages.length < policy.minPassages) {
    return { sufficient: false, reason: 'INSUFFICIENT_EVIDENCE' };
  }
  return { sufficient: true, usable: passages };
}

/**
 * Context assembly — bundles at most `contextMaxPassages` passages (best
 * score first, deterministic order for equal scores) with a total character
 * budget. Returned in the SAME order they are numbered for the model, so a
 * citation number maps deterministically to a passage.
 */
export interface ContextPassage {
  readonly passageIndex: number; // 1-based, as presented to the model
  readonly passage: GroundingPassage;
}

export function assembleContext(
  usable: readonly GroundingPassage[],
  policy: EvidencePolicyConfig,
): readonly ContextPassage[] {
  const ordered = [...usable]
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, policy.contextMaxPassages);

  const chosen: ContextPassage[] = [];
  let budget = policy.contextMaxChars;
  for (const passage of ordered) {
    if (budget <= 0) break;
    const text = passage.text.length > budget ? `${passage.text.slice(0, budget)}…` : passage.text;
    chosen.push({ passageIndex: chosen.length + 1, passage: { ...passage, text } });
    budget -= text.length;
  }
  return chosen;
}

/** The strict JSON contract the model must return. */
const modelAnswerSchema = z.object({
  answerable: z.boolean(),
  answer: z.string(),
  citations: z.array(z.number().int()).max(50),
});

export type ModelAnswer = z.infer<typeof modelAnswerSchema>;

/**
 * Parses the model's content into the strict contract. Accepts raw JSON and
 * a ```json fence; anything else is an INVALID RESPONSE (a provider/output
 * failure — distinguishable from evidence-based abstention), never a guess.
 */
export function parseModelAnswer(content: string): ModelAnswer {
  const attempt = (candidate: string): ModelAnswer | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const result = modelAnswerSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(content.trim());
  if (direct !== null) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  if (fence !== null && fence[1] !== undefined) {
    const inside = attempt(fence[1].trim());
    if (inside !== null) return inside;
  }
  throw new Error('AGENT_AI_INVALID_RESPONSE');
}

export interface ValidatedModelAnswer {
  readonly verdict: 'ANSWERED';
  readonly answer: string;
  readonly citationIndexes: readonly ContextPassage[];
}

export interface RefusedModelAnswer {
  readonly verdict: 'ABSTAINED';
  readonly reason: AgentAbstentionReason;
}

/**
 * Post-generation citation validation — the anti-fabrication law. Citation
 * numbers that do not exist in THIS request's retrieved context are dropped;
 * a substantive answer with no surviving citation is refused. The answer
 * text is bounded to the configured cap with a safe truncation marker.
 */
export function validateModelAnswer(
  modelAnswer: ModelAnswer,
  context: readonly ContextPassage[],
  policy: EvidencePolicyConfig,
): ValidatedModelAnswer | RefusedModelAnswer {
  if (!modelAnswer.answerable) {
    return { verdict: 'ABSTAINED', reason: 'MODEL_DECLINED' };
  }
  const answer = modelAnswer.answer.trim();
  if (answer.length === 0) {
    return { verdict: 'ABSTAINED', reason: 'MODEL_DECLINED' };
  }
  const byIndex = new Map(context.map((entry) => [entry.passageIndex, entry] as const));
  const uniqueIndexes = [...new Set(modelAnswer.citations)];
  const citationIndexes = uniqueIndexes
    .map((index) => byIndex.get(index))
    .filter((entry): entry is ContextPassage => entry !== undefined);
  if (citationIndexes.length === 0) {
    return { verdict: 'ABSTAINED', reason: 'UNCITED_ANSWER' };
  }
  return {
    verdict: 'ANSWERED',
    answer:
      answer.length > policy.answerMaxChars
        ? `${answer.slice(0, policy.answerMaxChars)}…`
        : answer,
    citationIndexes,
  };
}

export function toCitations(
  citationIndexes: readonly ContextPassage[],
  titlesById: ReadonlyMap<string, string | null>,
): readonly AgentCitation[] {
  return citationIndexes.map(({ passage }) => ({
    sourceType: passage.sourceType,
    sourceId: passage.sourceId,
    title: titlesById.get(passage.sourceId) ?? null,
    chunkId: passage.chunkId,
  }));
}

/** Which source ids need a workspace-scoped title lookup for citations. */
export function citationSourceIds(citationIndexes: readonly ContextPassage[]): readonly string[] {
  return [...new Set(citationIndexes.map(({ passage }) => passage.sourceId))];
}

/**
 * Maps a raw provider-content string to a machine reason when parsing
 * failed — used by the service to throw the SAFE operational error.
 */
export const INVALID_RESPONSE_SENTINEL = 'AGENT_AI_INVALID_RESPONSE';
