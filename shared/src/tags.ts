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
 * Accepts the messy things people paste — `#abc123`, `abc123`, `%23ABC123`,
 * with stray whitespace — and returns the canonical `#ABC123` form.
 *
 * Only structure is enforced (length, alphanumeric). The alphabet is checked
 * separately and advisorily — see {@link usesCanonicalAlphabet}.
 *
 * @throws {InvalidTagError} on input that cannot be a tag at all.
 */
export function normalizeTag(input: string): string {
  const cleaned = decodeURIComponent(input.trim())
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
