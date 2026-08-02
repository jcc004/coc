import { randomBytes } from 'node:crypto'

/**
 * The password an admin hands over when somebody is locked out.
 *
 * There is no email delivery in this app, so this string travels by whatever
 * channel the two people already have — read down a phone, typed into a chat,
 * copied off a screen. That is what shapes both constants below.
 *
 * The alphabet drops every glyph a person cannot name unambiguously out loud or
 * tell apart in a sans-serif font: `l` and `1`, `O` and `0`, and `I` (which is
 * indistinguishable from `l` in most UI fonts, so dropping one of the pair is not
 * enough). What is left is 57 symbols.
 *
 * 20 characters of that is ~117 bits, far past the 12-character minimum a human
 * would choose. Length is cheap here because nobody has to remember it — it is
 * used once and then replaced, which is what `must_change_password` enforces.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

export const TEMP_PASSWORD_LENGTH = 20

/**
 * Rejection sampling, not `byte % 57`.
 *
 * 256 is not a multiple of 57, so folding a whole byte would make the first 28
 * symbols ~1.14× likelier than the rest. That is a small bias, but it is a free
 * one to avoid: discard any byte at or above the largest multiple of the alphabet
 * size that fits in a byte and the remaining draws are exactly uniform.
 */
const REJECT_AT = 256 - (256 % ALPHABET.length)

export function generateTemporaryPassword(length: number = TEMP_PASSWORD_LENGTH): string {
  let password = ''

  while (password.length < length) {
    // Overdraw so the ~11% rejection rate almost never costs a second syscall.
    for (const byte of randomBytes(length - password.length + 8)) {
      if (byte >= REJECT_AT) continue
      // charAt rather than [], which `noUncheckedIndexedAccess` types as possibly
      // undefined even though the modulo makes that unreachable.
      password += ALPHABET.charAt(byte % ALPHABET.length)
      if (password.length === length) break
    }
  }

  return password
}
