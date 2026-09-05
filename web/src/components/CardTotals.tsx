import { useCallback, useMemo, useState } from 'react'
import { type BaseInventory } from '@coc/shared'
import { type CardTotal } from '../card-standings.ts'
import { parseCardTotalSort, type CardTotalSort } from '../card-total-sort.ts'
import { type TradeFodderEntry } from '../trade-fodder.ts'
import { CardHolders } from './CardHolders.tsx'
import { CardTotalsGrid } from './CardTotalsGrid.tsx'

/**
 * The chosen display order for "Cards across the clan", remembered per browser —
 * the same mechanism `useRowLimit`/`useCardColumns` use in `hooks.ts` (a reading
 * preference about one panel, so `localStorage` rather than the server: nobody
 * else's view of the shared data should change because you wanted the grid
 * ranked). Kept local to this file rather than added to `hooks.ts`, since nothing
 * else on the page reads it.
 */
export function useCardTotalSort(key: string): [CardTotalSort, (next: CardTotalSort) => void] {
  const [sort, setSort] = useState<CardTotalSort>(() =>
    parseCardTotalSort(localStorage.getItem(key)),
  )

  const choose = useCallback(
    (next: CardTotalSort) => {
      setSort(next)
      localStorage.setItem(key, next)
    },
    [key],
  )

  return [sort, choose]
}

/**
 * The totals grid and, once a tile is pressed, the table of who holds that card.
 *
 * The selection lives here rather than in `CardsView` because the grid and the table
 * are one thing — the table is the grid's answer — and nothing else on the page reads
 * it. It survives the disclosure being collapsed and reopened on purpose: coming back
 * to the panel you were reading and finding your card still chosen is the behavior
 * that costs nobody anything, and clearing it would be a second way to close the
 * table that the tile's own toggle already covers.
 */
export function CardTotals({
  totals,
  columns,
  bases,
  labelOf,
  grouped,
  fodderById,
}: {
  totals: CardTotal[]
  columns: number
  bases: readonly BaseInventory[]
  labelOf: (tag: string) => string
  /** Passed straight through to `CardTotalsGrid` — see its own doc comment
   *  for why this must be `false` whenever `totals` is not in deck order. */
  grouped: boolean
  /** Passed straight through to `CardTotalsGrid` — `null` for the Totals view. */
  fodderById: ReadonlyMap<number, TradeFodderEntry> | null
}) {
  const [picked, setPicked] = useState<number | null>(null)
  const entry = useMemo(() => totals.find((row) => row.card.id === picked), [totals, picked])

  return (
    <>
      <CardTotalsGrid
        totals={totals}
        columns={columns}
        picked={picked}
        onPick={setPicked}
        grouped={grouped}
        fodderById={fodderById}
      />
      {/* Below the grid, not above it: the tiles are what the panel is, and a table
          that pushed sixty tiles down the page every time one was pressed would move
          the tile you had just pressed out from under the pointer. */}
      {entry === undefined ? null : (
        <CardHolders entry={entry} bases={bases} labelOf={labelOf} />
      )}
    </>
  )
}
