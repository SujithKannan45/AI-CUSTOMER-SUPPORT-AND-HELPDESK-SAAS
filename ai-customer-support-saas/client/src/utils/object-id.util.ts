const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

/**
 * True when a route parameter has the 24-hex shape every backend id uses.
 *
 * This is a *format* check, never an authorization or existence check: a
 * well-formed id for another tenant's record still resolves to 404 on the
 * server. It exists so an obviously malformed link is rejected locally instead
 * of producing a pointless 422 round trip.
 */
export function isObjectId(value: string | undefined): boolean {
  return value !== undefined && OBJECT_ID_PATTERN.test(value);
}
