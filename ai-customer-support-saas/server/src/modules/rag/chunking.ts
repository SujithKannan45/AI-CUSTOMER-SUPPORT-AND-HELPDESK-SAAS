import { createHash } from 'node:crypto';

import { env } from '../../config/env.config.js';

/**
 * Text chunking pipeline (Prompt 13) — the pure, deterministic half of the
 * RAG ingestion boundary. Consumes extraction results (Prompt 12 documents)
 * and article content (Prompt 11); owns nothing about HTTP, providers or the
 * database, so the queued-jobs ingestion worker (BullMQ phase) can reuse it
 * without changes.
 *
 * Contracts:
 * - STRICTLY deterministic: the same input text + configuration produces the
 *   same chunks and the same hashes (content hashes are the reindex dedupe
 *   keys, so "stable" is a correctness requirement, not a nicety);
 * - bounded: sources above `env.RAG_MAX_SOURCE_CHARS` are REJECTED (never
 *   silently truncated) so a future bulk ingest cannot balloon memory;
 * - usable chunks are paragraph/heading-shaped where the source cooperates,
 *   with configurable size caps and cross-chunk overlap.
 */

export interface ChunkUnit {
  /** 0-based position within the chunk order. */
  readonly chunkIndex: number;
  readonly text: string;
  readonly textLength: number;
  /** sha-256 hex of the normalized chunk text. */
  readonly textHash: string;
}

export type ChunkingErrorReason = 'EMPTY_CONTENT' | 'SOURCE_TOO_LARGE';

export type ChunkingResult =
  | { readonly status: 'CHUNKED'; readonly sourceHash: string; readonly chunks: readonly ChunkUnit[] }
  | { readonly status: 'REJECTED'; readonly reason: ChunkingErrorReason };

/** Internal: paragraphs below this size are merged into their neighbor. */
const RAG_CHUNK_MERGE_MIN_CHARS = 40;

/** sha-256 (hex) of UTF-8 text — the content-hash vocabulary of the pipeline. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Normalization applied BEFORE splitting (and before the source hash, so the
 * reindex short-circuit compares normalized content, immune to cosmetic
 * line-ending/control-character churn):
 * - strips the BOM and control characters (except \n and \t),
 * - normalizes CRLF/CR to \n,
 * - collapses 3+ consecutive newlines to one blank line,
 * - trims outer whitespace.
 */
export function normalizeSourceText(raw: string): string {
  const withoutControlChars = raw
    .replace(/\uFEFF/g, '')
    // eslint-disable-next-line no-control-regex -- the control class IS the point
    .replace(/[\u0000-\u0009\u000b-\u000c\u000e-\u001f\u007f]/g, '');
  const normalizedLineEndings = withoutControlChars.replace(/\r\n?/g, '\n');
  return normalizedLineEndings.replace(/\n{3,}/g, '\n\n').trim();
}

/** Splits normalized text into blocks, attaching markdown headings to the paragraph they introduce. */
function paragraphBlocks(normalized: string): string[] {
  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let pendingHeading: string | undefined;

  for (const line of lines) {
    const isHeading = /^#{1,4}\s+\S/.test(line);
    if (isHeading && current.length > 0) {
      blocks.push(current.join('\n').trim());
      current = [];
    }
    if (isHeading) {
      pendingHeading = line.trim();
      continue;
    }
    if (line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n').trim());
        current = [];
        // A paragraph boundary closes the pending heading's attachment window.
        pendingHeading = undefined;
      }
      continue;
    }
    if (pendingHeading !== undefined) {
      current.push(pendingHeading);
      pendingHeading = undefined;
    }
    current.push(line.trimEnd());
  }
  if (current.length > 0) {
    blocks.push(current.join('\n').trim());
  }
  return blocks.filter((block) => block.length > 0);
}

/** Hard window used when a SINGLE block exceeds the chunk cap. */
function hardSplit(block: string, chunkMax: number, overlap: number): string[] {
  const windows: string[] = [];
  let cursor = 0;
  while (cursor < block.length) {
    let end = Math.min(cursor + chunkMax, block.length);
    if (end < block.length) {
      // Prefer a boundary inside the candidate window (period, then space).
      const window = block.slice(cursor, end);
      const period = window.lastIndexOf('. ');
      const space = window.lastIndexOf(' ');
      const cut = period > chunkMax * 0.5 ? period + 1 : space > chunkMax * 0.5 ? space : -1;
      if (cut > 0) end = cursor + cut;
    }
    windows.push(block.slice(cursor, end).trim());
    if (end >= block.length) break;
    cursor = Math.max(end - overlap, cursor + 1); // +1 keeps progress without overlap.
  }
  return windows;
}

/** Packs (possibly over-cap pre-split) blocks into final chunks with tail overlap. */
function packBlocks(blocks: readonly string[], chunkMax: number, overlap: number): string[] {
  const atoms: string[] = [];
  for (const block of blocks) {
    if (block.length <= chunkMax) {
      atoms.push(block);
    } else {
      atoms.push(...hardSplit(block, chunkMax, overlap));
    }
  }

  const chunks: string[] = [];
  let current = '';
  for (const atom of atoms) {
    const candidate =
      current.length === 0 ? atom : `${current}\n\n${atom}`;
    if (candidate.length <= chunkMax) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      chunks.push(current);
      const tail = overlap > 0 ? current.slice(-overlap) : '';
      current = tail.length > 0 ? `${tail}\n\n${atom}` : atom;
      if (current.length === 0) continue;
      // One atom alone may still exceed the cap if tail pushed it over.
      if (current.length > chunkMax) {
        chunks.push(...hardSplit(current, chunkMax, overlap));
        current = '';
      }
    } else {
      chunks.push(...hardSplit(atom, chunkMax, overlap));
    }
  }
  if (current.length > 0) chunks.push(current);

  // Merge trailing fragments below the merge threshold so the tail of a
  // source does not become a meaningless micro-chunk.
  while (chunks.length >= 2) {
    const last = chunks[chunks.length - 1] as string;
    if (last.length >= RAG_CHUNK_MERGE_MIN_CHARS) break;
    const merged = `${chunks[chunks.length - 2]}\n\n${last}`;
    if (merged.length > chunkMax) break; // Keep the cap: leave the fragment.
    chunks.splice(chunks.length - 2, 2, merged);
  }

  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
}

/**
 * The single entry point of the chunking pipeline. Deterministic under the
 * SAME configuration; hashes are computed over the FINAL chunk text.
 */
export function chunkSourceText(rawSource: string): ChunkingResult {
  const normalized = normalizeSourceText(rawSource);
  if (normalized.length === 0) {
    return { status: 'REJECTED', reason: 'EMPTY_CONTENT' };
  }
  if (normalized.length > env.RAG_MAX_SOURCE_CHARS) {
    return { status: 'REJECTED', reason: 'SOURCE_TOO_LARGE' };
  }

  const sourceHash = sha256Text(normalized);
  const packed = packBlocks(
    paragraphBlocks(normalized),
    env.RAG_CHUNK_MAX_CHARS,
    env.RAG_CHUNK_OVERLAP_CHARS,
  );
  if (packed.length === 0) {
    // Unreachable in practice (normalization guarantees >=1 non-empty char),
    // but a rejected result is the safe answer to an empty pack.
    return { status: 'REJECTED', reason: 'EMPTY_CONTENT' };
  }

  const chunks: ChunkUnit[] = packed.map((text, chunkIndex) => ({
    chunkIndex,
    text,
    textLength: text.length,
    textHash: sha256Text(text),
  }));
  return { status: 'CHUNKED', sourceHash, chunks };
}
