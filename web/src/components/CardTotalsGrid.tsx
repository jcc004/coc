import { useMemo, type CSSProperties } from 'react'
import { type CardTotal } from '../card-standings.ts'
import { deckSlug, type GeneratedCard } from '../cards.ts'
import { type TradeFodderEntry } from '../trade-fodder.ts'
import { CardTile } from './CardTile.tsx'
import { heldAcrossTheClan, HOLDERS_ID } from './CardHolders.tsx'

/**
 * How a `TradeFodderEntry` reads in words — the Trade Fodder view's own version of
 * `heldAcrossTheClan` above, for the same tile in the same grid read a different
 * way. `held`/`extra` already carry the actual rule (`tradeFodder()`,
 * `trade-fodder.ts`); this only says it in a sentence, the same split every other
 * one-line sentence on this page (`holdersLine`, `needingLine`) already keeps
 * between the pure module that decides and the component file that phrases it.
 */
function tradeFodderSummary(entry: TradeFodderEntry): string {
  if (!entry.held) return 'not held by every base yet'
  return entry.extra > 0
    ? `${entry.extra} spare once everyone has one`
    : 'held by every base, no spares yet'
}

/**
 * The tile in a real `<button>`, rather than click handling inside `CardTile`.
 *
 * Two reasons. The entry grid is the other caller and must not become
 * clickable — its tiles hold two stepper buttons under the frame, so a press
 * target around the whole tile would nest a button inside a button, which is
 * invalid HTML. And a `<button>` is keyboard-operable, focusable,
 * Enter/Space-activated and focus-ringed by the stylesheet's one
 * `:focus-visible` rule without any of that being written here; a `div` with
 * `onClick` would be four attributes and a key handler pretending to be one.
 *
 * `aria-pressed`, not `aria-expanded`: there is one table below the grid and
 * the sixty tiles take turns owning it, so this is which tile is selected
 * rather than sixty independent disclosures. It also means the selected
 * state is not carried by the ring alone. The button's accessible name is
 * the tile's own `aria-label` by name-from-content, so nothing is duplicated
 * and the count — or the "none held" — is still what a screen reader reads
 * out.
 *
 * Extracted to its own function, shared by both branches of `CardTotalsGrid`
 * below (grouped by deck, and the flat sorted list) — the tile markup does
 * not change between them, only what wraps it.
 */
function CardTotalPick({
  card,
  total,
  isPicked,
  onPick,
  fodder,
}: {
  card: GeneratedCard
  total: number
  isPicked: boolean
  onPick: (cardId: number | null) => void
  /**
   * This card's Trade Fodder reading, present exactly when the panel's View
   * picker is on `'fodder'` — `undefined` for the Totals view, unchanged from
   * before this prop existed. Presence alone decides which of `held`/`badge`
   * below this tile draws; there is no separate `view` prop to keep in sync
   * with it.
   */
  fodder?: TradeFodderEntry
}) {
  const held = fodder === undefined ? total > 0 : fodder.held
  const badge =
    fodder === undefined ? (total > 0 ? `×${total}` : undefined) : held ? `×${fodder.extra}` : undefined
  const summary = fodder === undefined ? heldAcrossTheClan(total) : tradeFodderSummary(fodder)
  return (
    <button
      type="button"
      className="card-total__pick"
      aria-pressed={isPicked}
      aria-controls={isPicked ? HOLDERS_ID : undefined}
      /* Pressing the selected tile again closes the table. It is the control
         that opened it, so it is the one somebody reaches for to put it
         away, and without that the table could only ever be swapped for
         another card's. */
      onClick={() => onPick(isPicked ? null : card.id)}
    >
      <CardTile
        card={card}
        held={held}
        badge={badge}
        title={`${card.name} · ${card.category} · ${summary}`}
        /* The tile's own name, because nothing inside it is a control that
           could carry one — and because it is where the zero (or "not held by
           every base yet") is said in words. */
        label={`${card.name}, ${card.category} — ${summary}`}
      />
    </button>
  )
}

/**
 * Every card, and how many copies the whole group holds between them — as the
 * **same tile grid** the base above is entered in.
 *
 * A grid rather than the list of `.meter-row`s this was: the two are meant to be
 * read against each other, and the only way to do that reliably is for them to
 * look the same and sit in the same order, tile for tile. It is literally the same
 * `CardTile`, so the art, the crop, the deck frame and the grayscale cannot drift
 * from the grid's; what differs is the badge and where the name comes from.
 *
 * **By default, the order is the grid's, fixed, and never the counts'.** It comes
 * from `cardsInGridOrder()` — the same `cardCategoriesInOrder()` then
 * `cardsInCategory()` the tiles above are drawn from — so this can be scanned
 * card-for-card against them. Sorting it by count would make it a different grid
 * that happened to hold the same numbers, and the one thing it is for would be
 * gone — which is exactly why the sort control the panel now offers is opt-in
 * and off by default: `totals` arrives here already reordered, or not, by
 * `sortCardTotalsForDisplay()` in `../card-total-sort.ts`, called from
 * `CardsView` before this component ever sees it. This component itself stays
 * agnostic of the choice; it only ever draws `totals` in the order it is handed.
 *
 * **The badge appears on every count, including 1.** The opposite of the entry
 * grid, where `×1` on fifty tiles is noise: here the totals *are* the point, and a
 * card exactly one person in the clan holds is one of the more interesting things
 * on the page.
 *
 * **A card nobody holds is grayscale with no badge** — which is a color cue and a
 * missing cue, so it cannot be the whole story. The words are in the tile's own
 * accessible name (`Barbarian, Elixir — none held across the clan`) and in its
 * `title`, and the disclosure line above counts them. In the default sort the tile
 * stays exactly where it is; the two count-ranked modes are the deliberate,
 * named exception to that, and only apply once somebody has chosen one.
 *
 * **Every tile is a button**, and pressing one lists the bases holding that card
 * below the grid — see `CardHolders`. Including the 38 of sixty nobody holds, which
 * was the decision worth making rather than assuming. The rule this page keeps is
 * that a control is never dead and never navigates nowhere, and "nobody in the clan
 * holds it, so it cannot be traded for" is an answer — arguably the most useful one
 * on the panel, since it is the one the badge cannot show. The alternative, tiles
 * that respond only where a badge happens to be, was rejected: it makes two thirds of
 * the grid silently inert, leaves nothing to explain why a press did nothing, and
 * would have a keyboard user tabbing through a set of stops that changes with the
 * counts.
 *
 * Group-wide, like the leaderboard, and including the bases whose owner is still
 * only a text label — most of them are — because their cards are as tradeable as
 * anyone's and leaving them out would undercount the group by more than half.
 */
export function CardTotalsGrid({
  totals,
  columns,
  picked,
  onPick,
  grouped,
  fodderById,
}: {
  totals: CardTotal[]
  columns: number
  /** The card whose holders are shown below, or `null` for none. */
  picked: number | null
  onPick: (cardId: number | null) => void
  /**
   * This card's Trade Fodder reading, by id — `null` for the Totals view.
   * Looked up once per tile and handed to `CardTotalPick` as `fodder`; see that
   * prop's own doc comment for why presence alone is what switches a tile's
   * rendering, with no separate `view` prop threaded alongside it.
   */
  fodderById: ReadonlyMap<number, TradeFodderEntry> | null
  /**
   * Whether to break the grid into per-deck `role="group"` sections with a
   * hidden heading — only correct when `totals` arrives in deck-contiguous
   * order, i.e. the default "Grid order" — never for a `totals` sorted by
   * clan-wide count (`sortCardTotalsForDisplay`, `card-total-sort.ts`).
   *
   * **Why this exists, and the bug it replaces.** The grouping loop used to
   * assume its input was always deck-contiguous — it built one group per
   * *consecutive run* of the same category, keyed on that category. That
   * held for "Grid order" (decks never interleave there) but broke the
   * moment a sort reordered `totals` by count: cards from different decks
   * now interleave, so the same category can start a fresh run many times
   * over, producing several sibling `<div key={deck.category}>` elements
   * that all share one key. React does not tolerate duplicate keys among
   * siblings — reported symptom was tiles from a later sort *appending*
   * below the previous ones instead of replacing them, worse with every
   * subsequent switch, which is exactly what broken reconciliation over a
   * duplicate key looks like. The fix is not a different key (there is no
   * key that makes "four decks, sixty groups" a coherent structure) — it is
   * to stop grouping at all once deck order is no longer what `totals`
   * means. A reader who explicitly asked to see cards ordered by count
   * across every deck has already said "deck" is not the structure they
   * want; the flat list below is the honest shape of that request.
   */
  grouped: boolean
}) {
  /* Memoized on `totals` alone: `picked` changes on every tile press, and
     without this the grouping loop would re-run on every one of those for a
     grid that did not change shape. `display: contents` on `.card-deck` is
     what keeps the tiles direct children of the one grid, named by a hidden
     heading — the heading ids are its own: `BaseCardEditor` is mounted on
     this page too and carries `card-deck-*`. */
  const decks = useMemo(() => {
    if (!grouped) return null
    const result: { category: string; slug: string; entries: CardTotal[] }[] = []
    for (const entry of totals) {
      const last = result[result.length - 1]
      if (last?.category === entry.card.category) last.entries.push(entry)
      else
        result.push({
          category: entry.card.category,
          slug: deckSlug(entry.card.category),
          entries: [entry],
        })
    }
    return result
  }, [totals, grouped])

  if (!grouped || decks === null) {
    /* No deck sections, no hidden headings — every tile is a direct grid
       child keyed on the one thing guaranteed unique across all sixty
       regardless of order: the card's own id. */
    return (
      <div className="card-grid" style={{ '--card-columns': columns } as CSSProperties}>
        {totals.map(({ card, total }) => (
          <CardTotalPick
            key={card.id}
            card={card}
            total={total}
            isPicked={picked === card.id}
            onPick={onPick}
            fodder={fodderById?.get(card.id)}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="card-grid" style={{ '--card-columns': columns } as CSSProperties}>
      {decks.map((deck) => {
        const headingId = `card-total-deck-${deck.slug}`
        return (
          <div key={deck.category} className="card-deck" role="group" aria-labelledby={headingId}>
            <h4 id={headingId} className="visually-hidden">
              {deck.category}
            </h4>
            {deck.entries.map(({ card, total }) => (
              <CardTotalPick
                key={card.id}
                card={card}
                total={total}
                isPicked={picked === card.id}
                onPick={onPick}
                fodder={fodderById?.get(card.id)}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
