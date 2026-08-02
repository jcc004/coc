/**
 * The API emits ISO 8601 *basic* format — `20260731T052336.000Z` — which
 * `new Date()` does not accept. Every timestamp in a war or war-log payload
 * looks like this, so it must go through here.
 */
export function parseCocTimestamp(value: string): Date {
  const expanded = value.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
    '$1-$2-$3T$4:$5:$6',
  )
  return new Date(expanded)
}
