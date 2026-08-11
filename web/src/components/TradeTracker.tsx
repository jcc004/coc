import { useEffect, useMemo, useState } from 'react'
import type { SessionUser, TradeRecord } from '@coc/shared'
import { ApiError } from '../api.ts'
import { cardById } from '../cards.ts'
import { formatRelative } from '../format.ts'
import { hrefFor, useRowLimit } from '../hooks.ts'
import { useOwners } from '../owners.ts'
import { paginate, type PagedRows, type RowLimit } from '../saved-table.ts'
import {
  pendingCount,
  sidesOfTrade,
  sortTrades,
  tradeResolveAccess,
  tradeRowId,
  tradesInvolving,
  tradeUndoAccess,
} from '../trade-tracker.ts'
import { completeTrade, declineTrade, undoTrade, useTradesState } from '../trades.ts'
import { TradeResolutionRules } from './help-copy.tsx'
import { GameIcon, Pager, RowLimitSelect } from './primitives.tsx'

/**
 * The Trade Tracker: swaps two members have agreed to, and what became of them.
 *
 * It sits **below the trade suggestions** everywhere the suggestions appear — the
 * card page and each player page's card panel — because the two are one workflow
 * read downwards: the suggestions say what *could* be swapped, the tracker says what
 * *is being* swapped. One component for both, like `TradeSuggestions` itself, so the
 * two pages cannot drift apart on the rules or the wording; the only difference is
 * {@link TradeTracker.focusTag}.
 *
 * What separates it from the suggestions above it is that **a row here has
 * consequences**. A suggestion is arithmetic over the counts, recomputed from
 * scratch whenever they change. A trade is a stored agreement between two people,
 * and completing one *writes to both their bases* — so this panel is where the
 * confirmation, the audit line and the who-may-act rule live. The rules themselves
 * are in `trade-tracker.ts`, tested, mirroring the server's; the server is the
 * enforcement and this only stops the UI offering what would be refused.
 */

/** Rows-per-page, matching the suggestions' options above it. */
const TRADE_LIMITS: RowLimit[] = [5, 10, 20, 'all']

/** One side's card: the picture and the name, as the suggestions draw it. */
function TradeCard({ cardId }: { cardId: number }) {
  const card = cardById(cardId)
  if (!card) return <>Card {cardId}</>
  return (
    <span className="trade-card">
      <GameIcon src={card.image} className="trade-card__img" />
      {card.name}
    </span>
  )
}

/**
 * A base as a person: the member name links to the base, the tag stays underneath.
 *
 * Same treatment as the suggestions table, and for the same reason — the name is
 * what somebody recognizes, the tag is the identity everything is keyed on. The tag
 * is dropped only when it *is* the label, i.e. when no roster we can see names it.
 */
function BaseLabel({ tag, label }: { tag: string; label: string }) {
  return (
    <>
      <a href={hrefFor({ view: 'player', tag })}>{label}</a>
      {label === tag ? null : (
        <>
          <br />
          <span className="card-meta">{tag}</span>
        </>
      )}
    </>
  )
}

/** Absolute in the tooltip, relative on screen — as everywhere else in the app. */
function Stamp({ at }: { at: string }) {
  const when = new Date(at)
  return (
    <time dateTime={at} title={when.toLocaleString()}>
      {formatRelative(when)}
    </time>
  )
}

/**
 * The audit half of the record: who did what, and when — up to **three** events
 * now, not two. "Bert completed it" without "Anna proposed it" loses which
 * direction the agreement came from, which is the thing somebody checks when a
 * swap turns out to be wrong; an undone trade loses just as much if it stops
 * saying who completed it, because `resolvedBy` / `resolvedAt` are left exactly as
 * completion wrote them (undo is a third event, not a rewrite of the second — see
 * `TradeRecord.undoneAt`). A `null` name means that account has since been
 * deleted, which is said rather than blanked: the trade is the record of
 * something that really happened and has to outlive every account it names.
 */
function AuditLine({ trade }: { trade: TradeRecord }) {
  const gone = 'a deleted account'

  return (
    <span className="card-meta trade-audit">
      Proposed by {trade.proposedBy ?? gone} <Stamp at={trade.proposedAt} />
      {trade.resolvedAt === null ? null : (
        <>
          {' · '}
          {trade.status === 'declined' ? 'declined' : 'completed'} by{' '}
          {trade.resolvedBy ?? gone} <Stamp at={trade.resolvedAt} />
        </>
      )}
      {trade.undoneAt === null ? null : (
        <>
          {' · '}
          undone by {trade.undoneBy ?? gone} <Stamp at={trade.undoneAt} />
        </>
      )}
    </span>
  )
}

/** `pending` / `complete` / `declined` / `undone` as a badge, on the fixed status palette. */
function StatusBadge({ status }: { status: TradeRecord['status'] }) {
  const label =
    status === 'pending'
      ? 'Pending'
      : status === 'complete'
        ? 'Complete'
        : status === 'declined'
          ? 'Declined'
          : 'Undone'
  return <span className={`trade-status trade-status--${status}`}>{label}</span>
}

/**
 * The two buttons, or the reason there are none.
 *
 * Completing changes *somebody else's* card counts immediately, and a trade
 * resolves once, so there is no "actually, no" button afterwards *for the party
 * who clicked it* — reversing it at all is `UndoAction` below, which any party (or
 * an admin) may reach for, the same as this. Declining is the same shape: nothing
 * moves, but it is likewise final; either party can make it and the audit line
 * records who did.
 *
 * A refusal is shown rather than hidden. Somebody looking at a pending swap between
 * two other people should be told it is theirs to resolve, not left wondering why
 * the buttons are missing.
 */
function ResolveActions({
  trade,
  user,
}: {
  trade: TradeRecord
  user: Pick<SessionUser, 'id' | 'role'>
}) {
  const owners = useOwners()
  const [busy, setBusy] = useState<'complete' | 'decline' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const access = useMemo(
    () => tradeResolveAccess(user, trade, sidesOfTrade(trade, owners)),
    [user, trade, owners],
  )

  if (!access.allowed) {
    /* Already-resolved needs no note: the status badge and the audit line beside it
       have just said so, and repeating it in the actions column would be a third
       copy of the same sentence. Not-a-party does need one. */
    if (access.refusal === 'alreadyResolved') return null
    return <span className="card-meta">{access.message}</span>
  }

  async function act(action: 'complete' | 'decline') {
    setBusy(action)
    setProblem(null)
    try {
      await (action === 'complete' ? completeTrade(trade.id) : declineTrade(trade.id))
    } catch (cause) {
      /* Both plausible failures are somebody else having acted first — resolved it,
         or spent the spare this swap needed — so the server's message is the
         explanation and is shown verbatim. The list refreshes either way. */
      setProblem(cause instanceof ApiError ? cause.message : 'Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button
        type="button"
        className="chip"
        disabled={busy !== null}
        onClick={() => void act('complete')}
        title="Both bases swap the card — this changes the counts"
      >
        {busy === 'complete' ? 'Completing…' : 'Complete'}
      </button>{' '}
      <button
        type="button"
        className="chip"
        disabled={busy !== null}
        onClick={() => void act('decline')}
        title="Nothing moves; the trade is closed"
      >
        {busy === 'decline' ? 'Declining…' : 'Decline'}
      </button>
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </>
  )
}

/**
 * The Undo button, on a `complete` trade only.
 *
 * **Party-or-admin — the same rule `ResolveActions` uses.** This used to be an
 * admin's alone, with no party exception at all, on the reasoning that undo
 * reopens a record that already closed rather than making the first decision
 * about an open one. That restriction is gone now, on purpose: an owner of either
 * base may undo a trade they are a party to, exactly as they may complete or
 * decline it. An admin still may undo any trade regardless of ownership.
 *
 * It stays a separate component beside `ResolveActions` rather than folding into
 * it, because the two still answer different questions even though *who* may ask
 * them is now identical: "may this session close a *pending* trade" versus "may
 * this session reopen a *complete* one" — different refusal shapes
 * (`alreadyResolved` there, `notComplete` here) and a different action.
 *
 * A refusal is **shown**, not hidden, for `notAParty` — the same reasoning
 * `ResolveActions` already uses for its own `notAParty` case, and the reasoning
 * that did not apply here before this change: now that a party can genuinely act,
 * somebody looking at a completed swap between two other people should be told it
 * is theirs to undo, not left wondering why the button is missing. `notComplete`
 * still hides with nothing shown — the status badge and the audit line beside it
 * already say the trade is not in an undoable state, and repeating that here would
 * be a third copy of the same sentence, the same reasoning `ResolveActions` uses
 * for its own `alreadyResolved` case.
 *
 * **Still asks first**, unlike Complete: undo is the one action left on a trade
 * that confirms before it runs, because reopening a trade is rarer than resolving
 * one and reverses something that already happened. The question says what moves,
 * that it happens immediately for everyone, and that undoing itself has no further
 * undo. That is independent of *who* is asking, so it did not change when the
 * party restriction was lifted.
 */
function UndoAction({
  trade,
  user,
}: {
  trade: TradeRecord
  user: Pick<SessionUser, 'id' | 'role'>
}) {
  const owners = useOwners()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const access = useMemo(
    () => tradeUndoAccess(user, trade, sidesOfTrade(trade, owners)),
    [user, trade, owners],
  )

  if (!access.allowed) {
    // notComplete needs no note: the status badge and the audit line beside it
    // have just said so. notAParty does need one — see the doc comment above.
    if (access.refusal === 'notComplete') return null
    return <span className="card-meta">{access.message}</span>
  }

  async function act() {
    const question =
      `Undo this trade? It moves the card back on both bases straight away, for ` +
      `everyone, and undoing cannot itself be undone.`
    if (!window.confirm(question)) return

    setBusy(true)
    setProblem(null)
    try {
      await undoTrade(trade.id)
    } catch (cause) {
      /* The plausible failure is the same shape as a resolve failure: somebody
         else already undid it, or the counts have moved since completion so a
         base no longer holds what it would have to give back. The server's
         message is the explanation and is shown verbatim. */
      setProblem(cause instanceof ApiError ? cause.message : 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="chip"
        disabled={busy}
        onClick={() => void act()}
        title="Moves the card back on both bases — this changes the counts"
      >
        {busy ? 'Undoing…' : 'Undo'}
      </button>
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </>
  )
}

export function TradeTracker({
  user,
  labelOf,
  focusTag,
}: {
  user: Pick<SessionUser, 'id' | 'role'>
  /**
   * The same member-name resolver the suggestions and the base picker use, so a base
   * is called one thing everywhere on the page.
   */
  labelOf: (tag: string) => string
  /**
   * One base to narrow to: only the trades it is a side of, for the player page,
   * where the whole panel is about that base. Omitted, it is the clan's whole
   * tracker, which is what the card page wants.
   */
  focusTag?: string
}) {
  const { status, entries, error } = useTradesState()

  const rows = useMemo(() => {
    const scoped = focusTag === undefined ? entries : tradesInvolving(entries, focusTag)
    return sortTrades(scoped)
  }, [entries, focusTag])

  const [limit, setLimit] = useRowLimit('coc:tradeTrackerLimit', 5)
  const [page, setPage] = useState(1)
  const view = useMemo(() => paginate(rows, limit, page), [rows, limit, page])

  /* Resolving a trade can shrink nothing but the pending count, yet a *filter* or a
     new page size can leave the page number past the end; `paginate` clamps and this
     puts the control back in step with it. Same guard as the suggestions'. */
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])

  const waiting = pendingCount(rows)

  /*
   * The rules — who may resolve one, and that Complete moves cards for everyone and
   * cannot be undone — used to be the line *under a populated table*, so they were
   * absent from an empty tracker and, more to the point, from the tracker somebody
   * reads before they have ever completed anything. They are a disclosure now,
   * rendered whatever state the list is in, sharing `TradeResolutionRules` with the
   * help page.
   *
   * It is drawn even on a load failure: that message is about the network, and the
   * rules are still what the panel is for.
   */
  return (
    <>
      {status === 'error' && entries.length === 0 ? (
        <p className="empty-hint">
          Could not load the trade tracker{error ? `: ${error.message}` : '.'}
        </p>
      ) : rows.length === 0 ? (
        <p className="empty-hint">
          {status === 'loading'
            ? 'Loading agreed trades…'
            : focusTag === undefined
              ? 'No trades proposed yet. Propose one from the suggestions above and it appears here for the other member to approve.'
              : 'No trades proposed for this base yet. Propose one from the suggestions above.'}
        </p>
      ) : (
        <TrackerTable
          view={view}
          rowTotal={rows.length}
          waiting={waiting}
          labelOf={labelOf}
          user={user}
          limit={limit}
          onLimit={(next) => {
            setLimit(next)
            setPage(1)
          }}
          onPage={setPage}
        />
      )}

      <details className="group">
        <summary>Who can complete a trade, and what completing does</summary>
        <div className="group__body help-prose">
          <TradeResolutionRules />
        </div>
      </details>
    </>
  )
}

/**
 * The table, its pager and its count line: the part that only exists once a trade
 * has been proposed.
 *
 * Extracted for the same reason the suggestions' table was — so the rule disclosure
 * can sit outside the empty-and-error checks without the whole body becoming one
 * ternary. It draws what it is given and decides nothing.
 */
function TrackerTable({
  view,
  rowTotal,
  waiting,
  labelOf,
  user,
  limit,
  onLimit,
  onPage,
}: {
  view: PagedRows<TradeRecord>
  /** Every trade in scope, not just this page's — the count line says "of N". */
  rowTotal: number
  waiting: number
  labelOf: (tag: string) => string
  user: Pick<SessionUser, 'id' | 'role'>
  limit: RowLimit
  onLimit: (next: RowLimit) => void
  onPage: (next: number) => void
}) {
  return (
    <>
      <div className="table-wrap">
        {/* Stacks into one labeled card per trade on a phone, with the explicit
            roles that keep it a table for assistive tech once `display` changes.
            `aria-label`, never `aria-labelledby` the heading above: that heading is
            a `.section-title`, which is uppercased in CSS, and Chrome computes the
            accessible name from the *transformed* text — pointing at it would name
            this table "TRADE TRACKER". Same reasoning as the suggestions'. */}
        <table className="roster roster--stack roster--divided" role="table" aria-label="Trade tracker">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader">Member</th>
              <th role="columnheader">Gives</th>
              <th role="columnheader">Member</th>
              <th role="columnheader">Gives</th>
              <th role="columnheader">Status</th>
              <th role="columnheader" />
            </tr>
          </thead>
          <tbody role="rowgroup">
            {view.rows.map((trade) => (
              <tr
                key={trade.id}
                id={tradeRowId(trade.id)}
                role="row"
                /* A valid focus target, the same way the card page's section
                   headings are (see `jumpToSection`, `CardsView.tsx`) — so
                   `ProposeButton`'s "On the tracker" link can land the caret on
                   this exact row rather than merely scrolling near it. */
                tabIndex={-1}
              >
                <td className="stack-title" role="cell">
                  <BaseLabel tag={trade.baseA} label={labelOf(trade.baseA)} />
                </td>
                <td role="cell" data-label={`${labelOf(trade.baseA)} gives`}>
                  <TradeCard cardId={trade.cardFromA} />
                </td>
                <td className="stack-title" role="cell">
                  <BaseLabel tag={trade.baseB} label={labelOf(trade.baseB)} />
                </td>
                <td role="cell" data-label={`${labelOf(trade.baseB)} gives`}>
                  <TradeCard cardId={trade.cardFromB} />
                </td>
                {/* The state and its audit trail in one cell: "complete" and "by
                    whom, when" are one fact, and splitting them across two columns
                    would put the stamp under its own header on a phone. */}
                <td role="cell" data-label="Status">
                  <StatusBadge status={trade.status} />
                  <br />
                  <AuditLine trade={trade} />
                </td>
                <td className="row-actions" role="cell" data-label="Actions">
                  <ResolveActions trade={trade} user={user} />
                  <UndoAction trade={trade} user={user} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="roster-footer">
        <RowLimitSelect
          id="trade-tracker"
          label="Trades"
          options={TRADE_LIMITS}
          value={limit}
          onChange={onLimit}
        />
        <Pager view={view} noun="trades" onPage={onPage} />
      </div>

      {/* How many need somebody, and nothing else — the rules that used to finish
          this sentence are in the disclosure below, where they survive an empty list. */}
      <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
        {waiting === 0
          ? `Nothing waiting — all ${rowTotal} trade${rowTotal === 1 ? ' is' : 's are'} resolved.`
          : `${waiting} waiting on somebody, of ${rowTotal}.`}
      </p>
    </>
  )
}
