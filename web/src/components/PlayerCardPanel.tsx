import { useMemo } from 'react'
import { CARD_SEASON, type SessionUser } from '@coc/shared'
import { baseOwnerOf } from '../card-entry.ts'
import { inventoryFor, useCardInventoryState } from '../card-inventory.ts'
import { summariseBase } from '../card-summary.ts'
import { cardCategoriesInOrder, cardsInCategory, categoryOfCard } from '../cards.ts'
import { ownerRecordFor, useOwners } from '../owners.ts'
import { BaseCardEditor } from './BaseCardEditor.tsx'
import { ErrorPanel } from './primitives.tsx'

/**
 * This player's event cards, collapsed to a line until asked for.
 *
 * A player page is a base, so the card grid belongs on it — but the cards are one
 * interest among many here, and sixty tiles unfurled above the stat tiles would
 * bury the page. Collapsed it answers the two questions worth answering without
 * opening: how much of each deck this base holds, and whether a swap is waiting.
 * Opened it is the card page's grid, `BaseCardEditor`, with no base selector —
 * the base is the player whose page this is.
 *
 * `<details>` rather than a button and a flag: the browser owns the state, the
 * disclosure semantics and the keyboard, and the collapsed content is a real
 * summary rather than a caption.
 */

/** How many cards each deck holds, for the `4/16` denominators. */
function deckSizes(): Map<string, number> {
  return new Map(
    cardCategoriesInOrder().map((category) => [category, cardsInCategory(category).length]),
  )
}

export function PlayerCardPanel({
  tag,
  name,
  user,
}: {
  tag: string
  name: string
  /** Only a base's owner, or an admin, may type counts into the grid below. */
  user: SessionUser
}) {
  /* Subscribed rather than read once, so an admin reassigning this base flips the
     grid between editable and read-only without a reload. */
  const owners = useOwners()

  /*
   * The whole shared inventory, not just this base: a trade is a pair, so the
   * hint cannot be computed from one base's counts. It is the same module-level
   * store the card page uses, so this is **one** request for every base — never
   * one per base and never one per card — and it is already cached if the user
   * came from the card page.
   */
  const state = useCardInventoryState()
  const categories = useMemo(() => cardCategoriesInOrder(), [])
  const sizes = useMemo(() => deckSizes(), [])

  const summary = useMemo(
    () => summariseBase(tag, state.entries, categoryOfCard, categories),
    [tag, state.entries, categories],
  )

  /* Only while there is nothing to show. A refresh after a save keeps the numbers
     on screen rather than blanking them, which is what the store's snapshot is for. */
  const loading = state.status === 'loading' && state.entries.length === 0

  return (
    <section className="card">
      <details className="group group--flush">
        <summary>
          Event cards · {CARD_SEASON}
          {loading ? (
            <span className="card-meta"> · Loading counts…</span>
          ) : !summary.recorded ? (
            /* Not sixty zeroes dressed as data — the same distinction the card
               page's attribution line draws for a base nobody has entered. */
            <span className="card-meta"> · Nothing recorded yet — open to enter counts</span>
          ) : (
            <>
              <span className="card-panel__decks">
                {summary.byCategory.map((deck) => (
                  <span
                    key={deck.category}
                    className="card-meta"
                    title={`${deck.distinct} of ${sizes.get(deck.category) ?? 0} ${deck.category} cards · ${deck.total} copies · ${deck.spares} spare`}
                  >
                    {' · '}
                    {deck.category} {deck.distinct}/{sizes.get(deck.category) ?? 0}
                  </span>
                ))}
              </span>
              {/* Words, not a dot: the trade state is the reason to open this. */}
              <span
                className={
                  summary.hasTrades
                    ? 'card-panel__trades card-panel__trades--yes'
                    : 'card-panel__trades card-meta'
                }
              >
                {' · '}
                {summary.hasTrades
                  ? `Trades available with ${summary.tradePartners.length} base${
                      summary.tradePartners.length === 1 ? '' : 's'
                    }`
                  : 'No trades available'}
              </span>
            </>
          )}
        </summary>

        <div className="group__body">
          {/* Reported here rather than page-wide: the rest of the player page is
              fine when only the card store failed. */}
          {state.status === 'error' && state.error ? <ErrorPanel error={state.error} /> : null}
          <BaseCardEditor
            tag={tag}
            label={name}
            base={inventoryFor(state.entries, tag)}
            owner={baseOwnerOf(ownerRecordFor(owners, tag))}
            user={user}
          />
        </div>
      </details>
    </section>
  )
}
