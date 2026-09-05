import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MAX_CARD_COUNT } from '@coc/shared'
import {
  activeOwnerFilter,
  ALL_OWNERS,
  cardPoints,
  COMPLETE_SET_BONUS,
  filterStandingsByOwner,
  lastUpdatedCell,
  standingOwnerOptions,
  type BaseStanding,
  type StandingBase,
} from '../card-standings.ts'
import { type CategoryStanding } from '../category-standings.ts'
import { ALL_CARDS, cardCategoriesInOrder, deckSlug } from '../cards.ts'
import { type DeckCompletionStanding } from '../deck-completion-standings.ts'
import { formatFull, formatRelative } from '../format.ts'
import { hrefFor, useRowLimit } from '../hooks.ts'
import { type RarityStanding } from '../rarity-standings.ts'
import { type RowLevel, type RowStanding } from '../row-standings.ts'
import { paginate, type RowLimit } from '../saved-table.ts'
import { type SpareStanding } from '../spares-standings.ts'
import { type TraderStanding } from '../trader-standings.ts'
import { Meter, Pager, RowLimitSelect } from './primitives.tsx'

/**
 * The generic ranked-table machinery shared by every board on the collection
 * leaderboard: the row/column shape, the table shell, the Owner filter, the row
 * limit and pager, and the seven boards' own column configs. `CardsView.tsx` wires
 * these into `CardsLeaderboardSection.tsx`'s seven-board picker; nothing in this
 * file knows about that wiring, only about drawing one board at a time.
 */

/**
 * Rows-per-page options for the leaderboard.
 *
 * No `All`, unlike the trade suggestions: 50 already covers every tracked base in
 * this install with room to spare, so `All` would be a second name for the option
 * next to it — and an unbounded board is the thing the limit exists to prevent.
 */
const STANDING_LIMITS: RowLimit[] = [5, 10, 20, 50]

/**
 * The staleness column's heading, written once.
 *
 * The table stacks on a phone and each cell prints its own heading from `data-label`,
 * so the words exist twice in the markup; naming them here is what stops the column
 * head and the stacked label drifting apart, exactly as `rosterColumnLabel` does for
 * the clan roster.
 */
const LAST_UPDATED_LABEL = 'Last updated'

/**
 * When this base's counts were last saved — the cell's **content**, not the whole
 * `<td>`: every ranking that carries a Last-updated column (today, only Overall)
 * renders it through {@link LeaderboardColumn.cell}, which supplies its own `<td>`,
 * so this hands back the inner markup alone.
 *
 * The words and the "Never" state are `lastUpdatedCell`'s, tested there; what is here
 * is which of the two it draws. A base nobody has ever entered gets `.role-pill`, the
 * same muted treatment the Owner column gives "no owner set" — an absence, stated,
 * rather than a dash somebody has to interpret. A base with a stamp gets the relative
 * age with the exact moment on its `title`, as the attribution line above the grid and
 * the build stamp in the footer both do.
 */
function lastUpdatedContent(updatedAt: string | null, formatExact: (date: Date) => string): ReactNode {
  const cell = lastUpdatedCell(updatedAt, formatRelative, formatExact)

  return cell.never ? (
    <span className="role-pill">{cell.text}</span>
  ) : (
    <span className="card-meta" title={cell.exact ?? undefined}>
      {cell.text}
    </span>
  )
}

/**
 * One column beyond Rank/Member/Owner, which every ranking's table shares — see
 * {@link LeaderboardTable}. `numeric` drives the same `.num` class the shared three
 * columns already use, so a numeric column from any ranking right-aligns the same way
 * Points/Cards/Copies always have.
 */
export interface LeaderboardColumn<T> {
  /** React key and `data-label` both — the column head and the stacked label share
   *  this, on the same "one spelling" reasoning `LAST_UPDATED_LABEL` already carries. */
  key: string
  label: string
  numeric?: boolean
  cell: (row: T) => ReactNode
}

/** The shape every leaderboard row carries — what {@link LeaderboardTable} needs to
 *  draw Rank, Member and Owner without knowing anything about a specific ranking. */
type LeaderboardRow = StandingBase & { rank: number }

/**
 * One board's worth of everything `CardsLeaderboardSection` renders below the
 * picker — see that component's own `leaderboardBoards` table for why this is a
 * `Record<LeaderboardView, LeaderboardViewConfig>` rather than the three separate
 * ternary chains it replaces.
 */
export interface LeaderboardViewConfig {
  /** The explanatory paragraph shown above the table for this board. */
  intro: ReactNode
  /** The wired-up `<Leaderboard rows=... columns=...>` element itself. */
  board: ReactNode
  /** The `*ScoringRules` disclosure shown under the table. */
  scoringRules: ReactNode
}

/**
 * Ten small marks — hollow where a row of the grid is empty, green where it is
 * full, blue where it is doubled (every one of the row's six cards held at
 * least twice) — beside the numeric count on the "Full rows" board. The counts
 * are still printed as numbers in their own columns; this is the one thing
 * none of the other six rankings has an equivalent of, since
 * `RowStanding.rowLevels` is the only per-row (not per-card) detail any of
 * them computed, and a caller with nothing to shade would be throwing it away.
 */
function RowMarks({ rowLevels, label }: { rowLevels: readonly RowLevel[]; label: string }) {
  return (
    <span className="row-marks" role="img" aria-label={label}>
      {rowLevels.map((level, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={
            level === 'empty'
              ? 'row-marks__mark'
              : level === 'double'
                ? 'row-marks__mark row-marks__mark--double'
                : 'row-marks__mark row-marks__mark--full'
          }
        />
      ))}
    </span>
  )
}

/**
 * The Overall board's own columns, unchanged from before the picker existed:
 * Points, Cards, Copies, Last updated — exactly the cells the table used to hard-code.
 *
 * A function rather than a plain constant only because of the last column: the
 * "Last updated" cell's exact-timestamp tooltip has to honor the viewer's own
 * date/time format preference, which is only known inside `CardsLeaderboardSection`
 * — so this takes the bound formatter as an argument instead of calling
 * `formatDateTime` with no preference at module scope, and that component builds
 * it once via `useMemo`, keyed on the preference.
 */
export function overallColumns(formatExact: (date: Date) => string): LeaderboardColumn<BaseStanding>[] {
  return [
    {
      key: 'points',
      label: 'Points',
      numeric: true,
      cell: (row) =>
        /*
         * Kept beside `17/60` rather than replacing it: a bare score does not say how
         * far through the sixty a base is, and the fraction alone no longer explains
         * raising `MAX_CARD_COUNT` cannot leave this tooltip quoting a ceiling that no
         * longer exists. `+ COMPLETE_SET_BONUS` for the same reason: a base at the cap
         * on every card has, by construction, also held at least one of every card, so
         * it always earns the bonus too — computed, not a hand-typed 3,300 or 3,350,
         * so raising either constant cannot leave this tooltip stale.
         */
        row.recorded ? (
          <span
            title={`${formatFull(row.points)} of ${formatFull(
              row.size * cardPoints(MAX_CARD_COUNT) + COMPLETE_SET_BONUS,
            )} possible`}
          >
            {formatFull(row.points)}
          </span>
        ) : (
          <span className="card-meta">—</span>
        ),
    },
    {
      key: 'cards',
      label: 'Cards',
      numeric: true,
      cell: (row) =>
        /* A base nobody has ever saved is not a base holding zero of everything — the
           same distinction the grid's attribution line draws — so it says so in words
           instead of printing `0/60`. */
        row.recorded ? (
          <div className="donation-cell">
            <span>
              {row.distinct}/{row.size}
            </span>
            <Meter
              value={row.distinct}
              max={row.size}
              label={`${row.label} holds ${row.distinct} of ${row.size} cards`}
            />
          </div>
        ) : (
          <span className="card-meta">Nothing recorded yet</span>
        ),
    },
    {
      key: 'copies',
      label: 'Copies',
      numeric: true,
      cell: (row) => (row.recorded ? row.total : '—'),
    },
    {
      key: 'updated',
      label: LAST_UPDATED_LABEL,
      cell: (row) => lastUpdatedContent(row.updatedAt, formatExact),
    },
  ]
}

/** Rarity: the score itself, and the same distinct-cards fraction Overall's Cards
 *  column prints, against the full {@link ALL_CARDS} count — `RarityStanding` has no
 *  `size` of its own, unlike `BaseStanding`, because it ranks over the whole sixty
 *  rather than one deck. */
export const RARITY_COLUMNS: LeaderboardColumn<RarityStanding>[] = [
  {
    key: 'rarityScore',
    label: 'Rarity score',
    numeric: true,
    cell: (row) => formatFull(row.rarityScore),
  },
  {
    key: 'distinct',
    label: 'Cards',
    numeric: true,
    cell: (row) => (
      <div className="donation-cell">
        <span>
          {row.distinct}/{ALL_CARDS.length}
        </span>
        <Meter
          value={row.distinct}
          max={ALL_CARDS.length}
          label={`${row.label} holds ${row.distinct} of ${ALL_CARDS.length} cards`}
        />
      </div>
    ),
  },
]

/** By category: the distinct fraction *within the chosen deck* and points —
 *  `CategoryStanding.size` is that deck's own card count, so `7/19` reads as the
 *  deck being viewed, not the whole event. Cards leads, Points trails, matching
 *  every other board's convention of listing its primary ranking measure first —
 *  `categoryStandings()` ranks by distinct, then doubled, before points (see its
 *  own doc comment), so this table's column order follows the ranking rather than
 *  disagreeing with it the way the points-first order (this board's original
 *  design, from before the ranking itself changed) now would.
 *
 *  `×2` beside the fraction, not a color change on the meter: that meter's fill
 *  already uses `--accent` (blue) for "not yet complete" and switches to
 *  `--good` (green) once maxed, everywhere `Meter` is used — a doubled deck is a
 *  stronger *green*, not a different hue, so it earns a plain-text marker rather
 *  than fighting that existing meaning. */
export const CATEGORY_COLUMNS: LeaderboardColumn<CategoryStanding>[] = [
  {
    key: 'distinct',
    label: 'Cards',
    numeric: true,
    cell: (row) => (
      <div className="donation-cell">
        <span>
          {row.distinct}/{row.size}
          {row.doubled ? <strong style={{ color: 'var(--good-text)' }}> ×2</strong> : null}
        </span>
        <Meter
          value={row.distinct}
          max={row.size}
          label={
            row.doubled
              ? `${row.label} holds every card in this deck at least twice`
              : `${row.label} holds ${row.distinct} of ${row.size} cards`
          }
        />
      </div>
    ),
  },
  {
    key: 'points',
    label: 'Points',
    numeric: true,
    cell: (row) => formatFull(row.points),
  },
]

/** Full rows: the fraction plus the ten marks, then the three numbers behind the
 *  score, all printed regardless of whether the marks are worth a glance. */
export const ROWS_COLUMNS: LeaderboardColumn<RowStanding>[] = [
  {
    key: 'fullRows',
    label: 'Full rows',
    numeric: true,
    cell: (row) => (
      <div className="donation-cell">
        <span>
          {row.fullRowCount}/{row.rowLevels.length}
        </span>
        <RowMarks
          rowLevels={row.rowLevels}
          label={`${row.label} holds ${row.fullRowCount} of ${row.rowLevels.length} rows in full, ${row.doubleRowCount} of them doubled`}
        />
      </div>
    ),
  },
  {
    key: 'doubled',
    label: 'Doubled',
    numeric: true,
    cell: (row) => formatFull(row.doubleRowCount),
  },
  {
    key: 'streak',
    label: 'Streak bonus',
    numeric: true,
    cell: (row) => formatFull(row.streakBonus),
  },
  {
    key: 'score',
    label: 'Score',
    numeric: true,
    cell: (row) => formatFull(row.score),
  },
]

/** Full decks: how many (as a fraction of the four), which ones by name, and the
 *  distinct-cards tiebreak — a bare `2` would throw away the "which" half of what
 *  `deckCompletionStandings()` already computed. */
const DECK_CATEGORY_COUNT = cardCategoriesInOrder().length

export const DECKS_COLUMNS: LeaderboardColumn<DeckCompletionStanding>[] = [
  {
    key: 'completed',
    label: 'Decks complete',
    numeric: true,
    cell: (row) => `${row.completedCount}/${DECK_CATEGORY_COUNT}`,
  },
  {
    key: 'which',
    label: 'Which decks',
    cell: (row) =>
      row.completedDecks.length === 0 ? (
        <span className="card-meta">None yet</span>
      ) : (
        <span className="recents recents--stacked">
          {row.completedDecks.map((category) => (
            <span
              key={category}
              className="chip chip--static chip--deck"
              data-deck={deckSlug(category)}
            >
              {category}
              {row.doubledDecks.includes(category) ? ' ×2' : ''}
            </span>
          ))}
        </span>
      ),
  },
  {
    key: 'doubled',
    label: 'Doubled',
    numeric: true,
    cell: (row) => `${row.doubledCount}/${DECK_CATEGORY_COUNT}`,
  },
  {
    key: 'distinct',
    label: 'Distinct cards',
    numeric: true,
    cell: (row) => formatFull(row.distinct),
  },
]

/** Spares on hand: the two numbers `spareStandings()` computes, nothing more —
 *  the module's own doc explains why no fraction is printed here. */
export const SPARES_COLUMNS: LeaderboardColumn<SpareStanding>[] = [
  { key: 'spares', label: 'Spares', numeric: true, cell: (row) => formatFull(row.spares) },
  {
    key: 'variety',
    label: 'Spare variety',
    numeric: true,
    cell: (row) => formatFull(row.spareVariety),
  },
]

/** Most active trader: completed trades and distinct partners, straight off
 *  `TraderStanding`. */
export const TRADERS_COLUMNS: LeaderboardColumn<TraderStanding>[] = [
  {
    key: 'completed',
    label: 'Completed trades',
    numeric: true,
    cell: (row) => formatFull(row.completedTrades),
  },
  {
    key: 'partners',
    label: 'Distinct partners',
    numeric: true,
    cell: (row) => formatFull(row.distinctPartners),
  },
]

/**
 * The table shared by every ranking: Rank, Member and Owner, drawn once here, plus
 * whatever `columns` the active ranking supplies. This is the "share the markup and
 * the reasoning, differ on the rest" split the task asked for — the accessible-naming
 * comment below, the `roster--stack` phone behavior, and the `stack-title`/`data-label`
 * pairing are all one piece of markup now instead of seven copies of it.
 */
function LeaderboardTable<T extends LeaderboardRow>({
  rows,
  ariaLabel,
  columns,
}: {
  rows: readonly T[]
  ariaLabel: string
  columns: readonly LeaderboardColumn<T>[]
}) {
  return (
    <div className="table-wrap">
      {/*
       * Named with `aria-label` rather than pointed at the section's own `<h2>`.
       * `.section-title` is `text-transform: uppercase`, and Chrome computes an
       * accessible name from the *transformed* text — read back off the computed
       * tree, `aria-labelledby` gave this table the name "COLLECTION LEADERBOARD".
       * The visible heading is the same words, so label-in-name still holds. Each
       * ranking's own `ariaLabel` follows the same rule.
       */}
      <table className="roster roster--stack" role="table" aria-label={ariaLabel}>
        <thead role="rowgroup">
          <tr role="row">
            <th className="num" role="columnheader">
              Rank
            </th>
            <th role="columnheader">Member</th>
            <th role="columnheader">Owner</th>
            {columns.map((column) => (
              <th
                key={column.key}
                className={column.numeric ? 'num' : undefined}
                role="columnheader"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={row.tag} role="row">
              <td className="num" role="cell" data-label="Rank">
                {row.rank}
              </td>
              <td className="stack-title" role="cell">
                <a href={hrefFor({ view: 'player', tag: row.tag })}>{row.label}</a>
                {/* The tag, again as secondary text rather than as the heading. */}
                {row.label === row.tag ? null : (
                  <>
                    <br />
                    <span className="card-meta">{row.tag}</span>
                  </>
                )}
              </td>
              <td role="cell" data-label="Owner">
                {row.owner ?? <span className="role-pill">no owner set</span>}
              </td>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={column.numeric ? 'num' : undefined}
                  role="cell"
                  data-label={column.label}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * How far every tracked base has got, on whichever of the seven boards is chosen —
 * generic over the ranking's own row shape, so this one component is the Owner
 * filter, the row limit, the pager and the table shell for all of them.
 *
 * **Group-wide by default, and never filtered by the picker.** The Mine/All select at
 * the top of the page chooses which base you can *type into*; it has no business
 * narrowing a board about the whole clan's progress, and it still does not touch it.
 * The board sits directly under the trade suggestions because "who should trade with
 * whom" and "who is furthest ahead" are the same question asked two ways — the base
 * near the top with spares is the one worth messaging. That framing does not depend
 * on which of the seven rankings is showing.
 *
 * **Its own Owner filter is a separate control, and it exists for a question the
 * picker cannot answer.** An owner with several bases has a maintenance question,
 * "which of mine has nobody entered counts for lately", and the Owner select plus
 * (on Overall) the Last-updated column is that fact for every base at once. The board
 * still opens on **Everyone**, so nobody who came for the clan's progress has to put
 * the filter back — and the choice is shared across every ranking, since it is a
 * question about accounts, not about how any one board scores.
 *
 * **Neither paging nor the owner filter touches the rank.** The number in the first
 * column is each ranking's own `rank` — computed once over the whole board, shared on
 * a genuine tie and skipping the numbers a tie consumes — so rank 6 reads 6 wherever
 * it is printed. Numbering the visible rows instead would restart at 1 on page 2, and
 * ranking the filtered rows would renumber somebody's four bases to 1–4 and read as if
 * they were the clan; either turns the one column that means something into a row
 * counter. `filterStandingsByOwner` therefore only ever removes rows from a board
 * already numbered.
 *
 * The row limit and the Owner filter are shared **across every view**, not reset when
 * the picker changes: "how many rows" and "which owner" are questions about how you
 * read a board, not about which board you are reading, and switching views is not a
 * reason to make you re-pick either. A page number left past the end by a shorter
 * board is repaired by the same `paginate` clamp the owner filter already relies on.
 */
export function Leaderboard<T extends LeaderboardRow>({
  rows,
  ariaLabel,
  columns,
  filters,
}: {
  rows: readonly T[]
  ariaLabel: string
  columns: readonly LeaderboardColumn<T>[]
  /** Extra content in the same filter row as Owner — the Deck picker for "By
   *  category", reusing the slot rather than a second row of chrome. */
  filters?: ReactNode
}) {
  const [limit, setLimit] = useRowLimit('coc:cardStandingLimit', 5)
  const [page, setPage] = useState(1)
  /* Transient, like the card search and unlike the row limit: a filter that survived a
     reload would leave somebody opening the page to a board with most of the clan
     missing and no memory of having asked for that. */
  const [owner, setOwner] = useState(ALL_OWNERS)

  const ownerOptions = useMemo(() => standingOwnerOptions(rows), [rows])
  /* Derived rather than repaired by an effect, for the reason `activeTag` is: the
     board is re-read in the background, so the chosen owner can leave it. */
  const chosenOwner = activeOwnerFilter(ownerOptions, owner)
  const filtered = useMemo(() => filterStandingsByOwner(rows, chosenOwner), [rows, chosenOwner])
  const view = useMemo(() => paginate(filtered, limit, page), [filtered, limit, page])

  /* Two ways the board gets shorter under a page number that was fine a moment ago: a
     base losing its owner assignment, and the Owner filter narrowing it. Both leave
     the page past the end, `paginate` clamps for both, and this follows it — one
     repair rather than one per cause. */
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])

  if (rows.length === 0) return null

  return (
    <>
      {/*
       * Above the table, in the roster's own filter row, because it decides what the
       * table holds — and drawn only where it has something to choose between. One
       * owner and no unowned bases is two options that select the same board, which is
       * the control that answers a press by doing nothing that this page refuses to
       * hand out. `filters` (the Deck picker) always has a real choice when it is
       * passed at all, so it draws the row on its own even when Owner would not.
       */}
      {filters !== undefined || ownerOptions.length > 2 ? (
        <div className="roster-filters">
          {filters}
          {ownerOptions.length > 2 ? (
            <label htmlFor="leaderboard-owner">
              Owner
              <select
                id="leaderboard-owner"
                value={chosenOwner}
                onChange={(event) => setOwner(event.target.value)}
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
      ) : null}

      <LeaderboardTable rows={view.rows} ariaLabel={ariaLabel} columns={columns} />

      {/* At the bottom, beside the pager, exactly as the clan roster's is. */}
      <div className="roster-footer">
        <RowLimitSelect
          id="leaderboard-rows"
          options={STANDING_LIMITS}
          value={limit}
          onChange={(next) => {
            setLimit(next)
            setPage(1)
          }}
        />
        <Pager view={view} noun="bases" onPage={setPage} />
      </div>
    </>
  )
}
