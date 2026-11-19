/**
 * CSV serialisation for the bounded ticket report (Prompt 18).
 *
 * Safety:
 * - Every cell is escaped (quotes doubled, fields quoted when they contain a
 *   delimiter, quote or newline).
 * - Cells beginning with `=`, `+`, `-`, `@`, TAB or CR are prefixed with a
 *   single quote. This is the standard CSV formula-injection defence: a
 *   spreadsheet cannot evaluate a prefixed cell. (Negative numbers are not
 *   emitted by the report — durations are non-negative by definition.)
 * - The report itself contains only machine fields (ticket number, enum
 *   status/priority, ISO timestamps, boolean), so no ticket free text, customer
 *   identity or internal note can reach the file.
 */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Escapes one cell. Numbers/booleans are stringified; null/undefined become an
 * empty cell. The formula guard runs BEFORE quoting so the `'` prefix is the
 * cell's first character.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Builds CSV text with a stable `\n` line ending (RFC 4180 quotes). */
export function toCsv(
  header: readonly string[],
  rows: readonly ReadonlyArray<string | number | boolean | null>[],
): string {
  const lines = [header.map((cell) => csvCell(cell)).join(',')];
  for (const row of rows) lines.push(row.map((cell) => csvCell(cell)).join(','));
  return `${lines.join('\n')}\n`;
}

/** RFC 4180-ish guard for the download filename (ascii, no quotes/slashes). */
export function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}
