import { useMemo } from 'react'
import { type BaseInventory } from '@coc/shared'
import {
  basesNeeding,
  cardDemand,
  cardHolders,
  type CardDemand,
  type CardHolder,
  type CardNeeder,
} from '../card-holders.ts'
import { type CardTotal } from '../card-standings.ts'
import { hrefFor } from '../hooks.ts'
import { GameIcon } from './primitives.tsx'

/** How a clan total reads in words. The one place that sentence is written.
 *  Shared with `CardTotalsGrid.tsx`'s `CardTotalPick`, which reads the same
 *  sentence for the badge's own tooltip. */
export function heldAcrossTheClan(total: number): string {
  return total > 0 ? `${total} held across the clan` : 'none held across the clan'
}

/**
 * The line under the picked card's name. The one place that sentence is written.
 *
 * It counts the spares as well as the rows because that is the actionable half and the
 * Spare column below only yields it to a scan: four bases each sitting on their only
 * copy is four bases you cannot ask, which is worth knowing before reading the table.
 *
 * The third clause is the one the table cannot be scanned for *at all*, because the
 * bases it counts are precisely the ones with no row in it: how many of the bases that
 * have reported still want this card. It is the "who am I competing with" half of the
 * same question the other two answer, and `cardDemand` has the rules — in particular
 * that a base nobody has ever entered is in neither the numerator nor the denominator,
 * since it has not told us it lacks the card.
 *
 * `of ${reporting}` rather than a bare count: three needing it out of four bases and
 * three out of thirty are different situations. That is also why the zero stays
 * numeric here where the spares clause turns into words — `0 of 2 reporting bases need
 * it` keeps the denominator, and the denominator is most of what the clause is for.
 */
function holdersLine(holders: readonly CardHolder[], demand: CardDemand): string {
  const bases = holders.length === 1 ? '1 base holds it' : `${holders.length} bases hold it`
  const sparing = holders.filter((holder) => holder.canSpare).length
  const spares = sparing === 0 ? 'none with a spare to trade' : `${sparing} with a spare to trade`
  /* "1 of 3 reporting bases needs it" — the subject is the one base, not the three, so
     the verb agrees with the numerator and the noun with the denominator. */
  const { needing, reporting } = demand
  const plural = reporting === 1 ? '' : 's'
  const verb = needing === 1 ? 'needs' : 'need'
  const wanting = `${needing} of ${reporting} reporting base${plural} ${verb} it`

  return `${bases} · ${spares} · ${wanting}`
}

/**
 * The lead sentence over the "still need it" list — `holdersLine`'s third clause,
 * named rather than just counted.
 *
 * Its own sentence rather than a rewrite of `holdersLine`'s: that line's `N of M
 * reporting bases need it` keeps its count-with-denominator framing exactly as
 * documented above regardless of whether this list is showing, and this is purely
 * additive underneath it — new information (*which* bases), not a second phrasing of
 * a number already on the page. No denominator here for the same reason `cardHolders`'
 * own summary needs none: the list beneath the sentence is the whole answer, so a
 * reader is never left wanting the total it came out of.
 */
function needingLine(needing: readonly CardNeeder[]): string {
  return needing.length === 1 ? '1 base still needs it' : `${needing.length} bases still need it`
}

/**
 * The id of the holders block below the grid, so the pressed tile can point at the
 * thing it opened. Only the pressed one carries `aria-controls`: on the other
 * fifty-nine there is nothing with this id to point at, and an `aria-controls`
 * naming an element that does not exist is worse than none.
 *
 * Exported for `CardTotalsGrid.tsx`'s `CardTotalPick`, the tile that opens this
 * panel and carries the matching `aria-controls`.
 */
export const HOLDERS_ID = 'card-holders'

/**
 * Who holds the card whose tile was just pressed — the other half of the badge's
 * sentence. `×4` says a trade is arithmetically possible and nothing whatever about
 * whom to message, which is the only reason to be reading this panel.
 *
 * Everything it needs was already on the page: `/api/cards/inventory` returns every
 * tracked base with its per-card counts, so this is a projection of the same `bases`
 * array the grid above and the leaderboard are drawn from, and no request is made.
 * Which bases and in what order is `cardHolders`', tested there; this is the drawing.
 *
 * **It names the card, with its art.** Sixty tiles is a lot of grid, and on a phone
 * the tile that was pressed is usually scrolled off the top by the time the table is
 * on screen — a table headed only "Member / Copies" would be a table about nothing.
 * It is also the sighted reader's carrier for *which* tile is selected, so the ring
 * on the tile is not doing that job alone.
 *
 * **A card nobody holds gets a sentence, not an empty table.** Header rows over no
 * rows is a table that looks broken; the fact is that no amount of trading can
 * produce a copy, which is worth stating in the words the panel's intro uses.
 *
 * **No pager, unlike the two tables above.** It is bounded by the tracked bases and
 * is one card's whole answer — truncating "who holds this" to the first five would
 * hide the base somebody opened it to find. The row limit those tables carry exists
 * because their length is unbounded in the count of *pairs* and *bases*; this one is
 * at most one row per base and in practice a handful.
 *
 * **The "still need it" list comes first, above "who holds it", and is its own
 * block, not nested inside it.** `cardDemand`'s `needing` count has always been on
 * this page, in `holdersLine`'s third clause — this is the names behind it, from
 * `basesNeeding()`, sibling to `cardHolders()` in the same module and answering the
 * same question this panel exists for: not "how many" but "whom to ask", except this
 * time it is "whom to tell". It leads because pressing a tile is usually about
 * finding somebody to trade *toward* — who still needs this — before it's about
 * finding somebody to trade *from*; reported directly after shipping it below the
 * holders table, where it read as missing rather than merely second. It is
 * deliberately independent of whether anyone holds the card at all: a card 38 of 60
 * are in — nobody holds it — is exactly the case where "which bases still need one"
 * is every reporting base, and the most useful reading on the panel, not a state
 * that suppresses the list. Rows carry only `tag` and `label`: a base holding zero
 * copies has no `count` and no `canSpare` to print, so the table this list renders
 * as has one column, not three with two always blank.
 */
export function CardHolders({
  entry,
  bases,
  labelOf,
}: {
  entry: CardTotal
  /**
   * Every base that has reported, as `state.entries` — group-wide, like the grid above
   * it. Not every base *tracked*: the owner assignments carry bases nobody has entered
   * yet, and those are not in here. Both numbers on the line below depend on that.
   */
  bases: readonly BaseInventory[]
  labelOf: (tag: string) => string
}) {
  const { card } = entry
  const holders = useMemo(() => cardHolders(bases, card.id, labelOf), [bases, card.id, labelOf])
  const demand = useMemo(() => cardDemand(bases, card.id), [bases, card.id])
  const needing = useMemo(
    () => basesNeeding(bases, card.id, labelOf),
    [bases, card.id, labelOf],
  )

  return (
    <div className="card-holders" id={HOLDERS_ID}>
      {/* `h3` under the panel's `h2`, so the table is an outline entry somebody can
          jump to rather than a slab of markup after sixty tiles. */}
      <h3 className="card-holders__title">
        <span className="trade-card">
          <GameIcon src={card.image} className="trade-card__img" />
          {card.name}
        </span>
        <span className="card-meta">
          {card.category} · {heldAcrossTheClan(entry.total)}
        </span>
      </h3>

      {/*
       * Guarded on `bases.length`, not on `holders.length` or `needing.length`: with no
       * reporting bases at all there is nothing to claim either way, and rendering
       * "every reporting base already holds it" over zero reporting bases would invent
       * an answer from an absence of data — the same trap `cardDemand`'s own `reporting`
       * rule exists to avoid.
       */}
      {bases.length > 0 && (
        <div className="card-holders__needing">
          {needing.length === 0 ? (
            <p className="empty-hint" style={{ margin: 0 }}>
              <strong>Every reporting base already holds it.</strong>
            </p>
          ) : (
            <>
              <p className="card-holders__note">
                <strong>{needingLine(needing)}:</strong>
              </p>
              <div className="table-wrap">
                {/* Same one-column table shape as the roster elsewhere on this page:
                    `roster--stack` for the phone layout, `stack-title` and `card-meta`
                    for the name-then-tag cell — the identical treatment `CardHolders`'
                    own Member column uses below, just without the two columns a base
                    with zero copies has nothing to fill. */}
                <table
                  className="roster roster--stack"
                  role="table"
                  aria-label={`Bases that still need ${card.name}`}
                >
                  <thead role="rowgroup">
                    <tr role="row">
                      <th role="columnheader">Member</th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup">
                    {needing.map((needer) => (
                      <tr key={needer.tag} role="row">
                        <td className="stack-title" role="cell">
                          <a href={hrefFor({ view: 'player', tag: needer.tag })}>
                            {needer.label}
                          </a>
                          {needer.label === needer.tag ? null : (
                            <>
                              <br />
                              <span className="card-meta">{needer.tag}</span>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {holders.length === 0 ? (
        <p className="empty-hint" style={{ margin: 0 }}>
          <strong>Nobody in the clan holds it.</strong> Trading cannot produce a copy of a card
          nobody has — this one has to come from the game.
        </p>
      ) : (
        <>
          <p className="card-holders__note">{holdersLine(holders, demand)}</p>
          <div className="table-wrap">
            {/*
             * Stacks into one labeled card per base on a phone, like every other table
             * here, with the explicit roles that keep it a table for assistive tech once
             * `display` changes. Named with `aria-label` rather than `aria-labelledby`
             * the `h3` above it — not for the uppercase reason the other two carry, but
             * because that heading holds an `<img>` and two spans, and the name has to
             * be the card in words.
             */}
            <table
              className="roster roster--stack"
              role="table"
              aria-label={`Bases holding ${card.name}`}
            >
              <thead role="rowgroup">
                <tr role="row">
                  {/* "Member", as the leaderboard and the trade table say it: the row is
                      a person to talk to, and the tag is secondary text under the name. */}
                  <th role="columnheader">Member</th>
                  <th className="num" role="columnheader">
                    Copies
                  </th>
                  <th role="columnheader">Spare</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {holders.map((holder) => (
                  <tr key={holder.tag} role="row">
                    <td className="stack-title" role="cell">
                      <a href={hrefFor({ view: 'player', tag: holder.tag })}>{holder.label}</a>
                      {holder.label === holder.tag ? null : (
                        <>
                          <br />
                          <span className="card-meta">{holder.tag}</span>
                        </>
                      )}
                    </td>
                    <td className="num" role="cell" data-label="Copies">
                      {holder.count}
                    </td>
                    <td role="cell" data-label="Spare">
                      {/*
                       * The count on its own does not say what it means. A base never
                       * gives away its last copy — `MIN_TRADEABLE_COUNT`, the same rule
                       * the trade suggestions and the server apply — so 1 is a holding
                       * you cannot ask for and 2 is an offer, and that is worth a
                       * column of words rather than leaving everybody to do the
                       * comparison per row.
                       */}
                      {holder.canSpare ? (
                        'Can spare one'
                      ) : (
                        <span className="role-pill">Its only copy</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
