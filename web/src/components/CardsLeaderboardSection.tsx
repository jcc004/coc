import { useCallback, useMemo } from 'react'
import { type BaseInventory, type CardCategory, type SessionUser } from '@coc/shared'
import { baseStandings, cardPoints } from '../card-standings.ts'
import { ALL_CARDS, cardCategoriesInOrder } from '../cards.ts'
import { categoryStandings } from '../category-standings.ts'
import { deckCompletionStandings } from '../deck-completion-standings.ts'
import { formatDateTime } from '../format.ts'
import { useDateFormatPreference, usePersistedChoice } from '../hooks.ts'
import {
  LEADERBOARD_VIEWS,
  parseLeaderboardCategory,
  parseLeaderboardView,
  type LeaderboardView,
} from '../leaderboard-view.ts'
import { rarityStandings } from '../rarity-standings.ts'
import { ROW_SIZE, rowStandings } from '../row-standings.ts'
import { spareStandings } from '../spares-standings.ts'
import { traderStandings } from '../trader-standings.ts'
import { useTrades } from '../trades.ts'
import {
  CategoryScoringRules,
  DeckCompletionScoringRules,
  RarityScoringRules,
  RowScoringRules,
  ScoringRules,
  SpareScoringRules,
  TraderScoringRules,
} from './help-copy.tsx'
import {
  CATEGORY_COLUMNS,
  DECKS_COLUMNS,
  Leaderboard,
  overallColumns,
  RARITY_COLUMNS,
  ROWS_COLUMNS,
  SPARES_COLUMNS,
  TRADERS_COLUMNS,
  type LeaderboardViewConfig,
} from './Leaderboard.tsx'

/** Where the chosen leaderboard ranking is remembered — `coc:`-prefixed, the same
 *  convention `coc:cardTotalSort` and `coc:cardStandingLimit` already use. */
const LEADERBOARD_VIEW_KEY = 'coc:cardLeaderboardView'

/** Where the "By category" board's chosen deck is remembered, separately from the
 *  view itself: switching away from "By category" and back should not lose which
 *  deck was open. */
const LEADERBOARD_CATEGORY_KEY = 'coc:cardLeaderboardCategory'

/**
 * The collection leaderboard: the seven-board picker, and everything below it —
 * `CardsView`'s own "Collection leaderboard" `<section>`/`<h2>` stays in that file
 * (matching how `TradeSuggestions` is mounted), and this renders only the picker
 * and whichever board it has chosen.
 *
 * **Group-wide by construction, like `Leaderboard` itself.** `bases` and `tags` are
 * `CardsView`'s own group-wide state, not narrowed by that page's Mine/All filter —
 * see `Leaderboard`'s own doc comment for why none of the seven boards may be.
 */
export function CardsLeaderboardSection({
  bases,
  tags,
  labelOf,
  ownerOf,
  ownerUserIdOf,
  user,
}: {
  bases: readonly BaseInventory[]
  tags: readonly string[]
  labelOf: (tag: string) => string
  ownerOf: (tag: string) => string | undefined
  ownerUserIdOf: (tag: string) => number | null
  user: SessionUser
}) {
  const [dateFormat] = useDateFormatPreference(user.id)
  const formatExact = useCallback((date: Date) => formatDateTime(date, dateFormat), [dateFormat])
  const overallColumnsMemo = useMemo(() => overallColumns(formatExact), [formatExact])

  /* Group-wide, both of them, whatever the filter says — narrowed to one person's
     bases they would stop meaning anything. `tags` and `bases`, never `options`.
     Shared across all seven rankings below: every one of them takes the same
     `(bases, inventory)` shape `baseStandings` does, so this is computed once rather
     than seven times over the same `tags.map`. */
  const standingBases = useMemo(
    () =>
      tags.map((tag) => ({
        tag,
        label: labelOf(tag),
        owner: ownerOf(tag) ?? null,
        ownerUserId: ownerUserIdOf(tag),
      })),
    [tags, labelOf, ownerOf, ownerUserIdOf],
  )
  const standings = useMemo(() => baseStandings(standingBases, bases), [standingBases, bases])
  /* The Trade Tracker's rows, mirrored client-side — the same store `TradeSuggestions`
     and `TradeTracker` already read, needed here only for the "Most active trader"
     board. */
  const trades = useTrades()
  const rarityRankings = useMemo(() => rarityStandings(standingBases, bases), [standingBases, bases])
  const categoryRankings = useMemo(
    () => categoryStandings(standingBases, bases),
    [standingBases, bases],
  )
  const rowRankings = useMemo(() => rowStandings(standingBases, bases), [standingBases, bases])
  const deckRankings = useMemo(
    () => deckCompletionStandings(standingBases, bases),
    [standingBases, bases],
  )
  const spareRankings = useMemo(() => spareStandings(standingBases, bases), [standingBases, bases])
  const traderRankings = useMemo(() => traderStandings(standingBases, trades), [standingBases, trades])

  /* Which of the seven boards the picker shows, and which deck "By category" is
     showing — both remembered per browser, the same `coc:`-prefixed `localStorage`
     mechanism as the row limit and the totals panel's own sort control. */
  const [leaderboardView, setLeaderboardView] = usePersistedChoice(
    LEADERBOARD_VIEW_KEY,
    parseLeaderboardView,
  )
  const [leaderboardCategory, setLeaderboardCategory] = usePersistedChoice(
    LEADERBOARD_CATEGORY_KEY,
    parseLeaderboardCategory,
  )

  /*
   * One entry per `LeaderboardView`, so the three renders below the picker —
   * the explanatory paragraph, the `<Leaderboard>` table itself, and the
   * scoring-rules disclosure — are a single lookup by `leaderboardView`
   * rather than three parallel 7-way ternary chains, each of which used to
   * end in a bare `else` that a forgotten eighth view would have fallen into
   * silently. `Record<LeaderboardView, LeaderboardViewConfig>` is what makes
   * this exhaustive at compile time instead: TypeScript refuses to compile if
   * a member of the union is missing an entry, so adding a view to
   * `leaderboard-view.ts` without adding it here is a build failure, not a
   * board that quietly renders the wrong paragraph.
   *
   * Rebuilt every render rather than memoized: every field is either a plain
   * string/JSX literal or a `<Leaderboard>` element referencing this render's
   * own `standings`/`rarityRankings`/etc., so there is nothing here more
   * expensive than the ternary chains it replaces.
   */
  const leaderboardBoards: Record<LeaderboardView, LeaderboardViewConfig> = {
    overall: {
      intro: (
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Every tracked base, by <strong>points</strong>: {cardPoints(1)} for the first copy of a
          card and less for every copy after it, so breadth outranks hoarding. Level on points,
          more distinct cards of {ALL_CARDS.length} goes first. Not affected by <strong>Show</strong>:
          this is the whole clan. <strong>Owner</strong> narrows which rows are drawn — the rank
          stays each base's place on the whole board, so it never renumbers.
        </p>
      ),
      board: (
        <Leaderboard rows={standings} ariaLabel="Collection leaderboard" columns={overallColumnsMemo} />
      ),
      scoringRules: <ScoringRules />,
    },
    rarity: {
      intro: (
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Every tracked base, by <strong>rarity score</strong>: one distinct card scores once,
          weighted by how scarce it is across the whole clan right now — a spare of a card already
          held adds nothing here. Level on rarity score, more distinct cards overall goes first.
          Not affected by <strong>Show</strong>: this is the whole clan. <strong>Owner</strong>{' '}
          narrows which rows are drawn — the rank stays each base's place on the whole board, so
          it never renumbers.
        </p>
      ),
      board: (
        <Leaderboard rows={rarityRankings} ariaLabel="Rarity leaderboard" columns={RARITY_COLUMNS} />
      ),
      scoringRules: <RarityScoringRules />,
    },
    category: {
      intro: (
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          {leaderboardCategory}, by <strong>distinct cards held in this deck alone</strong> — a
          base's other three decks do not count here. Level on distinct cards, a{' '}
          <strong>doubled</strong> deck — every card in it held twice — goes first, then more
          points decides. Not affected by <strong>Show</strong>: this is the whole clan.{' '}
          <strong>Owner</strong> narrows which rows are drawn — the rank stays each base's place
          on this deck's board, so it never renumbers.
        </p>
      ),
      board: (
        <Leaderboard
          rows={categoryRankings[leaderboardCategory]}
          ariaLabel={`${leaderboardCategory} leaderboard`}
          columns={CATEGORY_COLUMNS}
          filters={
            /* Same slot Owner already sits in, reused rather than a second filter
               row — see `Leaderboard`'s own doc for why `filters` draws unconditionally
               whenever it is passed at all: the four decks are always a real choice. */
            <label htmlFor="leaderboard-category">
              Deck
              <select
                id="leaderboard-category"
                value={leaderboardCategory}
                onChange={(event) => setLeaderboardCategory(event.target.value as CardCategory)}
              >
                {cardCategoriesInOrder().map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      ),
      scoringRules: <CategoryScoringRules />,
    },
    rows: {
      intro: (
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Every tracked base, by the real game's own {ROW_SIZE}-wide collection screen:{' '}
          <strong>10 points</strong> for every row held in full, plus <strong>5 more</strong> for
          each row of every unbroken streak of two or more full rows — so a run of three and a
          separate run of two each earn their own bonus, not just the longer of the two — plus{' '}
          <strong>10 more</strong> for each row held twice over, shown as a blue mark instead of
          green. Level on score, more full rows outright goes first. Not affected by{' '}
          <strong>Show</strong>: this is the whole clan. <strong>Owner</strong> narrows which rows
          are drawn — the rank stays each base's place on the whole board, so it never renumbers.
        </p>
      ),
      board: <Leaderboard rows={rowRankings} ariaLabel="Full rows leaderboard" columns={ROWS_COLUMNS} />,
      scoringRules: <RowScoringRules />,
    },
    decks: {
      intro: (
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Every tracked base, by how many of the four decks it holds <strong>outright</strong> — 0
          through 4, not how far into any one it has got. Level on decks complete, more{' '}
          <strong>doubled</strong> decks — every card in a deck held twice, marked{' '}
          <strong>×2</strong> on its chip — goes first, then more distinct cards held overall. Not
          affected by <strong>Show</strong>: this is the whole clan. <strong>Owner</strong> narrows
          which rows are drawn — the rank stays each base's place on the whole board, so it never
          renumbers.
        </p>
      ),
      board: (
        <Leaderboard rows={deckRankings} ariaLabel="Full decks leaderboard" columns={DECKS_COLUMNS} />
      ),
      scoringRules: <DeckCompletionScoringRules />,
    },
    spares: {
      intro: (
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Every tracked base, by <strong>tradeable spares</strong> — copies beyond the one kept of
          each card, summed across all {ALL_CARDS.length}. A base never counts its last copy. Level
          on spares, more spare variety (distinct cards with a spare) goes first. Not affected by{' '}
          <strong>Show</strong>: this is the whole clan. <strong>Owner</strong> narrows which rows
          are drawn — the rank stays each base's place on the whole board, so it never renumbers.
        </p>
      ),
      board: (
        <Leaderboard
          rows={spareRankings}
          ariaLabel="Spares on hand leaderboard"
          columns={SPARES_COLUMNS}
        />
      ),
      scoringRules: <SpareScoringRules />,
    },
    traders: {
      intro: (
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Every tracked base, by <strong>completed trades</strong> — the Trade Tracker's own board,
          counted by base rather than by owner, so running several bases does not inflate the
          count. Level on trades, more distinct trading partners goes first. Not affected by{' '}
          <strong>Show</strong>: this is the whole clan. <strong>Owner</strong> narrows which rows
          are drawn — the rank stays each base's place on the whole board, so it never renumbers.
        </p>
      ),
      board: (
        <Leaderboard
          rows={traderRankings}
          ariaLabel="Most active trader leaderboard"
          columns={TRADERS_COLUMNS}
        />
      ),
      scoringRules: <TraderScoringRules />,
    },
  }

  return (
    <>
      {/*
       * The picker, at the top of the leaderboard table: seven boards over the same
       * tracked bases, sharing the row-limit/Owner/pager chrome in `Leaderboard`
       * below and differing only in what they rank by. Matches the compact-select
       * pattern `RowLimitSelect` and `#card-total-sort` already use on this page,
       * and persists the same way that control does — see `usePersistedChoice`.
       */}
      <label className="row-limit" htmlFor="leaderboard-view" style={{ marginBottom: 12 }}>
        View
        <select
          id="leaderboard-view"
          value={leaderboardView}
          onChange={(event) => setLeaderboardView(event.target.value as LeaderboardView)}
        >
          {LEADERBOARD_VIEWS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/*
       * This line said "by distinct cards out of 60. Level on that, more copies goes
       * first", which stopped being true when the measure became points in 42a5df9.
       * Distinct cards is now only the *tie-break*; points is the measure.
       *
       * The direction the old sentence implied was right, though, and it is worth
       * recording which way round it goes, because it is easy to state backwards:
       * breadth wins, decisively. Six cards held once scores 60, which already beats
       * the 55 that ten copies of a single card scores — and ten is the cap, so no
       * one card can ever contribute more. Eight singles (80) beat nine copies of one
       * (54) comfortably.
       *
       * The curve itself is in the disclosure below, where it can be read without
       * turning this intro into a paragraph, and on the help page — one source. The
       * six paragraphs below it are that board's own equivalent, one per view, so a
       * reader who never opens the disclosure still gets the one sentence that
       * matters for whichever board they are looking at.
       */}
      {leaderboardBoards[leaderboardView].intro}

      {leaderboardBoards[leaderboardView].board}

      <details className="group">
        <summary>{leaderboardView === 'overall' ? 'How the points work' : 'How this board scores'}</summary>
        <div className="group__body help-prose">{leaderboardBoards[leaderboardView].scoringRules}</div>
      </details>
    </>
  )
}
