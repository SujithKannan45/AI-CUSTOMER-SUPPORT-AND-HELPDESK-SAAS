import { env } from '../../../config/env.config.js';

import {
  ChatProviderError,
  type ChatCompletionInput,
  type ChatCompletionProvider,
  type ChatCompletionResult,
  parseOpenAiChatResponse,
} from './chat-provider.interface.js';

/**
 * OpenAI-compatible chat adapter (Prompt 14).
 *
 * - Times out via AbortController (never hangs the request path).
 * - ONE bounded retry for transient failures (429/5xx/timeout) with a fixed
 *   short backoff — systematic retry policy stays with the future job layer.
 * - VALIDATES the response strictly (choices[0].message.content, optional
 *   usage). Provider deviations are hard failures with safe codes, never
 *   fluent-but-wrong answers.
 * - The injectable fetch is ONLY a test seam; production uses global fetch.
 */

interface OpenAiChatAdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryDelayMs?: number;
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAiChatProvider implements ChatCompletionProvider {
  public readonly name = 'openai' as const;
  public readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  public constructor(options: OpenAiChatAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? env.AI_CHAT_BASE_URL;
    this.model = options.model ?? env.AI_CHAT_MODEL;
    this.timeoutMs = options.timeoutMs ?? env.AI_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  public async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    if (input.messages.length === 0) {
      throw new ChatProviderError('CHAT_INPUT_INVALID', 'The chat request has no messages');
    }
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
      throw new ChatProviderError('CHAT_INPUT_INVALID', 'The chat request has an invalid output-token bound');
    }

    try {
      const first = await this.postCompletion(input);
      const parsed = parseOpenAiChatResponse(first);
      return this.toResult(parsed);
    } catch (error: unknown) {
      const typed = error as { code?: unknown; retryable?: unknown };
      const retryable = typed['retryable'] === true;
      const isTransientNetwork = error instanceof TypeError; // fetch network failure
      if (error instanceof ChatProviderError && error.code === 'CHAT_INVALID_RESPONSE') throw error;
      if (!retryable && !isTransientNetwork) throw error;
      await sleep(this.retryDelayMs);
      const second = await this.postCompletion(input);
      return this.toResult(parseOpenAiChatResponse(second));
    }
  }

  private toResult(payload: ReturnType<typeof parseOpenAiChatResponse>): ChatCompletionResult {
    const choice = payload.choices[0];
    const content = choice?.['message']?.['content'];
    if (typeof content !== 'string') {
      throw new ChatProviderError('CHAT_INVALID_RESPONSE', 'The chat provider returned no message content');
    }
    return {
      content,
      finishReason: choice?.['finish_reason'] ?? null,
      model: this.model,
      usage: {
        inputTokens: payload.usage?.['prompt_tokens'] ?? null,
        outputTokens: payload.usage?.['completion_tokens'] ?? null,
      },
    };
  }

  private async postCompletion(input: ChatCompletionInput): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL('/chat/completions', this.baseUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          max_tokens: input.maxOutputTokens,
          temperature: input.temperature ?? 0,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ChatProviderError('PROVIDER_TIMEOUT', 'The chat provider request timed out', {
          retryable: true,
          cause: error,
        });
      }
      // Network-level failure: caller decides on the retry, then this throws again.
      throw error;
    }
    clearTimeout(timer);

    if (!response.ok) {
      if (TRANSIENT_STATUS_CODES.has(response.status)) {
        throw new ChatProviderError(
          response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
          `The chat provider answered ${response.status}`,
          { retryable: true },
        );
      }
      // Deterministic (auth/payload) failures share one safe message.
      throw new ChatProviderError('PROVIDER_UNAVAILABLE', 'The chat provider rejected the request');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      throw new ChatProviderError('CHAT_INVALID_RESPONSE', 'The chat provider returned malformed JSON', {
        cause: error,
      });
    }
    return payload;
  }
}
