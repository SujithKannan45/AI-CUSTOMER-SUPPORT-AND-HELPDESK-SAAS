/**
 * Declaration for the pdf-parse LIBRARY entrypoint ('pdf-parse/lib/pdf-parse.js')
 * — deliberately NOT the package root, whose default import activates the
 * bundled debug script when required as a main module.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  export interface PdfParseResult {
    /** Extracted plain text across all pages. */
    text: string;
    /** Total pages the parser saw. */
    numpages: number;
    /** Per-page metadata, if present. */
    info?: unknown;
    metadata?: unknown;
  }

  function parsePdf(data: Buffer): Promise<PdfParseResult>;

  export default parsePdf;
}
