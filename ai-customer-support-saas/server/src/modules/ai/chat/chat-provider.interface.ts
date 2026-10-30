import { z } from 'zod';

/**
 * Chat (generation) provider abstraction (Prompt 14) — the seam between the
 * support-agent service and any LLM completion service. Feature code depends
 * ONLY on this interface; the OpenAI adapter is an implementation detail.
 *
 * The deterministic mock provider is reachable ONLY through the factory's
 * test seam (never through env configuration), so no code path can "answer"
 * questions with canned text in production.
 *
 * Validation law (mirrors the embedding provider): a provider payload that
 * deviates from the expected shape is a hard failure with a safe code —
 * never silently accepted as a fluent-but-wrong answer.
 */

/** Stable machine codes surfaced in SERVER LOGS and safe errors only. */
export type ChatErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'CHAT_INVALID_RESPONSE'
  | 'CHAT_INPUT_INVALID';

export class ChatProviderError extends Error {
  public readonly code: ChatErrorCode;
  /** Retry-safe hint (429/5xx/timeout retryable; 4xx payload problems not). */
  public readonly retryable: boolean;

  public constructor(code: ChatErrorCode, message: string, options?: {
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

/** Trusted prompt pieces consume this shape; adapter sends it verbatim. */
export interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface ChatCompletionInput {
  readonly messages: readonly ChatMessage[];
  /** Hard output-token bound for THIS call (caller configures, adapter sends). */
  readonly maxOutputTokens: number;
  /** 0 = deterministic; small positive values allowed for future features. */
  readonly temperature?: number;
}

/** What one completion returns — never fabricated usage numbers. */
export interface ChatCompletionResult {
  readonly content: string;
  /** Provider finish reason when reported (e.g. "stop", "length"); null if unknown. */
  readonly finishReason: string | null;
  readonly model: string;
  /**
   * Token accounting ONLY when the provider actually returned it — the agent
   * never fabricates or estimates usage.
   */
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
}

export interface ChatCompletionProvider {
  readonly name: 'openai' | 'mock';
  readonly model: string;
  complete(input: ChatCompletionInput): Promise<ChatCompletionResult>;
}

/** OpenAI-compatible /chat/completions response (validated, never trusted). */
const openAiChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }).passthrough(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().finite(),
      completion_tokens: z.number().int().nonnegative().finite(),
    })
    .passthrough()
    .nullish(),
});

type OpenAiChatResponse = z.infer<typeof openAiChatResponseSchema>;

/** Validated response-shape parser for the OpenAI-compatible payload. */
export function parseOpenAiChatResponse(payload: unknown): OpenAiChatResponse {
  const parsed = openAiChatResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ChatProviderError(
      'CHAT_INVALID_RESPONSE',
      'The chat provider returned an unexpected response shape',
    );
  }
  return parsed.data;
}
