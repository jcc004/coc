import { useMemo } from 'react'
import type { SessionUser } from '@coc/shared'
import { useBaseLabels } from '../base-labels.ts'
import { baseOwnerOf } from '../card-entry.ts'
import { inventoryFor, useCardInventoryState } from '../card-inventory.ts'
import { summariseBase } from '../card-summary.ts'
import { cardCategoriesInOrder, categoryOfCard } from '../cards.ts'
import { deckProgress, deckSizes } from '../deck-progress.ts'
import { ownerRecordFor, useOwners } from '../owners.ts'
import { useCardRefresh } from '../use-card-refresh.ts'
import { BaseCardEditor } from './BaseCardEditor.tsx'
import { DeckPlaques } from './DeckPlaques.tsx'
import { ErrorPanel, HelpLink } from './primitives.tsx'
import { TradeSuggestions } from './TradeSuggestions.tsx'
import { TradeTracker } from './TradeTracker.tsx'

/**
 * This player's event cards: four progress plaques, over a grid and its trades,
 * collapsed until asked for.
 *
 * A player page is a base, so the card grid belongs on it — but the cards are one
 * interest among many here, and sixty tiles unfurled above the stat tiles would
 * bury the page. So the two questions worth answering without opening anything are
 * answered in place: how far each deck has got, and whether a swap is waiting.
 * Opened, it is the card page's grid, `BaseCardEditor`, with no base selector —
 * the base is the player whose page this is.
 *
 * **The suggestions table is inside the same `<details>`, under the grid.** The
 * summary line has always said "Trades available with N bases" and then shown
 * nothing, which is the one promise this panel was not keeping. Under the grid
 * because the grid is what the suggestions are computed from — the spares you have
 * just typed are the rows — and inside the *same* disclosure because they are one
 * subject: opening the cards opens the cards, and there is no second control to
 * find.
 *
 * **Filtered to this base.** `TradeSuggestions` is the card page's table, given a
 * `focusTag`; the whole clan's pairs under a heading counting *this* base's
 * partners would contradict its own summary line. Filtered, the pair count and the
 * heading are the same number.
 *
 * **The plaques sit outside the `<details>`, not inside its `<summary>`.** They have
 * to be readable collapsed *and* open, which a summary would also give — but a
 * summary's accessible name is its own contents, so four progressbars inside it
 * would rename the disclosure control from "Card grid" to a paragraph of numbers
 * every time it was announced, and four block plaques would have to lay out around
 * the marker glyph the summary draws. Above the disclosure they are ordinary
 * content: the panel's title names them, they are never hidden, and the summary
 * goes back to naming exactly what it opens.
 *
 * `<details>` rather than a button and a flag: the browser owns the state, the
 * disclosure semantics and the keyboard.
 */

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
  /*
   * The same background refresh the card page runs, and for the same reason: the
   * other side of a trade completes it in their own tab, and this base's plaques and
   * summary line are on screen whether the grid is open or shut. It is mounted with
   * the panel, so it stops when the player page does — see `use-card-refresh.ts`.
   */
  useCardRefresh()

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

  /*
   * Names and owners for the *other* side of each suggested swap. The same hook the
   * card page uses, so a base reads identically on both pages down to the `(#TAG)`
   * suffix a shared name gets — and so a partner is a person to message rather than
   * a tag. It costs one roster request per saved clan on this page, which is the
   * price of naming somebody who is not the player being viewed.
   */
  const { labelOf } = useBaseLabels(owners, state.entries)
  const ownerOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.owner]))
    return (partner: string) => byTag.get(partner)
  }, [owners])

  const summary = useMemo(
    () => summariseBase(tag, state.entries, categoryOfCard, categories),
    [tag, state.entries, categories],
  )

  /* The plaques' numbers. `summariseBase` has already counted; this only pairs each
     deck's `distinct` with its size and shapes the label. */
  const decks = useMemo(
    () => deckProgress(summary.byCategory, (category) => sizes.get(category)),
    [summary.byCategory, sizes],
  )

  /* Only while there is nothing to show. A refresh after a save keeps the numbers
     on screen rather than blanking them, which is what the store's snapshot is for. */
  const loading = state.status === 'loading' && state.entries.length === 0

  return (
    <section className="card">
      <h2 className="section-title">Clash of Cards</h2>

      {/*
       * Four `0/19` bars for a base nobody has entered would be a claim nobody
       * made, so a base with nothing recorded gets no plaques at all — the same
       * distinction the card page's attribution line draws, and the summary below
       * says which state this is in words.
       */}
      {!loading && summary.recorded ? <DeckPlaques decks={decks} /> : null}

      <details className="group">
        <summary>
          Card grid
          {loading ? (
            <span className="card-meta"> · Loading counts…</span>
          ) : !summary.recorded ? (
            <span className="card-meta"> · Nothing recorded yet — open to enter counts</span>
          ) : (
            /* Words, not a dot: the trade state is the other reason to open this,
               and now the only one the plaques above do not already answer. */
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

          {/*
           * Directly below the grid, still inside the disclosure. The heading is an
           * `h3` with the panel's own title treatment, so it reads as a subsection of
           * the cards rather than as another panel — and its rule is what separates
           * sixty tiles from a table. Margin inline rather than a new class: it is
           * one number, and the rest of this feature already spaces one-off blocks
           * this way.
           */}
          <h3 className="section-title" style={{ marginTop: 20 }}>
            Trade suggestions <HelpLink section="trades" topic="what makes a swap legal" />
          </h3>
          <TradeSuggestions
            bases={state.entries}
            labelOf={labelOf}
            ownerOf={ownerOf}
            user={user}
            /* This base only — the pair count then matches the summary above. */
            focusTag={tag}
          />

          {/*
           * Below the suggestions, exactly as on the card page — the same two panels
           * in the same order, so the workflow reads the same wherever you meet it.
           * Inside the same disclosure, because it is about this base's cards and
           * shares their heading treatment.
           */}
          <h3 className="section-title" style={{ marginTop: 20 }}>
            Trade tracker{' '}
            <HelpLink section="tracker" topic="who can complete a trade, and what it does" />
          </h3>
          <TradeTracker user={user} labelOf={labelOf} focusTag={tag} />
        </div>
      </details>
    </section>
  )
}
