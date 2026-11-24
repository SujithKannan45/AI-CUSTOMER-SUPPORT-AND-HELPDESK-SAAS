/**
 * Helpers for the `details` object of a 422 `HttpApiError`.
 *
 * The server's validation middleware emits `{ field: string[] }`. Values are
 * untrusted text: they are only ever rendered as plain text in a form alert,
 * never interpreted or logged.
 */
export function firstFieldError(details: unknown, field: string): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const value = (details as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return undefined;
  const first: unknown = value[0];
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}
