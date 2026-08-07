/**
 * Narrowing helpers for reading `node:sqlite` result rows, where every column
 * comes back typed `unknown` (well, `SQLOutputValue`) regardless of the
 * schema. Split out because `asText`/`asTextOrNull` were copy-pasted
 * byte-for-byte into six store modules — `auth/store.ts`, `auth/events.ts`,
 * `cards/store.ts`, `cards/trades-store.ts`, `progress/store.ts` and
 * `shared-data/store.ts` — which is exactly the kind of drift risk
 * `cards/write-access.ts`'s own doc comment argues against for authorization
 * logic. The integer variants (`asInt`, `asIntOrNull`, `asIntOrUndefined`)
 * were deliberately left where they were: each store's version differs in
 * its default (`0` vs `null` vs `undefined`) or whether it delegates to
 * another local helper, so merging them would be a behavior change dressed
 * up as a refactor rather than the like-for-like consolidation this is.
 */

export function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function asTextOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
