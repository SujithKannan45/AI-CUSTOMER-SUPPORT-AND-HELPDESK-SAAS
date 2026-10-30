import {
  ChatProviderError,
  type ChatCompletionInput,
  type ChatCompletionProvider,
  type ChatCompletionResult,
} from './chat-provider.interface.js';

/**
 * Deterministic mock chat provider — FOR TESTS/DRIVERS ONLY.
 *
 * It is NOT selectable through AI_PROVIDER (the env enum has no "mock"), so
 * the only way to reach it is the chat factory's explicit test seam. Scripts
 * drive its behavior with markers placed in the QUESTION text (never in
 * passage content, so injected source text cannot steer it):
 *
 *   'FORCE_FAIL'        → throws PROVIDER_UNAVAILABLE (unretryable)
 *   'FORCE_UNPARSEABLE' → returns non-JSON garbage (response-validator path)
 *   'FORCE_ABSTAIN'     → returns the strict abstention JSON
 *   'FORCE_SPOOF_CITATIONS' → cites passage [88] (citation validator path)
 *   default             → grounded answer citing the passages provided
 *
 * The default answer quotes the context it received — it is a MOCK, not a
 * model. It exists so tests can verify the agent's WIRING (citation
 * validation, caps, abstention policy) without credentials.
 */
export class MockChatProvider implements ChatCompletionProvider {
  public readonly name = 'mock' as const;
  public readonly model = 'mock-chat';
  public readonly usage = { inputTokens: null as number | null, outputTokens: null as number | null };

  public complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    const userContent = input.messages[input.messages.length - 1]?.['content'] ?? '';

    if (userContent.includes('FORCE_FAIL')) {
      return Promise.reject(new ChatProviderError('PROVIDER_UNAVAILABLE', 'The chat provider rejected the request'));
    }

    if (userContent.includes('FORCE_UNPARSEABLE')) {
      return Promise.resolve(this.reply('this is {"not": the structured protocol'));
    }

    if (userContent.includes('FORCE_ABSTAIN')) {
      return Promise.resolve(this.reply(JSON.stringify({
        answerable: false,
        answer: '',
        citations: [],
      })));
    }

    if (userContent.includes('FORCE_SPOOF_CITATIONS')) {
      return Promise.resolve(this.reply(JSON.stringify({
        answerable: true,
        answer: 'The requested information is covered by passage [88] per the knowledge base.',
        citations: [88],
      })));
    }

    // Default: grounded answer over the provided passages.
    // The real prompt renders "Passage [1] (knowledge-base article): text",
    // so the marker must tolerate the parenthesized source-type suffix.
    const passages = Array.from(
      userContent.matchAll(/^Passage \[(\d+)\]\s*(?:\([^)]*\))?:/gm),
      (match) => match[1],
    );
    const cited = passages.map((entry) => Number(entry));
    const firstBlock = /^Passage \[\d+\]\s*(?:\([^)]*\))?:\s?/m.exec(userContent);
    const snippet =
      firstBlock !== null
        ? userContent.slice((firstBlock.index ?? 0) + firstBlock[0].length).split('\n')[0]?.trim().slice(0, 160) ?? ''
        : '';
    return Promise.resolve(this.reply(JSON.stringify({
      answerable: cited.length > 0,
      answer:
        cited.length > 0
          ? `Based on the workspace knowledge base, here is what the available passages state: "${snippet}"`
          : '',
      citations: cited,
    })));
  }

  private reply(content: string): ChatCompletionResult {
    return {
      content,
      finishReason: 'stop',
      model: this.model,
      usage: { inputTokens: null, outputTokens: null },
    };
  }
}
