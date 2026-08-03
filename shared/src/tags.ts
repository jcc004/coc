/**
 * Supercell documents tags as base-14 over this alphabet — note the letter O is
 * absent, since it uses zero. People transcribing a tag off a screen mix the two
 * up constantly, so normalisation fixes that.
 */
const CANONICAL_ALPHABET = '0289PYLQGRJCUV'

export class InvalidTagError extends Error {
  constructor(readonly input: string) {
    super(`"${input}" is not a valid Clash of Clans tag`)
    this.name = 'InvalidTagError'
  }
}

/**
 * Percent-decodes when it can and hands the input straight back when it cannot.
 *
 * The decode exists so a `%23ABC123` pasted out of a URL is accepted, which people
 * really do. It must not be *required* to succeed: Hono decodes a path parameter
 * before a handler ever sees it, so `GET /api/players/%25ZZ` arrives here as the
 * literal `%ZZ`, and `decodeURIComponent` throws `URIError` on a lone `%`. That
 * `URIError` is not an `InvalidTagError`, so it sailed past the specific branch in
 * the app's `onError` and became a 500 with a stack trace on stderr — a malformed
 * tag answered as a server fault, and a way for any signed-in caller to fill the
 * log.
 *
 * The rejected alternative was dropping the decode entirely and making decoding the
 * caller's job. That is the cleaner rule, and it would settle the real smell: the
 * decode is a *second* one for a path parameter, which is the only reason `%2523`
 * and `%23` mean the same thing there while differing everywhere else. It was
 * rejected because the decode is also what makes `%23ABC123` work from a query
 * string or a pasted URL, and removing it would break callers to fix an
 * inconsistency nobody has been bitten by. So the decode stays, best-effort, and
 * whatever comes out is validated the same way — a `%` that survives is simply not
 * alphanumeric, which is the 400 it always should have been.
 */
function decodeIfPossible(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

/**
 * Accepts the messy things people paste — `#abc123`, `abc123`, `%23ABC123`,
 * with stray whitespace — and returns the canonical `#ABC123` form.
 *
 * Only structure is enforced (length, alphanumeric). The alphabet is checked
 * separately and advisorily — see {@link usesCanonicalAlphabet}.
 *
 * @throws {InvalidTagError} on input that cannot be a tag at all — including input
 * that is not decodable, which is malformed rather than exceptional.
 */
export function normalizeTag(input: string): string {
  const cleaned = decodeIfPossible(input.trim())
    .replace(/^#/, '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/O/g, '0')

  if (cleaned.length < 3 || cleaned.length > 12) throw new InvalidTagError(input)
  if (!/^[0-9A-Z]+$/.test(cleaned)) throw new InvalidTagError(input)

  return `#${cleaned}`
}

/**
 * Advisory only — never gate a lookup on this.
 *
 * The API answers `404 notFound` for every tag it dislikes, so a malformed tag
 * and a merely-unknown one are indistinguishable from the outside; we cannot
 * confirm the documented alphabet is exhaustive. A tag failing this check is
 * worth warning about (it is probably a typo) but is still worth sending — the
 * API is the only authority.
 */
export function usesCanonicalAlphabet(input: string): boolean {
  try {
    const tag = normalizeTag(input).slice(1)
    return [...tag].every((char) => CANONICAL_ALPHABET.includes(char))
  } catch {
    return false
  }
}

export function isValidTag(input: string): boolean {
  try {
    normalizeTag(input)
    return true
  } catch {
    return false
  }
}

/** Canonical tag, percent-encoded for use in an API path segment. */
export function encodeTagForPath(input: string): string {
  return encodeURIComponent(normalizeTag(input))
}
