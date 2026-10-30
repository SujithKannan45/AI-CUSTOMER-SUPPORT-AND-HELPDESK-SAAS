import type { AgentAnswer, AgentCitation } from './agent.types.js';

/**
 * HTTP contract for the agent endpoint. The structured result is designed to
 * also carry Prompt 15's human-handoff decision later — statuses and reasons
 * are machine codes, never free text that would need re-interpretation.
 */

export type AgentCitationDto = AgentCitation;

export type AgentAnswerPayload = AgentAnswer;
