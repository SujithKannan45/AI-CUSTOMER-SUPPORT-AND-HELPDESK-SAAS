import {
  isDocumentMediaType,
  DOCUMENT_FILENAME_MAX,
  DOCUMENT_MEDIA_TYPES,
  type DocumentMediaType,
} from './document.types.js';

/**
 * Upload-side media handling — the security rules that run BEFORE any byte is
 * persisted:
 *
 * - Content SNIFFING: binary families (PDF, DOCX) must carry their magic
 *   bytes, so a renamed text file cannot pose as a PDF and a PDF cannot pose
 *   as text. Client-declared content types are inputs to the decision, never
 *   the decision itself.
 * - Filename SANITIZING: the client filename is only ever METADATA. Path
 *   separators, control characters and reserved names are stripped; the
 *   actual storage key is composed server-side (UUID + canonical extension),
 *   so no client value reaches a filesystem path.
 * - Text families containing NUL bytes in the first kilobyte are rejected as
 *   mislabeled binaries rather than silently garbled by a lossy decode.
 */
export type SniffedMedia =
  | { readonly accepted: true; readonly mediaType: DocumentMediaType; readonly filename: string }
  | { readonly accepted: false; readonly code: SniffErrorCode; readonly message: string };

export type SniffErrorCode =
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MEDIA_MISMATCH'
  | 'BINARY_MASQUERADING_AS_TEXT'
  | 'FILENAME_REQUIRED'
  | 'EMPTY_FILE';

const DOCUMENT_EXTENSIONS = new Map<string, DocumentMediaType>(
  Object.entries(DOCUMENT_MEDIA_TYPES).map(([type, policy]) => [policy.extension, type as DocumentMediaType]),
);

function hasMagicPrefix(buffer: Buffer, magic: readonly number[]): boolean {
  if (buffer.byteLength < magic.length) return false;
  return magic.every((byte, index) => buffer[index] === byte);
}

function declaredTypeOf(directive: string): DocumentMediaType | undefined {
  const raw = directive.split(';')[0]?.trim().toLowerCase() ?? '';
  if (isDocumentMediaType(raw)) return raw;
  return undefined;
}

/** Extension-derived type for the DECLARED filename (metadata signal). */
function extensionTypeOf(filename: string): DocumentMediaType | undefined {
  const match = /\.([a-z0-9]{1,10})$/i.exec(filename);
  const ext = match?.[1]?.toLowerCase() ?? '';
  return DOCUMENT_EXTENSIONS.get(ext);
}

export function sanitizeFilename(input: string): string {
  const basename = input.split(/[/\\]/).pop() ?? '';
  // Control characters are the POINT of this character class (they must never
  // survive into a header value or a filename).
  // eslint-disable-next-line no-control-regex
  const stripped = basename.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, DOCUMENT_FILENAME_MAX);
}

export function sniffDocumentMedia(
  declaredContentType: string,
  declaredFilename: string,
  bytes: Buffer,
): SniffedMedia {
  const filename = sanitizeFilename(declaredFilename);
  if (filename.length === 0) {
    return {
      accepted: false,
      code: 'FILENAME_REQUIRED',
      message: 'The file must have a readable name',
    };
  }
  if (bytes.byteLength === 0) {
    return { accepted: false, code: 'EMPTY_FILE', message: 'Empty files are rejected' };
  }

  const declared = declaredTypeOf(declaredContentType);
  const byExtension = extensionTypeOf(filename);

  // The EFFECTIVE declared type: the content-type header when allowlisted,
  // otherwise the filename extension. Neither alone is trusted.
  const effective = declared ?? byExtension;
  if (effective === undefined) {
    return {
      accepted: false,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message:
        'Only txt, md, csv, json, pdf and docx files are accepted (with a matching content type or extension)',
    };
  }
  if (declared !== undefined && byExtension !== undefined && declared !== byExtension) {
    return {
      accepted: false,
      code: 'MEDIA_MISMATCH',
      message: 'The declared content type does not match the filename extension',
    };
  }

  const policy = DOCUMENT_MEDIA_TYPES[effective];
  if (policy.magic !== undefined && !hasMagicPrefix(bytes, policy.magic)) {
    return {
      accepted: false,
      code: 'MEDIA_MISMATCH',
      message: 'File content does not match its declared type',
    };
  }

  // Text families: reject NUL-laden payloads at the door (mislabeled binaries
  // would otherwise survive as garbled "extracted" text).
  if (policy.magic === undefined) {
    const probe = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
    if (probe.includes(0)) {
      return {
        accepted: false,
        code: 'BINARY_MASQUERADING_AS_TEXT',
        message: 'This text file contains binary content and was rejected',
      };
    }
  }

  return { accepted: true, mediaType: effective, filename };
}

/** Canonical content type for the sniffed family (stored / download headers). */
export function canonicalContentTypeOf(mediaType: DocumentMediaType): string {
  return DOCUMENT_MEDIA_TYPES[mediaType].mime;
}

/** The composed storage key — UUID + canonical extension, workspace-namespaced. */
export function composeStorageKey(workspaceId: string, mediaType: DocumentMediaType, uuid: string): string {
  return `workspaces/${workspaceId}/files/${uuid}.${DOCUMENT_MEDIA_TYPES[mediaType].extension}`;
}
