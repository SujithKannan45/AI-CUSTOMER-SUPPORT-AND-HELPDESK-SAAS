/**
 * Field id contract shared by `<Field>` and the controls it wraps.
 *
 * Kept in its own module so the field component file only exports components
 * (React Fast Refresh requirement) while consumers can still derive the same
 * ids for `aria-describedby`.
 */

export function fieldDescriptionId(id: string): string {
  return `${id}-description`;
}

export function fieldErrorId(id: string): string {
  return `${id}-error`;
}

/** Builds `aria-describedby` for a field control, or undefined when empty. */
export function fieldDescribedBy(id: string, options: { description?: string; error?: string }): string | undefined {
  const ids = [
    options.description !== undefined ? fieldDescriptionId(id) : null,
    options.error !== undefined ? fieldErrorId(id) : null,
  ].filter((value): value is string => value !== null);

  return ids.length > 0 ? ids.join(' ') : undefined;
}
