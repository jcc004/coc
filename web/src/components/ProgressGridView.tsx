import { useMemo, useState } from 'react'
import type { SessionUser } from '@coc/shared'
import { useBaseLabels } from '../base-labels.ts'
import { applyBaseOrder, useBaseOrder } from '../base-order.ts'
import {
  activeOwnerFilter,
  ALL_OWNERS,
  filterStandingsByOwner,
  standingOwnerOptions,
} from '../card-standings.ts'
import { hrefFor, navigate, useRowLimit, useStackedTables } from '../hooks.ts'
import { useOwners, useOwnersState } from '../owners.ts'
import {
  buildProgressGridRows,
  HERO_ABBREVIATIONS,
  PET_ABBREVIATIONS,
  PROGRESS_GRID_COLUMNS,
  PROGRESS_GRID_ASCENDING_BY_DEFAULT,
  PROGRESS_GRID_HEROES,
  PROGRESS_GRID_PETS,
  progressGridColumnLabel,
  sortProgressGridRows,
  type ProgressGridRow,
  type ProgressGridSortKey,
} from '../progress-grid.ts'
import { useProgressLatest, useProgressLatestState, useProgressReference } from '../progress.ts'
import { nextSortState, paginate, type RowLimit } from '../saved-table.ts'
import { artFor } from '../wiki-art.ts'
import {
  ErrorPanel,
  GameIcon,
  HelpLink,
  Loading,
  Pager,
  RowLimitSelect,
  SortControl,
  TownHallBadge,
} from './primitives.tsx'
import { ProgressTrendsSection } from './ProgressTrendsSection.tsx'

/**
 * Every clan member's weekly progress, spreadsheet-shaped: one row per base, one
 * column per individual stat, the layout the hand-kept sheet this feature
 * replaces actually had. Replaces `ProgressBoardView` (deleted alongside
 * `progress-table.ts`, whose `ProgressRow` this board no longer builds), which
 * showed the same data aggregated into a Heroes% and a Walls% — a fair overview,
 * but not what somebody scanning "who still needs Grand Warden 90" can read a
 * percent for.
 *
 * Structurally this is still `ProgressBoardView`'s shape: a sortable, paginated,
 * owner-filterable table over `useProgressLatest`, read-only (entering a week's
 * manual fields stays on `PlayerProgressPanel`), and not owner-gated — see the
 * note there, carried over verbatim below, for why every clan member the server
 * has ever captured a row for is a row here, not just claimed bases. What
 * changed is the row shape: `progress-grid.ts`'s `ProgressGridRow`, not
 * `progress-table.ts`'s `ProgressRow`.
 *
 * **Wide on purpose.** Six heroes and twelve pets as their own columns, plus TH,
 * walls, buildings left and notes, is on the far side of twenty columns —
 * `.table-wrap` (below) scrolls it horizontally rather than trying to squeeze it,
 * the same control this app already reaches for on the trade table. Below the
 * stacking breakpoint each row becomes a card instead (`roster--stack`), where a
 * hero or pet this base has not unlocked renders as a blank `<td>` that
 * `roster--stack td:empty` already collapses out of the card, so an early-TH
 * base's card is short rather than a wall of "—".
 *
 * **Defaults to showing every row.** A limit control still exists — fifty rows at
 * twenty-odd columns can get slow to render on a phone — but the point of this
 * page is to be scanned like a sheet, not paged through, so `'all'` is the
 * opening state rather than the leaderboard's `20`.
 */

const LIMIT_KEY = 'coc:progressGrid:limit'

/** Per-account, like `coc:baseScope:<id>` — a different signed-in account must
    never inherit this one's filter, and "just me" means something different
    for each of them. */
function ownerFilterKey(userId: number): string {
  return `coc:progressGrid:owner:${userId}`
}
const LIMIT_OPTIONS: RowLimit[] = [5, 10, 20, 'all']

/** Town Hall, or a plain marker that nothing has been captured for this base yet. */
function TownHallCell({ row }: { row: ProgressGridRow }) {
  if (!row.tracked) return <span className="role-pill">Not tracked</span>
  if (row.thLevel === null) return <span className="card-meta">Not yet captured</span>
  return <TownHallBadge level={row.thLevel} />
}

/** A hero or pet's level, blank rather than a dash when this base has not unlocked it. */
function LevelCell({ level }: { level: number | null }) {
  return level === null ? null : <>{level}</>
}

/**
 * Walls at the Town Hall's max level over its total, as a fraction — a raw
 * count rather than the aggregated percent `ProgressBoardView` showed, matching
 * the rest of this grid's "the actual number, not a summary of it" stance.
 * Blank when there is nothing to compare against: no wall entry this week, or no
 * reference row for this Town Hall (see `buildProgressGridRows`).
 */
function WallsCell({ row }: { row: ProgressGridRow }) {
  if (row.wallsAtMax === null || row.wallsTotal === null) return <span className="card-meta">—</span>
  return (
    <span>
      {row.wallsAtMax}/{row.wallsTotal}
    </span>
  )
}

/** Whether every wall this base has entered sits at the Town Hall's max level. */
function wallsFullyMaxed(row: ProgressGridRow): boolean {
  return row.wallsAtMax !== null && row.wallsTotal !== null && row.wallsAtMax === row.wallsTotal
}

function ProgressGridRowView({ row }: { row: ProgressGridRow }) {
  return (
    <tr
      className={row.tracked ? 'clickable' : 'clickable progress-board__row--untracked'}
      role="row"
      onClick={() => navigate({ view: 'player', tag: row.tag })}
    >
      <td className="stack-title" role="cell">
        <a href={hrefFor({ view: 'player', tag: row.tag })} onClick={(event) => event.stopPropagation()}>
          {row.label}
        </a>
      </td>
      <td role="cell" data-label={progressGridColumnLabel('thLevel')}>
        <TownHallCell row={row} />
      </td>
      {PROGRESS_GRID_HEROES.map((hero) => (
        <td
          className={row.heroesMaxed[hero] ? 'num progress-grid__cell--maxed' : 'num'}
          role="cell"
          key={hero}
          data-label={hero}
        >
          <LevelCell level={row.heroes[hero] ?? null} />
        </td>
      ))}
      <td role="cell" data-label={progressGridColumnLabel('buildingsLeft')}>
        {row.buildingsLeft ?? <span className="card-meta">—</span>}
      </td>
      <td
        className={wallsFullyMaxed(row) ? 'num progress-grid__cell--maxed' : 'num'}
        role="cell"
        data-label="Walls"
      >
        <WallsCell row={row} />
      </td>
      {PROGRESS_GRID_PETS.map((pet) => (
        <td
          className={row.petsMaxed[pet] ? 'num progress-grid__cell--maxed' : 'num'}
          role="cell"
          key={pet}
          data-label={pet}
        >
          <LevelCell level={row.pets[pet] ?? null} />
        </td>
      ))}
      <td role="cell" data-label="Notes">
        {row.notes ? row.notes : <span className="card-meta">—</span>}
      </td>
    </tr>
  )
}

/** The art, if any, for a hero or pet column — `undefined` renders no icon. */
function columnArt(key: ProgressGridSortKey): string | undefined {
  if (key.startsWith('hero:')) return artFor('hero', key.slice('hero:'.length))
  if (key.startsWith('pet:')) return artFor('troop', key.slice('pet:'.length))
  return undefined
}

/**
 * What every column header's shorthand actually means — heroes and pets both
 * get abbreviated in the table itself (see `progress-grid.ts`'s
 * `HERO_ABBREVIATIONS`/`PET_ABBREVIATIONS`), which is compact but only legible
 * to someone who already knows a base's roster by its letters. Built once at
 * module load: every input is a static constant, nothing here depends on props.
 */
const LEGEND_ENTRIES = [
  ...PROGRESS_GRID_HEROES.map((name) => ({
    abbreviation: HERO_ABBREVIATIONS[name] ?? name,
    name,
    art: artFor('hero', name),
  })),
  ...PROGRESS_GRID_PETS.map((name) => ({
    abbreviation: PET_ABBREVIATIONS[name] ?? name,
    name,
    art: artFor('troop', name),
  })),
]

/** Short form, icon, full name — the reverse lookup for every abbreviated column. */
function ProgressGridLegend() {
  return (
    <ul className="progress-grid__legend">
      {LEGEND_ENTRIES.map((entry) => (
        <li key={entry.name}>
          <span className="progress-grid__legend-abbr">{entry.abbreviation}</span>
          {entry.art ? <GameIcon src={entry.art} className="art-icon" /> : null}
          <span>{entry.name}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Takes a user now, unlike `HelpView` and `WhatsNewView` — but only to answer
 * one question, "is the Owner filter narrowed to this account's own bases",
 * for the custom-order sort below. Every read here is still open to every
 * member (see `progress/routes.ts`), and the one write this feature has —
 * entering a week's manual fields — still lives entirely on
 * `PlayerProgressPanel`; nothing here gates on ownership.
 */
export function ProgressGridView({ user }: { user: SessionUser }) {
  const ownersState = useOwnersState()
  const owners = useOwners()
  const progressState = useProgressLatestState()
  const progress = useProgressLatest()
  const reference = useProgressReference()

  // The tracked bases are the owner assignments, unioned with every tag that has
  // actually come back in a progress snapshot — see the note on `useBaseLabels`'s
  // `extraTags` param, added for exactly this board.
  const progressTags = useMemo(() => progress.map((snapshot) => snapshot.playerTag), [progress])
  const { tags, labelOf } = useBaseLabels(owners, [], progressTags)

  const ownerOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.owner]))
    return (tag: string) => byTag.get(tag)
  }, [owners])

  const ownerUserIdOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.ownerUserId ?? null]))
    return (tag: string) => byTag.get(tag) ?? null
  }, [owners])

  const rows = useMemo(
    () =>
      buildProgressGridRows(
        tags,
        labelOf,
        ownerOf,
        ownerUserIdOf,
        progress,
        reference.walls,
        reference.maxLevels,
      ),
    [tags, labelOf, ownerOf, ownerUserIdOf, progress, reference.walls, reference.maxLevels],
  )

  const stacked = useStackedTables()
  const [sortKey, setSortKey] = useState<ProgressGridSortKey>('label')
  const [ascending, setAscending] = useState(true)
  const [limit, setLimit] = useRowLimit(LIMIT_KEY, 'all')
  const [page, setPage] = useState(1)

  /*
   * Persisted, unlike the card leaderboard's Owner filter (deliberately
   * transient there — see `CardsView.tsx`'s note on it). This board is the one
   * "just me" is meant to be revisited on, over and over, week to week — a
   * filter that reset on every reload would mean re-picking your own name
   * every single time you opened the page.
   */
  const [owner, setOwner] = useState(() => localStorage.getItem(ownerFilterKey(user.id)) ?? ALL_OWNERS)
  const ownerOptions = useMemo(() => standingOwnerOptions(rows), [rows])
  const chosenOwner = activeOwnerFilter(ownerOptions, owner)
  const filtered = useMemo(() => filterStandingsByOwner(rows, chosenOwner), [rows, chosenOwner])

  function chooseOwner(next: string) {
    setOwner(next)
    localStorage.setItem(ownerFilterKey(user.id), next)
  }

  /*
   * "Narrowed to exactly my own bases" is `chosenOwner` matching this
   * account's id, stringified the same way `standingOwnerOptions` builds that
   * option's value — see `card-standings.ts`. Everyone, a single other owner,
   * and "No owner set" all leave `isMineView` false and this page's sort
   * behaves exactly as it did before this feature existed.
   */
  const isMineView = chosenOwner === String(user.id)
  const mineTags = useMemo(() => (isMineView ? filtered.map((row) => row.tag) : []), [isMineView, filtered])
  const baseOrder = useBaseOrder(mineTags, isMineView)

  /*
   * An explicit column click always wins over the custom order until the
   * owner filter is touched again — see the note on `toggleSort` below for
   * why a fresh filter pick is what resets it, not a timer or a second
   * control.
   */
  const [sortOverridden, setSortOverridden] = useState(false)
  const usingCustomOrder = isMineView && !sortOverridden && baseOrder.status === 'ready'

  const ordered = useMemo(() => {
    if (usingCustomOrder) return applyBaseOrder(filtered, baseOrder.tags)
    return sortProgressGridRows(filtered, sortKey, ascending)
  }, [usingCustomOrder, filtered, baseOrder.tags, sortKey, ascending])
  const view = paginate(ordered, limit, page)

  /*
   * Clicking a column header is a request to see the board sorted that way
   * *right now*, so it always overrides the custom order while looking at
   * "just me" — a click that silently did nothing would be the confusing
   * result, not this one. The override does not persist past the next owner
   * change: picking a filter is a fresh look at the board, and for "just me"
   * that fresh look is the saved order by default, the same as arriving at
   * the page. Least surprising in both directions — a column click always
   * takes effect, and returning to "just me" always shows the personal order
   * again rather than remembering yesterday's column pick.
   */
  function toggleSort(key: ProgressGridSortKey) {
    const next = nextSortState({ key: sortKey, ascending }, key, PROGRESS_GRID_ASCENDING_BY_DEFAULT)
    setSortKey(next.key)
    setAscending(next.ascending)
    setPage(1)
    setSortOverridden(true)
  }

  const trackedCount = rows.filter((row) => row.tracked).length

  return (
    <>
      <section className="card">
        <div className="card-header">
          <h2 className="section-title" style={{ margin: 0 }}>
            Progress board{rows.length > 0 ? ` · ${trackedCount}/${rows.length} tracked` : ''}{' '}
            <HelpLink section="progress" topic="what's captured automatically, and what you type in" />
          </h2>
        </div>

        {ownersState.status === 'error' && ownersState.error ? <ErrorPanel error={ownersState.error} /> : null}
        {progressState.status === 'error' && progressState.error ? (
          <ErrorPanel error={progressState.error} />
        ) : null}

        {rows.length === 0 && (ownersState.status === 'loading' || progressState.status === 'loading') ? (
          <Loading what="the progress board" />
        ) : rows.length === 0 && ownersState.status === 'idle' ? null : rows.length === 0 ? (
          <p className="empty-hint">No bases tracked yet. Assign an owner to a base to have it show up here.</p>
        ) : (
          <>
            {stacked ? (
              <SortControl
                id="progress-grid-sort"
                columns={PROGRESS_GRID_COLUMNS}
                sortKey={sortKey}
                ascending={ascending}
                onSort={toggleSort}
              />
            ) : null}

            {ownerOptions.length > 2 ? (
              <div className="roster-filters">
                <label htmlFor="progress-grid-owner">
                  Owner
                  <select
                    id="progress-grid-owner"
                    value={chosenOwner}
                    onChange={(event) => {
                      chooseOwner(event.target.value)
                      setPage(1)
                      setSortOverridden(false)
                    }}
                  >
                    {ownerOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            {usingCustomOrder ? (
              <p className="empty-hint">
                Sorted by your saved base order. Pick a column to sort differently — see{' '}
                <a href={hrefFor({ view: 'base-order' })}>Base order</a> to change it.
              </p>
            ) : null}

            <div className="table-wrap">
              <table className="roster roster--stack progress-grid" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    {PROGRESS_GRID_COLUMNS.map((column) => {
                      const art = columnArt(column.key)
                      return (
                        <th
                          key={column.key}
                          className={column.numeric ? 'num' : undefined}
                          role="columnheader"
                          title={column.long ?? column.label}
                          aria-sort={
                            !usingCustomOrder && sortKey === column.key
                              ? ascending
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          {stacked ? (
                            column.label
                          ) : (
                            <button
                              type="button"
                              className="progress-grid__head"
                              onClick={() => toggleSort(column.key)}
                              aria-label={`Sort by ${column.long ?? column.label}`}
                            >
                              {/* A hero or pet column's icon already names it — the BK/AQ/L/O
                                  shorthand next to it was redundant with the icon and the
                                  `title` tooltip both, and cluttered a header row that already
                                  has twenty-odd columns in it. A column with no vendored art
                                  (Base, TH, Buildings, Walls) still needs its text label, since
                                  there is nothing else standing in for it. */}
                              {art ? <GameIcon src={art} className="art-icon" /> : column.label}
                              {!usingCustomOrder && sortKey === column.key ? (
                                <span className="sort-caret"> {ascending ? '↑' : '↓'}</span>
                              ) : null}
                            </button>
                          )}
                        </th>
                      )
                    })}
                    <th role="columnheader">Notes</th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {view.rows.map((row) => (
                    <ProgressGridRowView key={row.tag} row={row} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* At the bottom, beside the pager, exactly as the clan roster's and the card
                leaderboard's are — see CLAUDE.md's "row limit and pager sit together"
                local rule. */}
            <div className="roster-footer">
              <RowLimitSelect
                id="progress-grid-limit"
                options={LIMIT_OPTIONS}
                value={limit}
                onChange={(next) => {
                  setLimit(next)
                  setPage(1)
                }}
              />
              <Pager view={view} noun="bases" onPage={setPage} />
            </div>

            <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
              Click a row to open that base's own page, where its weekly progress is entered.
            </p>

            <ProgressGridLegend />
          </>
        )}
      </section>

      <ProgressTrendsSection user={user} />
    </>
  )
}
