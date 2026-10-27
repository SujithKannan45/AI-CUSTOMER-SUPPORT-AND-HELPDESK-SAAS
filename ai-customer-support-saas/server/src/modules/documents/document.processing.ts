import { Types } from 'mongoose';

import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import { scheduleDocumentChunkIndexing } from '../rag/rag.triggers.js';

import {
  claimDocumentForProcessing,
  updateDocumentProcessingState,
} from './document.repository.js';
import { type DocumentFile, DOCUMENT_EXTRACTED_TEXT_MAX } from './document.types.js';
import {
  extractDocxText,
  extractJsonText,
  extractPdfText,
  extractPlainText,
  ExtractionError,
  type ExtractionErrorCode,
  type ExtractionOutcome,
} from './extraction/extraction.pipeline.js';
import { getStorageService } from './storage/storage.factory.js';

/**
 * Extraction orchestration — the "processing status" half of Prompt 12.
 *
 * Extraction runs IN-PROCESS after the upload response (no job runner exists
 * yet — the BullMQ phase owns retries/backoff). Guarantees that hold today:
 * - the PROCESSING status is claimed ATOMICALLY from an expected source
 *   state, so concurrent runs cannot double-process;
 * - every terminal path writes a bounded, safe result (bounded text or a
 *   SAFE `{code, message}` error) — no raw provider output is stored;
 * - claim/store/extraction are NOT atomic as a whole (documented in the
 *   data-model doc): a claim that then fails to update leaves the row in
 *   PROCESSING, which `POST /files/:id/reprocess` re-arms until the jobs
 *   phase adds automatic recovery.
 */
const SAFE_EXTRACTION_MESSAGES: Record<ExtractionErrorCode, string> = {
  EXTRACT_PDF_FAILED: 'The PDF could not be parsed',
  EXTRACT_DOCX_FAILED: 'The DOCX could not be parsed',
  EXTRACT_DECODING_FAILED: 'The file could not be decoded as text',
};

type Extractor = (bytes: Buffer) => Promise<ExtractionOutcome>;

function extractorFor(mediaType: DocumentFile['mediaType']): Extractor {
  switch (mediaType) {
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
      return extractPlainText;
    case 'application/json':
      return extractJsonText;
    case 'application/pdf':
      return extractPdfText;
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocxText;
    default: {
      throw new AppError(`No extractor registered for ${String(mediaType)}`, {
        statusCode: 500,
        code: 'DOCUMENT_EXTRACTOR_MISSING',
        isOperational: false,
      });
    }
  }
}

function capExtractedText(text: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (text.length <= DOCUMENT_EXTRACTED_TEXT_MAX) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, DOCUMENT_EXTRACTED_TEXT_MAX), truncated: true };
}

async function runExtractionOnce(
  workspaceId: string,
  documentId: string,
  fromStatuses: readonly DocumentFile['status'][],
): Promise<void> {
  const wsId = new Types.ObjectId(workspaceId);
  const docId = new Types.ObjectId(documentId);

  const claimed = await claimDocumentForProcessing(wsId, docId, fromStatuses);
  if (claimed === null) {
    // Lost the (re)processing race or the row vanished — nothing to do.
    return;
  }

  try {
    const bytes = await getStorageService().getObject(claimed.storageKey);
    const outcome = await extractorFor(claimed.mediaType)(bytes);
    const capped = outcome.text === null ? null : capExtractedText(outcome.text);

    const updated = await updateDocumentProcessingState(wsId, docId, {
      status: 'COMPLETED',
      extractionStatus: 'COMPLETED',
      extractedText: capped?.text ?? '',
      extractedTextTruncated: capped?.truncated ?? false,
      extractionError: null,
    });
    if (updated === null) {
      throw new Error('processing update found no live document');
    }

    // RAG projection (Prompt 13) — extraction completed with usable text:
    // fire-safe auto-indexing (no-op when no embedding provider is set).
    const extracted = capped?.text ?? '';
    if (extracted.trim().length > 0) {
      scheduleDocumentChunkIndexing(workspaceId, documentId);
    }
  } catch (error: unknown) {
    const typed = error instanceof ExtractionError ? error : undefined;
    const code = typed?.code ?? 'EXTRACT_FAILED';
    const message =
      typed !== undefined
        ? (SAFE_EXTRACTION_MESSAGES[typed.code] ?? 'Text extraction failed for this document')
        : 'Text extraction failed for this document';
    if (typed === undefined) {
      // Unknown failures (storage reads, outage) are logged with the cause;
      // the STORED error stays safe.
      logger.error({ documentId, err: error }, 'document extraction failed unexpectedly');
    } else {
      logger.warn({ documentId, code }, 'document extraction failed');
    }
    try {
      const failed = await updateDocumentProcessingState(wsId, docId, {
        status: 'FAILED',
        extractionStatus: 'FAILED',
        extractionError: { code, message },
        extractedText: null,
        extractedTextTruncated: false,
      });
      if (failed === null) {
        logger.error({ documentId }, 'extraction failure update found no live document');
      }
    } catch (updateError: unknown) {
      logger.error({ documentId, err: updateError }, 'extraction failure update itself failed');
    }
  }
}

/** Fire-and-forget extraction after an upload (claim source: PENDING only). */
export function scheduleDocumentExtraction(
  workspaceId: string,
  documentId: string,
): void {
  setImmediate(() => {
    void runExtractionOnce(workspaceId, documentId, ['PENDING']);
  });
}

/**
 * Operator/user-initiated re-extraction: re-arms from ANY live state,
 * including a PROCESSING row stranded by a crashed process (the atomic claim
 * still serializes against a genuinely concurrent run).
 */
export function scheduleDocumentReprocessing(
  workspaceId: string,
  documentId: string,
): void {
  setImmediate(() => {
    void runExtractionOnce(workspaceId, documentId, ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']);
  });
}
