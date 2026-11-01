import { env } from '../../config/env.config.js';
import type { AgentAbstentionReason } from '../agent/agent.types.js';

import type { EscalationInitiator, EscalationPriority } from './escalation.types.js';

/**
 * Escalation trigger rules (Prompt 15 §3) — the PURE, deterministic half of
 * the escalation system. Knows nothing about HTTP, MongoDB or providers, so
 * every branch is unit-testable without credentials or infrastructure.
 *
 * Policy law: there are deliberately NO company-specific policies compiled
 * in. Human-request and sensitive-topic detection are CONFIGURABLE
 * keyword heuristics (word-boundary prefix matching, case-insensitive) whose
 * lists and on/off switches live in validated environment configuration —
 * each workspace/future settings surface can turn them or their vocabulary.
 *
 * Data law: retrieved/allowed content is UNTRUSTED — matching runs only over
 * the bounded, validated question text, never over anything a model
 * generated (its own answer, self-reported confidence, etc.), and a matched
 * keyword can only CREATE an escalation record. It never grants
 * permissions, changes assignment scope or authorizes anything.
 */

/** Same shape as agent-grounding's pure policy: derived purely from validated env. */
export interface EscalationTriggerPolicy {
  readonly onAbstention: boolean;
  readonly onHumanRequest: boolean;
  readonly onSensitiveTopic: boolean;
  readonly onTechnicalFailure: boolean;
  readonly repeatedFailureThreshold: number;
  readonly failureWindowHours: number;
  readonly defaultPriority: EscalationPriority;
  readonly humanRequestKeywords: readonly string[];
  readonly sensitiveTopics: readonly [key: string, keywords: readonly string[]][];
}

/** Config values arrive piped as "key1|kw1,kw2;key2|kw3" to keep pairs explicit. */
function parseTopicConfig(raw: string): [string, string[]][] {
  return raw
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const [key, keywords] = pair.split('|');
      // Splitting without a separator yields undefined parts; treat the whole
      // segment as a malformed entry and drop it (fail-soft config parsing).
      if (key === undefined || keywords === undefined) return null;
      return [
        key.trim(),
        keywords
          .split(',')
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0),
      ] as [string, string[]];
    })
    .filter((entry): entry is [key: string, keywords: string[]] =>
      entry !== null && entry[1].length > 0,
    );
}

export function escalationPolicyFromEnv(): EscalationTriggerPolicy {
  // The env schema keeps switches as explicit 'true'/'false' strings (the
  // project-wide convention); the policy consumes proper booleans.
  const toBool = (value: 'true' | 'false'): boolean => value === 'true';
  return {
    onAbstention: toBool(env.ESCALATION_ON_ABSTENTION),
    onHumanRequest: toBool(env.ESCALATION_ON_HUMAN_REQUEST),
    onSensitiveTopic: toBool(env.ESCALATION_ON_SENSITIVE_TOPIC),
    onTechnicalFailure: toBool(env.ESCALATION_ON_TECHNICAL_FAILURE),
    repeatedFailureThreshold: env.ESCALATION_REPEATED_FAILURE_THRESHOLD,
    failureWindowHours: env.ESCALATION_FAILURE_WINDOW_HOURS,
    defaultPriority: env.ESCALATION_DEFAULT_PRIORITY,
    humanRequestKeywords: env.ESCALATION_HUMAN_REQUEST_KEYWORDS
      .split(',')
      .map((keyword) => keyword.trim().toLowerCase())
      .filter((keyword) => keyword.length > 0),
    sensitiveTopics: parseTopicConfig(env.ESCALATION_SENSITIVE_TOPICS),
  };
}

/** True when the failure class is a DEPLOYMENT misconfiguration (never escalated). */
const CONFIG_ERROR_CODES = new Set<string>([
  'AGENT_AI_NOT_CONFIGURED',
  'RAG_EMBEDDING_NOT_CONFIGURED',
  'RAG_VECTOR_SEARCH_NOT_CONFIGURED',
]);

export function isConfigurationError(code: string): boolean {
  return CONFIG_ERROR_CODES.has(code);
}

// ── Keyword matching ─────────────────────────────────────────────────────────

/** Escapes a keyword for safe `RegExp` composition (word-boundary prefix match). */
function escapeRegExp(keyword: string): string {
  return keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary prefix match, case-insensitive: `refund` matches "refund",
 * "refunds", "refunded" (=) but NOT "prefundo" (no boundary). The lists are
 * configurable DETECTION VOCABULARY — generic, documented, never policy.
 */
export function matchesAnyKeyword(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const pattern = keywords.map((keyword) => `\\b${escapeRegExp(keyword)}`).join('|');
  return new RegExp(pattern, 'i').test(text);
}

/** Explicit human request detection (Prompt 15 §3B). */
export function detectHumanRequest(question: string, policy: EscalationTriggerPolicy): boolean {
  return policy.onHumanRequest && matchesAnyKeyword(question, policy.humanRequestKeywords);
}

/** Sensitive-topic detection (Prompt 15 §3C) — returns the matched topic key, not a policy decision. */
export function detectSensitiveTopic(question: string, policy: EscalationTriggerPolicy): string | null {
  if (!policy.onSensitiveTopic) return null;
  for (const [topicKey, keywords] of policy.sensitiveTopics) {
    if (matchesAnyKeyword(question, keywords)) return topicKey;
  }
  return null;
}

// ── Trigger decision ─────────────────────────────────────────────────────────

/** The application-measured outcome of one AI interaction. */
export type AgentInteractionOutcome =
  | { readonly kind: 'ANSWERED' }
  | { readonly kind: 'ABSTAINED'; readonly abstentionReason: AgentAbstentionReason }
  | { readonly kind: 'FAILED'; readonly failureCode: string };

/**
 * The decided trigger for one AI-driven interaction, or `null` when no
 * configured rule applies. Decision input is ONLY the application-measured
 * outcome plus the question text — never model-generated claims
 * (the "speak to a human" DETECTION input is the user's own words).
 */
export type PlannedTrigger =
  | { readonly triggerType: 'HUMAN_REQUEST'; readonly reasonCode: 'EXPLICIT_HUMAN_REQUEST'; readonly topicKey: null; readonly priority: EscalationPriority }
  | { readonly triggerType: 'SENSITIVE_TOPIC'; readonly reasonCode: 'SENSITIVE_TOPIC'; readonly topicKey: string; readonly priority: EscalationPriority }
  | { readonly triggerType: 'AI_INSUFFICIENT_KNOWLEDGE'; readonly reasonCode: AgentAbstentionReason; readonly topicKey: null; readonly priority: EscalationPriority }
  | {
      readonly triggerType: 'TECHNICAL_FAILURE';
      readonly reasonCode: string;
      readonly topicKey: null;
      readonly priority: EscalationPriority
    }
  | {
      readonly triggerType: 'AI_REPEATED_FAILURE';
      readonly reasonCode: string;
      readonly topicKey: null;
      readonly priority: EscalationPriority
    };

export function decideEscalationTrigger(
  question: string,
  outcome: AgentInteractionOutcome,
  policy: EscalationTriggerPolicy,
): PlannedTrigger | null {
  // Highest-value signals win: an explicit human request dominates topic
  // detection, which dominates quality-based triggers. Same evaluation
  // order every time — deterministic and auditable.
  if (detectHumanRequest(question, policy)) {
    return {
      triggerType: 'HUMAN_REQUEST',
      reasonCode: 'EXPLICIT_HUMAN_REQUEST',
      topicKey: null,
      priority: policy.defaultPriority,
    };
  }
  const topic = detectSensitiveTopic(question, policy);
  if (topic !== null) {
    return {
      triggerType: 'SENSITIVE_TOPIC',
      reasonCode: 'SENSITIVE_TOPIC',
      topicKey: topic,
      priority: policy.defaultPriority,
    };
  }
  switch (outcome.kind) {
    case 'ANSWERED':
      return null;
    case 'ABSTAINED':
      if (!policy.onAbstention) return null;
      return {
        triggerType: 'AI_INSUFFICIENT_KNOWLEDGE',
        reasonCode: outcome.abstentionReason,
        topicKey: null,
        priority: policy.defaultPriority,
      };
    case 'FAILED':
      // Misconfiguration is a deployment problem, not a handoff trigger.
      if (!policy.onTechnicalFailure) return null;
      if (isConfigurationError(outcome.failureCode)) return null;
      return {
        triggerType: 'TECHNICAL_FAILURE',
        reasonCode: outcome.failureCode,
        topicKey: null,
        priority: policy.defaultPriority,
      };
  }
}

/**
 * Repeated-failure decision (Prompt 15 §3D) — pure: the DEPENDING signals
 * are the app-measured audit facts for THIS conversation only (already
 * workspace-scoped by the caller). `recentUnsuccessfulAfterCurrent` is the
 * count of consecutive unsuccessful interactions that PRECEDED the current
 * one in the same conversation within the configured window.
 */
export function shouldEscalateRepeatedFailure(
  currentUnsuccessful: boolean,
  recentUnsuccessful: number,
  policy: EscalationTriggerPolicy,
): boolean {
  if (!currentUnsuccessful) return false;
  // Threshold semantics: the CURRENT unanswered interaction is the Nth
  // consecutive upset; the N-1 preceding ones already sit in the audit row.
  return recentUnsuccessful >= policy.repeatedFailureThreshold - 1;
}

/** The trigger recorded when the repeat threshold trips (overrides the single-shot reason). */
export function repeatedFailureTrigger(policy: EscalationTriggerPolicy): Extract<PlannedTrigger, { triggerType: 'AI_REPEATED_FAILURE' }> {
  return {
    triggerType: 'AI_REPEATED_FAILURE',
    reasonCode: 'CONSECUTIVE_UNSUCCESSFUL_AI',
    topicKey: null,
    priority: policy.defaultPriority,
  };
}

// ── Assignment eligibility (pure authorization predicate) ───────────────────

/**
 * The escalation queue is for DESK staff: the SAME eligibility rule as ticket
 * assignment (`hasAtLeastRole(member.role, 'agent')` upstream of here). This
 * pure helper documents the intended rule; its caller in the service enforces
 * it against the DB-derived membership row.
 */
export function isDeskRole(role: 'owner' | 'admin' | 'agent' | 'viewer'): boolean {
  return role === 'owner' || role === 'admin' || role === 'agent';
}

// ── History/actor helpers ────────────────────────────────────────────────────

export function actorLabel(initiator: EscalationInitiator, actorId: string | null): string {
  return initiator === 'STAFF' ? (actorId ?? 'staff') : 'ai_agent';
}
