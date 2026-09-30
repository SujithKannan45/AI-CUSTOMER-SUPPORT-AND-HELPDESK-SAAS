/**
 * AI abstraction layer — contracts only, no implementation yet.
 *
 * The support platform will need several AI capabilities: answering customer
 * questions from the knowledge base (RAG), drafting agent replies, classifying
 * tickets, and generating embeddings for retrieval. Keeping these behind
 * interfaces means provider SDKs (OpenAI, Gemini, local models) can be swapped
 * without touching feature services, and fakes can be used in tests.
 */

/** Result of retrieving relevant knowledge-base chunks for a query. */
export interface RetrievedContext {
  readonly chunkId: string;
  readonly documentId: string;
  readonly score: number;
  readonly text: string;
}

export interface RagAnswer {
  readonly answer: string;
  readonly citations: RetrievedContext[];
  /** Confidence score from the model, used to decide when to hand off to a human. */
  readonly confidence: number;
}

/**
 * A question-answering capability grounded in workspace knowledge.
 *
 * Future `rag.service.ts` implementations will compose retrieval (vector
 * store) + generation (LLM) behind this interface.
 */
export interface RagService {
  answer(question: string, context: readonly RetrievedContext[]): Promise<RagAnswer>;
}

/** Embedding generation for semantic search over knowledge-base content. */
export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
}

/**
 * Factory for provider-backed implementations. Registered once at startup
 * (see `server/src/modules/ai/README.md`) so feature modules depend only on
 * these interfaces — never on a specific SDK.
 */
export interface AiServiceRegistry {
  readonly rag: RagService | null;
  readonly embeddings: EmbeddingService | null;
}
