import { env } from '../../../config/env.config.js';

import type { ChatCompletionProvider } from './chat-provider.interface.js';
import { OpenAiChatProvider } from './openai-chat.provider.js';

/**
 * Chat provider selector — the ONLY place the app decides how answers are
 * generated. Mirrors the storage/embedding/vector factories:
 *
 * - `none` (default): null — agent endpoints surface a clear "not configured"
 *   operational error instead of pretending.
 * - `openai`: OpenAI-compatible adapter; requires OPENAI_API_KEY (production
 *   additionally boot-guards it in env.config.ts).
 * - `gemini`/`bedrock`: RESERVED vendor names — no adapter exists yet, so
 *   they behave exactly like `none` until implemented (never a mock).
 * - A `mock` chat provider is NOT selectable via configuration — it exists
 *   only behind the test seam below.
 */
let cached: ChatCompletionProvider | null | undefined;
let testOverride: ChatCompletionProvider | null | undefined;

/** Test seam only: verification drivers inject determinism explicitly. */
export function setChatProviderForTests(provider: ChatCompletionProvider | null | undefined): void {
  testOverride = provider;
}

export function getChatProvider(): ChatCompletionProvider | null {
  if (testOverride !== undefined) return testOverride;
  if (cached === undefined) {
    switch (env.AI_PROVIDER) {
      case 'openai':
        cached =
          env.OPENAI_API_KEY === undefined
            ? null // configuration error at use time, surfaced as 503 by the agent
            : new OpenAiChatProvider({ apiKey: env.OPENAI_API_KEY });
        break;
      case 'gemini':
      case 'bedrock':
      case 'none':
      default:
        cached = null;
        break;
    }
  }
  return cached;
}

export function resetChatProviderForTests(): void {
  cached = undefined;
  testOverride = undefined;
}
