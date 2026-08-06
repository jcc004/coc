import type { BaseInventory } from '@coc/shared'
import { parseStamp } from './build-info.ts'
import { ALL_CARDS, cardCategoriesInOrder, cardsInCategory, countMap } from './cards.ts'
import type { GeneratedCard } from './cards.ts'
import { UNASSIGNED_OWNER } from './saved-table.ts'

/**
 * The two group-wide readings of the card event: how far each base has got, and
 * how many copies of each card the whole group is sitting on.
 *
 * Both are here rather than in `CardsView` because both have a rule with a wrong
 * answer that a screenshot would not catch:
 *
 * - a leaderboard needs a **total** order. Early in an event almost everybody
 *   holds a handful, so ties on "distinct cards" are the common case, not the
 *   edge one — and a comparator that stops at the first key leaves the tied rows
 *   in whatever order the array happened to arrive in, which is a list that
 *   reshuffles itself between renders;
 * - the totals list must stay in the **grid's** order whatever the counts are. It
 *   only earns its place by scanning card-for-card against the sixty tiles above
 *   it, and a list that sorted itself by count would be a different list that
 *   happened to hold the same numbers;
 * - the board's **owner filter runs after the ranking, never before it**, so a
 *   narrowed board still carries each base's standing among all of them. Ranking
 *   the survivors instead would renumber four bases to 1–4 and read as if they
 *   were the whole clan — the same failure paging would cause if it renumbered,
 *   and just as invisible in a screenshot.
 *
 * Counting is not re-implemented: `countMap` from `cards.ts` is what the grid
 * itself expands a base's sparse counts with, so a card id the list does not know,
 * or a count that is not a positive number, is dropped here on exactly the terms
 * it is dropped there.
 */

/* ---------- the leaderboard ---------- */

/** What the first copy of a card is worth, and how many copies score above 1. */
const FIRST_COPY_POINTS = 10

/**
 * What one card is worth to a base holding `copies` of it.
 *
 * The first copy scores 10, the second 9, and so on down to the tenth at 1;
 * every copy past the tenth scores 1. So a card held once is 10 points, twice 19,
 * three times 27, ten times 55 — and sixty cards at ten copies each is 3,300.
 *
 * The point of the curve is that the first copy of a card you lack is worth ten
 * times the eleventh copy of one you already have, so the ranking rewards
 * breadth while still crediting the spares that make trading possible at all.
 *
 * The past-ten arm is **deliberately unreachable today**: `MAX_CARD_COUNT` caps
 * entry at ten, so `copies` never exceeds it through the UI. It is implemented
 * anyway so that raising the cap cannot silently change what a base scores.
 */
export function cardPoints(copies: number): number {
  if (!Number.isFinite(copies) || copies <= 0) return 0

  const whole = Math.floor(copies)
  const scored = Math.min(whole, FIRST_COPY_POINTS)
  // Sum of 10, 9, … down to (11 - scored): an arithmetic series, so closed form.
  // The test checks this against a naive loop rather than against itself.
  const descending = (scored * (2 * FIRST_COPY_POINTS - scored + 1)) / 2
  const beyond = Math.max(0, whole - FIRST_COPY_POINTS)

  return descending + beyond
}

/** A tracked base, named, as the page already knows how to name one. */
export interface StandingBase {
  /** Canonical `#TAG` — still the identity, as everywhere else. */
  tag: string
  /** The member name, or the tag when no roster we can see names it. */
  label: string
  /**
   * Who would do the trading, or `null` when nobody is assigned — the label to
   * *print*. The owner filter no longer groups or matches on this; see
   * {@link Ownable.ownerUserId} for the field it actually keys on.
   */
  owner: string | null
  /**
   * The linked account this base belongs to, or `null` for an unassigned base
   * *and* for one still carrying only an unlinked legacy label — see
   * {@link Ownable.ownerUserId}, which this feeds.
   */
  ownerUserId: number | null
}

export interface BaseStanding extends StandingBase {
  /** The measure the ranking is on — see {@link cardPoints}. */
  points: number
  /** Distinct cards held. No longer the measure, but still what `17/60` counts. */
  distinct: number
  /** Copies, spares included. */
  total: number
  /** The deck size the fraction is out of, so the row prints `17/60`. */
  size: number
  /**
   * Whether anybody has ever saved this base — the same distinction the grid's
   * attribution line draws. A base with no record is "nothing recorded yet", not a
   * base that has been checked and holds nothing.
   */
  recorded: boolean
  /**
   * When this base's counts were last saved, or `null` for a base nobody has ever
   * saved. Straight off `BaseInventory.updatedAt`, which the server keeps in
   * `card_base_updates` rather than deriving from the sparse count rows — so a base
   * cleared back to zero still carries the stamp that says somebody checked it.
   *
   * Normalized from `undefined` to `null` here on purpose: absent is a *state* this
   * board prints in words ("Never"), not a field a formatter is left to trip over.
   * See {@link lastUpdatedCell}.
   */
  updatedAt: string | null
  /**
   * Standing, sharing a number on a genuine tie.
   *
   * Tied on **points**, not on the whole sort key: the name and tag are only in the
   * comparator to stop the list flickering, so two bases separated by nothing but
   * their names have not out-scored one another and must not be printed as 4th and
   * 5th. Ties skip the numbers they consume (1, 2, 2, 4), so a rank still says how
   * many bases are ahead.
   */
  rank: number
}

/**
 * The tracked bases, best first.
 *
 * **The order is: points descending, then distinct descending, then member name,
 * then tag.** Points are the measure — see `cardPoints` for the curve, which pays
 * ten for a card you did not have and one for a spare past the tenth, so breadth
 * outweighs hoarding without spares counting for nothing. Distinct breaks a tie
 * because reaching the same score across more of the sixty is the better position.
 * The name and then the tag are not merit at all; they are there to make the order
 * *total*, so two level bases render in the same sequence every time rather than
 * swapping places on each re-render.
 *
 * Takes the whole inventory rather than one base's counts, so the caller does not
 * have to pre-join: a base with no entry in it is a real base with nothing
 * recorded, and it ranks last rather than being dropped off the board.
 */
export function baseStandings(
  bases: readonly StandingBase[],
  inventory: readonly BaseInventory[],
  size: number = ALL_CARDS.length,
): BaseStanding[] {
  const byTag = new Map(inventory.map((base) => [base.tag, base]))

  const rows = bases.map((base) => {
    const held = byTag.get(base.tag)
    const counts = countMap(held)
    let total = 0
    let points = 0
    for (const count of counts.values()) {
      total += count
      points += cardPoints(count)
    }
    return {
      ...base,
      points,
      distinct: counts.size,
      total,
      size,
      /* A base saved and then cleared back to zero keeps its stamp, so it reads as
         checked-and-empty rather than as never entered. */
      recorded: held !== undefined && (counts.size > 0 || held.updatedAt !== undefined),
      updatedAt: held?.updatedAt ?? null,
      rank: 0,
    }
  })

  rows.sort(
    (a, b) =>
      b.points - a.points ||
      b.distinct - a.distinct ||
      a.label.localeCompare(b.label) ||
      a.tag.localeCompare(b.tag),
  )

  let rank = 0
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    /* Points alone decide a tie. Two bases on the same score have not out-collected
       one another, whatever their names sort like. */
    if (!previous || previous.points !== row.points) {
      rank = index + 1
    }
    row.rank = rank
  })

  return rows
}

/* ---------- reading the board: the owner filter and the staleness column ---------- */

/**
 * The two fields {@link standingOwnerOptions} and {@link filterStandingsByOwner} touch.
 *
 * Generic over this rather than fixed to {@link BaseStanding} so the progress board's
 * `ProgressGridRow` (`progress-grid.ts`) can share the exact same filter — same options,
 * same sentinels, same "narrows what's shown, never what's ranked" rule — without
 * depending on points, rank or any of the rest of a standing. `saved-table.ts` already
 * takes this shape for owner logic (`OwnableRow`, `planOwnerChange`), so a second row
 * shape sharing a narrow structural type here follows the same precedent rather than
 * inventing a new one.
 *
 * **`ownerUserId` is the identity the filter groups and matches on; `owner` is only
 * ever printed.** Two rows are "the same owner" when their account ids agree, never
 * when their labels happen to read the same — which also means two different accounts
 * that happen to share a display name are correctly kept apart, something a label
 * comparison could not do. A row whose owner is an unlinked legacy label has
 * `ownerUserId: null`, the same as a row with no assignment at all, so it now falls
 * under {@link UNASSIGNED_OWNER} rather than under its own option keyed by that label.
 * That is a deliberate narrowing, not an oversight: this app has exactly one definition
 * of "is this my base" everywhere else — the linked account — and a filter that grouped
 * by free text was the one place still answering a different question.
 */
export interface Ownable {
  /** Who would do the trading, or `null` when nobody is assigned. Display only. */
  owner: string | null
  /** The account this base belongs to, or `null` — see the type doc for what that means. */
  ownerUserId: number | null
}

/**
 * "Every owner", the value the board opens on, so it opens unchanged.
 *
 * `''` rather than a word, matching the roster's Owner filter — an empty select value
 * is "no filter applied" everywhere in this app, and the third state (a base with no
 * owner at all) is what needs a sentinel of its own. That sentinel is
 * {@link UNASSIGNED_OWNER}, imported rather than respelled here: two filters answering
 * the same question with two different magic strings is how one of them ends up
 * matching a real owner named `#unassigned`.
 */
export const ALL_OWNERS = ''

/** One entry of the board's Owner select. */
export interface OwnerFilterOption {
  /**
   * What the select stores: an account id, stringified since a `<select>`'s values
   * are always strings, or {@link ALL_OWNERS} or {@link UNASSIGNED_OWNER}.
   */
  value: string
  /** What it prints — the owner's display name, never the raw id. */
  label: string
}

/** What the "no owner at all" option is called, in the words the Owner column uses. */
const UNOWNED_OPTION_LABEL = 'No owner set'

/**
 * The Owner select's options, built from the owners **actually on the board**.
 *
 * Not from the owner records: an assignment for a base that is no longer tracked would
 * be an option that filters the board down to nothing, and every option here is
 * guaranteed to keep at least one row.
 *
 * Grouped by {@link Ownable.ownerUserId}, not by the label. A base whose owner is an
 * **unlinked legacy label** — an account id of `null` — falls under
 * {@link UNASSIGNED_OWNER} along with a base that has no assignment at all, rather than
 * getting an option of its own under that label. `mayWriteBaseCounts` still draws a line
 * between `ownerNotLinked` and `unowned` for *permission*, but this board answers a
 * different question — "is this the same owner as that row" — and the account id is now
 * the one fact everywhere else in the app already treats as the answer.
 *
 * The unowned option appears only when a base on the board has no linked owner, for the
 * same reason the density control is not drawn when it offers one value: an option that
 * cannot change what is on screen is a control that answers a press by doing nothing.
 */
export function standingOwnerOptions<T extends Ownable>(rows: readonly T[]): OwnerFilterOption[] {
  const named = new Map<number, string>()
  let anyUnowned = false
  for (const row of rows) {
    if (row.ownerUserId === null) anyUnowned = true
    else if (!named.has(row.ownerUserId)) named.set(row.ownerUserId, row.owner ?? String(row.ownerUserId))
  }

  const options: OwnerFilterOption[] = [{ value: ALL_OWNERS, label: 'Everyone' }]
  if (anyUnowned) options.push({ value: UNASSIGNED_OWNER, label: UNOWNED_OPTION_LABEL })
  const owners = [...named].sort(([, a], [, b]) => a.localeCompare(b))
  for (const [ownerUserId, label] of owners) {
    options.push({ value: String(ownerUserId), label })
  }
  return options
}

/**
 * The board narrowed to one owner.
 *
 * **It takes ranked rows and only ever removes them.** `baseStandings` has already
 * numbered the whole board, so a filtered row keeps the rank it holds among *every*
 * tracked base — an owner's four bases read 3, 7, 12 and 19, not 1 to 4. Re-ranking
 * the survivors would turn the one column on the board that means something into a row
 * counter, which is the same failure paging would cause if it renumbered.
 *
 * Never call it before {@link baseStandings}. The order is total and the ranks share
 * and skip, so ranking a subset is not a cheaper way to get the same answer; it is a
 * different, wrong one.
 *
 * That rank-ordering rule is specific to `BaseStanding` — a row with no rank at all,
 * like `ProgressGridRow`, has nothing for filtering to disturb, and this function only
 * removes rows either way.
 *
 * `owner` is a select value, so a chosen account arrives as `ownerUserId` stringified —
 * see {@link Ownable} for why the id, not the label, is what is compared. A value that
 * is not one of {@link ALL_OWNERS}, {@link UNASSIGNED_OWNER} or a real id parses to
 * `NaN`, which matches no row's `ownerUserId` and so narrows to nothing rather than
 * falling back to "everyone" — the same "unrecognized means empty, not unfiltered" rule
 * this already held for a stale label.
 */
export function filterStandingsByOwner<T extends Ownable>(
  rows: readonly T[],
  owner: string,
): T[] {
  if (owner === ALL_OWNERS) return [...rows]
  if (owner === UNASSIGNED_OWNER) return rows.filter((row) => row.ownerUserId === null)
  const ownerUserId = Number(owner)
  return rows.filter((row) => row.ownerUserId === ownerUserId)
}

/**
 * The filter actually in force, given what the select can currently offer.
 *
 * The board is re-read in the background every thirty seconds, so the owner somebody
 * picked can stop being on it — a base reassigned, or its last base untracked. Falling
 * back to "everyone" rather than holding the stale value keeps the select showing a
 * value it has an option for, and keeps the board from going empty under a filter
 * nobody can now see the meaning of. Same shape, and the same reasoning, as
 * `activeTag()` for the base picker.
 */
export function activeOwnerFilter(options: readonly OwnerFilterOption[], chosen: string): string {
  return options.some((option) => option.value === chosen) ? chosen : ALL_OWNERS
}

/**
 * What a base with no stamp prints in the Last updated column.
 *
 * Not exported: `never` on the cell is what a caller branches on, and a second export
 * saying the same thing in a string would be a way to draw the state without noticing
 * the flag.
 */
const NEVER_UPDATED = 'Never'

/** The Last updated column for one row. */
export interface LastUpdatedCell {
  /** Nobody has ever saved this base. The cell says so in words. */
  never: boolean
  /** What the cell prints: `Never`, or a relative age like `5 days ago`. */
  text: string
  /** The full timestamp, for the `title`, or `null` when there is nothing to expand. */
  exact: string | null
}

/**
 * How stale one base is, in the words the column prints.
 *
 * **"Never" is a state, not a formatting fallback.** A base nobody has ever entered
 * counts for has no stamp at all — and migration v5's backfill says so explicitly for
 * a base emptied before it, whose history is gone rather than recoverable. That is the
 * single most useful value in this column, since "which of my bases has nobody
 * touched" is the question the column exists to answer, so it is decided here, from
 * the absence, and never left to a formatter to render as `Invalid Date` or a blank.
 *
 * **Relative first, exact on the `title`**, which is what `buildLine` does with the
 * build stamp and what the attribution line above the grid shows for the selected
 * base: "5 days ago" is what a scan down a column needs, and the exact moment is one
 * hover away rather than gone. Both formatters are passed in for the reason
 * `buildLine` takes them — `formatRelative` reads the clock, and a pure module that
 * read it too could only be tested against itself.
 *
 * A stamp that is not a date at all keeps its raw text, exactly as the attribution
 * line does with the same value: the base *was* saved, so calling it "Never" would be
 * a worse lie than printing something odd.
 */
export function lastUpdatedCell(
  updatedAt: string | null,
  relative: (date: Date) => string,
  exact: (date: Date) => string,
): LastUpdatedCell {
  if (updatedAt === null) return { never: true, text: NEVER_UPDATED, exact: null }

  const when = parseStamp(updatedAt)
  if (when === null) return { never: false, text: updatedAt, exact: null }

  return { never: false, text: relative(when), exact: exact(when) }
}

/* ---------- what the whole group holds, card by card ---------- */

export interface CardTotal {
  card: GeneratedCard
  /** Copies across every base handed in. */
  total: number
  /**
   * Nobody in the group holds one. The fact worth spotting: a card no base has a
   * copy of cannot be got by trading, however the counts move around.
   */
  absent: boolean
}

/**
 * The sixty cards in the order the grid draws them.
 *
 * Deliberately the *same two calls* the grid makes — `cardCategoriesInOrder()`
 * then `cardsInCategory()` — rather than a second ordering that agrees with it
 * today. The totals list is only worth having because it lines up card-for-card
 * with the tiles above it, and a parallel order is exactly the kind of thing that
 * drifts silently when the manifest is regenerated.
 */
export function cardsInGridOrder(): readonly GeneratedCard[] {
  return cardCategoriesInOrder().flatMap((category) => cardsInCategory(category))
}

/**
 * Every card, in `cards` order, with the copies the group holds between them.
 *
 * **Nothing is sorted here, in any mode.** The output is one entry per input card,
 * in the input's order, which is the property the tests pin down — the counts
 * decide what each row *says* and never where it sits.
 *
 * `inventory` should be every tracked base, including the ones whose owner is
 * still only a text label: they are bases somebody is collecting on, their cards
 * are as tradeable as anyone's, and leaving them out would undercount the group
 * rather than describe a smaller one.
 */
export function cardTotals(
  inventory: readonly BaseInventory[],
  cards: readonly GeneratedCard[] = cardsInGridOrder(),
): CardTotal[] {
  const totals = new Map<number, number>()
  for (const base of inventory) {
    for (const [cardId, count] of countMap(base)) {
      totals.set(cardId, (totals.get(cardId) ?? 0) + count)
    }
  }

  return cards.map((card) => {
    const total = totals.get(card.id) ?? 0
    return { card, total, absent: total === 0 }
  })
}
