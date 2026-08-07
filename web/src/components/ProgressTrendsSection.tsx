import { useMemo, useState } from 'react'
import type { SessionUser } from '@coc/shared'
import { useBaseLabels } from '../base-labels.ts'
import { useBaseOrder } from '../base-order.ts'
import { tagsInScope } from '../base-scope.ts'
import { seriesStyle } from '../chart-colors.ts'
import {
  activeOwnerFilter,
  ALL_OWNERS,
  filterStandingsByOwner,
  standingOwnerOptions,
  type Ownable,
} from '../card-standings.ts'
import { useOwners, useOwnersState } from '../owners.ts'
import { useMultiProgressHistory, useProgressLatest, useProgressReference } from '../progress.ts'
import {
  alignBaseStatSeries,
  buildBaseStatSeries,
  selectTrendBases,
  TREND_STAT_OPTIONS,
  trendStatLabel,
  type BaseStatKey,
} from '../progress-trends.ts'
import { LineChart, type ChartSeries } from './charts.tsx'
import { ErrorPanel, Loading } from './primitives.tsx'

/**
 * The progress grid's base-to-base comparison section — sits below
 * `ProgressGridView`'s existing table, its own component so that table's own
 * code path is untouched. Pick a stat, see every in-scope base's line for it
 * over time: not unit-to-unit like `PlayerProgressPanel`'s new charts, but
 * base-to-base, the comparison the flat grid can't show (a column sorted by
 * today's value says nothing about who is *catching up*).
 *
 * **No new batch route.** `GET /api/progress/:tag` already answers one
 * base's full history, and firing one fetch per base in the filtered set
 * (`useMultiProgressHistory`) is exactly what this needs — see that hook's
 * doc comment for why server-side batching would be infrastructure ahead of
 * a real need here.
 *
 * **The base filter exists to keep the plotted line count sane.** Reuses the
 * grid's own owner-filter pattern (`activeOwnerFilter` /
 * `filterStandingsByOwner` from `card-standings.ts`) rather than a second
 * filtering mechanism, and additionally caps the plotted set at
 * {@link MAX_TREND_BASES} — a clan-wide "Everyone" selection with no owner
 * narrowing could otherwise fire dozens of parallel requests and plot a
 * chart nobody could read anyway.
 *
 * **Which bases survive that cap, and the order they're plotted in, follows
 * this account's own saved base order** (`#/base-order`,
 * `useBaseOrder`/`applyBaseOrder` in `base-order.ts`) — the same read-only
 * use `ProgressGridView`'s own "just me" Owner filter and `CardsView`'s Mine
 * picker already make of it, via `selectTrendBases` (`progress-trends.ts`).
 * The order is applied to the owner-filtered set *before* the cap, not after,
 * so a member tracking more bases than {@link MAX_TREND_BASES} sees their own
 * bases — in their own preferred order — ahead of anyone else's, rather than
 * an arbitrary cutoff of whatever order the filter happened to hand back.
 * `order` only ever names tags this account owns, so bases outside it (other
 * members') simply keep their existing relative order, appended after.
 */

/**
 * More than this many simultaneously-plotted lines stops being a chart
 * anybody can read (and starts being a lot of parallel `/api/progress/:tag`
 * requests) — past it, the section plots the first `MAX_TREND_BASES` bases in
 * the filtered set and says so, rather than silently dropping the rest or
 * firing an unbounded number of fetches. Narrowing the Owner filter is the
 * way under it, the same as it already is on the grid above.
 */
export const MAX_TREND_BASES = 12

/** Per-account, like the grid's own `ownerFilterKey` — a different signed-in
    account must never inherit this section's filter either. */
function trendOwnerFilterKey(userId: number): string {
  return `coc:progressTrends:owner:${userId}`
}

function percentStat(stat: BaseStatKey): boolean {
  return stat === 'wallsPercent' || stat.endsWith('Percent')
}

export function ProgressTrendsSection({ user }: { user: SessionUser }) {
  const ownersState = useOwnersState()
  const owners = useOwners()
  const progress = useProgressLatest()
  const reference = useProgressReference()

  const progressTags = useMemo(() => progress.map((snapshot) => snapshot.playerTag), [progress])
  const { tags, labelOf } = useBaseLabels(owners, [], progressTags)

  const ownerOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.owner]))
    return (tag: string) => byTag.get(tag) ?? null
  }, [owners])
  const ownerUserIdOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.ownerUserId ?? null]))
    return (tag: string) => byTag.get(tag) ?? null
  }, [owners])

  const rows = useMemo(
    () =>
      tags.map((tag): Ownable & { tag: string; label: string } => ({
        tag,
        label: labelOf(tag),
        owner: ownerOf(tag),
        ownerUserId: ownerUserIdOf(tag),
      })),
    [tags, labelOf, ownerOf, ownerUserIdOf],
  )

  const [owner, setOwner] = useState(() => localStorage.getItem(trendOwnerFilterKey(user.id)) ?? ALL_OWNERS)
  const ownerOptions = useMemo(() => standingOwnerOptions(rows), [rows])
  const chosenOwner = activeOwnerFilter(ownerOptions, owner)
  const filtered = useMemo(() => filterStandingsByOwner(rows, chosenOwner), [rows, chosenOwner])

  function chooseOwner(next: string) {
    setOwner(next)
    localStorage.setItem(trendOwnerFilterKey(user.id), next)
  }

  /*
   * This account's own tags, independent of the Owner filter above — the same
   * `tagsInScope(..., 'mine', ...)` shape `CardsView`'s Mine picker uses, not
   * `filtered` narrowed to "just me", because the saved order has to win over
   * other members' bases even while the Owner filter is on "Everyone".
   * `ownersReady` gates `useBaseOrder`'s own fetch the same way it gates
   * `CardsView`'s: an error still counts as landed, since there is nothing
   * more to wait for and reconciling against a still-empty owner list would
   * otherwise drop every tag from the saved order before it had anything to
   * compare against.
   */
  const ownersReady = ownersState.status === 'ready' || ownersState.status === 'error'
  const mineTags = useMemo(
    () => tagsInScope(rows, 'mine', user.id),
    [rows, user.id],
  )
  const baseOrder = useBaseOrder(mineTags, ownersReady)

  const { plotted, capped } = useMemo(
    () => selectTrendBases(filtered, baseOrder.tags, MAX_TREND_BASES),
    [filtered, baseOrder.tags],
  )
  const plottedTags = useMemo(() => plotted.map((row) => row.tag), [plotted])

  const [stat, setStat] = useState<BaseStatKey>('thLevel')

  const historyState = useMultiProgressHistory(plottedTags)

  const trendReference = useMemo(
    () => ({ maxLevels: reference.maxLevels, walls: reference.walls }),
    [reference.maxLevels, reference.walls],
  )

  const aligned = useMemo(() => {
    if (historyState.status !== 'ready') return null
    const perBase = historyState.data.map(({ tag, history }) => ({
      tag,
      series: buildBaseStatSeries(history, stat, trendReference),
    }))
    return alignBaseStatSeries(perBase)
  }, [historyState, stat, trendReference])

  const labelByTag = useMemo(() => new Map(rows.map((row) => [row.tag, row.label])), [rows])

  const chartSeries: ChartSeries[] = useMemo(() => {
    if (!aligned) return []
    return aligned.series.map((entry, index) => ({
      id: entry.tag,
      label: labelByTag.get(entry.tag) ?? entry.tag,
      points: entry.points,
      ...seriesStyle(index),
    }))
  }, [aligned, labelByTag])

  const isPercent = percentStat(stat)

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="section-title" style={{ margin: 0 }}>
          Compare bases over time
        </h2>
      </div>

      <p className="card-meta">
        One stat, every in-scope base's own captured weeks. Narrow with Owner below to keep the
        chart readable — comparing units between bases belongs on each base's own page instead.
      </p>

      <div className="roster-filters">
        <label htmlFor="progress-trends-stat">
          Stat
          <select
            id="progress-trends-stat"
            value={stat}
            onChange={(event) => setStat(event.target.value as BaseStatKey)}
          >
            {TREND_STAT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {ownerOptions.length > 2 ? (
          <label htmlFor="progress-trends-owner">
            Owner
            <select
              id="progress-trends-owner"
              value={chosenOwner}
              onChange={(event) => chooseOwner(event.target.value)}
            >
              {ownerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {capped ? (
        <p className="empty-hint">
          Showing the first {MAX_TREND_BASES} of {filtered.length} bases in scope. Narrow the Owner
          filter above to see a specific base's line.
        </p>
      ) : null}

      {plottedTags.length === 0 ? (
        <p className="empty-hint">No bases in scope to compare.</p>
      ) : historyState.status === 'loading' || historyState.status === 'idle' ? (
        <Loading what="the comparison" />
      ) : historyState.status === 'error' ? (
        <ErrorPanel error={historyState.error} />
      ) : (
        <LineChart
          weeks={aligned?.weeks ?? []}
          series={chartSeries}
          ariaLabel={`${trendStatLabel(stat)}, by base and captured week`}
          yBounds={isPercent ? [0, 100] : undefined}
          yUnit={isPercent ? '%' : ''}
          formatValue={isPercent ? (value) => String(Math.round(value)) : undefined}
          emptyMessage="Nothing captured yet for this stat, in this scope."
        />
      )}
    </section>
  )
}
