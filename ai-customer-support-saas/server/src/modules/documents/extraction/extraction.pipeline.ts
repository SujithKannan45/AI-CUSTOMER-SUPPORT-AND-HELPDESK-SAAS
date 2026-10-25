/**
 * Document text extraction — the pluggable per-format extractors behind the
 * processing pipeline. Each extractor is a small, isolated unit so the
 * Prompt 13–15 ingestion phase can reuse them without the HTTP layer.
 *
 * Contracts:
 * - extractors RECEIVE raw bytes and RETURN plain text (or `null` when the
 *   format is structurally text-free);
 * - failures THROW with a stable machine code — the pipeline converts those
 *   into the SAFE `{code, message}` stored on the document and logs the real
 *   error server-side only;
 * - text decodes are bounded by the upload cap, so extraction cannot balloon
 *   past FILE_UPLOAD_MAX_BYTES of input.
 */
export interface ExtractionOutcome {
  /** Plain UTF-8 text; `null` only when the family is structurally text-free. */
  readonly text: string | null;
}

/** Codes surfaced in BOTH server logs and the stored safe error. */
export type ExtractionErrorCode = 'EXTRACT_PDF_FAILED' | 'EXTRACT_DOCX_FAILED' | 'EXTRACT_DECODING_FAILED';

export class ExtractionError extends Error {
  public readonly code: ExtractionErrorCode;

  public constructor(code: ExtractionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.code = code;
  }
}

export function extractPlainText(bytes: Buffer): Promise<ExtractionOutcome> {
  // Pure text families decode directly; strip a leading BOM when present.
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  return Promise.resolve({ text });
}

export async function extractPdfText(bytes: Buffer): Promise<ExtractionOutcome> {
  try {
    // The lib entry point avoids pdf-parse's implicit "debug" main script.
    const { default: parsePdf } = await import('pdf-parse/lib/pdf-parse.js');
    const parsed = await parsePdf(bytes);
    return { text: typeof parsed.text === 'string' ? parsed.text : '' };
  } catch (error: unknown) {
    throw new ExtractionError('EXTRACT_PDF_FAILED', 'PDF text extraction failed', { cause: error });
  }
}

export async function extractDocxText(bytes: Buffer): Promise<ExtractionOutcome> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: bytes });
    return { text: result.value };
  } catch (error: unknown) {
    throw new ExtractionError('EXTRACT_DOCX_FAILED', 'DOCX text extraction failed', { cause: error });
  }
}

export async function extractJsonText(bytes: Buffer): Promise<ExtractionOutcome> {
  // JSON is stored verbatim as text: the extractor contract keeps the SOURCE
  // text for future ingestion, it does not stringify the parsed value.
  return extractPlainText(bytes);
}
