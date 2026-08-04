/**
 * Email is the login credential, so its normalization has to be identical on
 * both sides: the server stores and compares the normalized form, and the login
 * form has to send something that will match. One declaration here rather than a
 * regex copied into each.
 *
 * Validation is deliberately minimal — non-empty, exactly one `@`, non-empty
 * local and domain parts, no whitespace. Full RFC 5322 is unimplementable in a
 * regex and every attempt at it rejects addresses that actually deliver; the only
 * real test of an address is sending to it, which this app does not do.
 */

/** Trimmed and lowercased. Storage, comparison and the UNIQUE index all use this. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase()
}

export function isValidEmail(input: string): boolean {
  const email = normalizeEmail(input)
  if (!email || /\s/.test(email)) return false

  const parts = email.split('@')
  if (parts.length !== 2) return false

  const [local, domain] = parts
  return Boolean(local && domain)
}

/**
 * The part before the `@`, used as the default display name so a new account
 * always has something readable to show without asking for it twice.
 */
export function emailLocalPart(input: string): string {
  return normalizeEmail(input).split('@')[0] ?? ''
}

export const EMAIL_RULE = 'An email address: one @, no spaces.'
