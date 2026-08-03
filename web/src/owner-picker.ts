import type { AdminUser, OwnerRecord } from '@coc/shared'

/**
 * The rules behind the roster's Owner picker: what the cell is showing, which
 * accounts it may offer, and what a legacy label probably meant.
 *
 * Ownership is an **account** now (`PUT /api/owners/:tag` takes a `userId` and
 * nothing else), but this install carries 50 assignments of which 32 predate
 * accounts entirely — free text somebody typed, linked to nobody. Those rows are
 * the outstanding migration, and the picker exists to work through them, so the
 * three questions below are the ones it has to answer per row:
 *
 * - is this cell empty, a real account, or one of the legacy labels?
 * - which accounts may be chosen, given that the row's *current* value has to stay
 *   representable even when it is an account the list would otherwise leave out?
 * - for a legacy label, is there an account that is obviously the same person?
 *
 * The third is the one that earns a pure module of its own. The real data holds
 * `lisa_sweatt` against an account displayed as `lisa sweatt`: the same person, and
 * a near miss that no exact-match backfill will ever catch — the server's own
 * migration matched on trimmed, case-folded equality and left this row behind. So
 * the comparison here folds punctuation and spacing as well as case, and it only
 * suggests when exactly one account matches. A suggestion is a prompt for an admin
 * to confirm, never an assignment: guessing wrong hands somebody else's base — and
 * the right to write its card counts — to the wrong person.
 */

/** An account the picker can offer, or the value it is currently showing. */
export interface OwnerOption {
  userId: number
  /** The account's display name, which is what the server stores as the label. */
  label: string
}

/** What one Owner cell is showing. */
export type OwnerCell =
  /** No assignment at all. */
  | { kind: 'unassigned' }
  /** Assigned to an account; `label` is that account's current display name. */
  | { kind: 'account'; userId: number; label: string }
  /**
   * Pre-accounts free text, linked to nobody. It grants no permissions — see
   * `cardEntryAccess` — so it is the thing an admin still has to fix, and
   * `suggestion` is the account it most likely meant, or null.
   */
  | { kind: 'legacy'; label: string; suggestion: OwnerOption | null }

/**
 * Folds a name to the form two spellings of the same person share: case, leading
 * and trailing space, and every run of anything that is not a letter or a digit.
 *
 * `lisa_sweatt`, `Lisa Sweatt` and `lisa-sweatt` all fold to `lisa sweatt`. Unicode
 * letters count, because a display name is free text and `Ünal` is a name.
 */
export function foldOwnerName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Display-name order, case-insensitively, so the list reads alphabetically. */
function byLabel(a: OwnerOption, b: OwnerOption): number {
  const folded = a.label.toLowerCase().localeCompare(b.label.toLowerCase())
  // Ties broken by id so the order is stable rather than dependent on the fetch.
  return folded !== 0 ? folded : a.userId - b.userId
}

/**
 * The accounts to offer, in display order.
 *
 * Disabled accounts are left out: a disabled account cannot sign in, so pointing a
 * base at one is a label that grants nobody the write — the very thing the
 * migration is trying to get rid of. The exception is the row's own current owner,
 * passed as `currentUserId`: an option list that cannot represent what the cell is
 * already showing would silently redraw the row as somebody else, so a disabled (or
 * since-deleted, hence unknown) current owner is kept, using `currentLabel` when no
 * account answers to that id.
 */
export function ownerOptions(
  accounts: readonly AdminUser[],
  current?: { userId: number; label: string },
): OwnerOption[] {
  const options = accounts
    .filter((account) => account.disabledAt === null || account.id === current?.userId)
    .map((account) => ({ userId: account.id, label: account.displayName }))

  if (current && !options.some((option) => option.userId === current.userId)) {
    options.push({ userId: current.userId, label: current.label })
  }

  return options.sort(byLabel)
}

/**
 * The account a legacy label most likely names, or null.
 *
 * Only ever a *unique* fold-equal match. Two accounts called `Sam` and `sam.` are
 * not a suggestion, they are a question for a human, and offering the first would
 * be a coin toss dressed up as an answer.
 */
export function suggestOwnerAccount(
  label: string,
  accounts: readonly AdminUser[],
): OwnerOption | null {
  const wanted = foldOwnerName(label)
  if (!wanted) return null

  const matches = accounts
    .filter((account) => foldOwnerName(account.displayName) === wanted)
    .map((account) => ({ userId: account.id, label: account.displayName }))

  return matches.length === 1 ? (matches[0] ?? null) : null
}

/**
 * What to draw in one Owner cell.
 *
 * `accounts` is empty for a non-admin — `GET /api/admin/users` is admin-only and is
 * not called for anyone else — and that must not turn an owned base into an
 * unowned-looking one. It cannot: the label comes from the assignment, which
 * everybody may read, and the account list only ever adds the suggestion.
 */
export function ownerCellFor(
  record: OwnerRecord | undefined,
  accounts: readonly AdminUser[],
): OwnerCell {
  const label = record?.owner?.trim() ?? ''
  if (!record || !label) return { kind: 'unassigned' }

  const userId = record.ownerUserId ?? null
  if (userId !== null) return { kind: 'account', userId, label }

  return { kind: 'legacy', label, suggestion: suggestOwnerAccount(label, accounts) }
}

/** How many of these assignments are still unlinked labels. The work remaining. */
export function legacyOwnerCount(records: readonly OwnerRecord[]): number {
  return records.filter((record) => ownerCellFor(record, []).kind === 'legacy').length
}

/** What the picker's `<select>` value means. `null` for a value it never offered. */
export type OwnerChoice = { kind: 'clear' } | { kind: 'assign'; userId: number }

/**
 * Reads a chosen `<select>` value.
 *
 * `''` is the "no owner" option and clears the assignment — clearing has to stay
 * possible, because a base can change hands or leave the clan and a stale owner is
 * worse than none. Anything that is not `''` or a positive integer is refused
 * rather than coerced: `Number('')` is 0 and `userId: 0` would be a request to
 * assign a base to an account that cannot exist.
 */
export function parseOwnerChoice(value: string): OwnerChoice | null {
  if (value === '') return { kind: 'clear' }
  if (!/^[1-9][0-9]*$/.test(value)) return null
  return { kind: 'assign', userId: Number(value) }
}
