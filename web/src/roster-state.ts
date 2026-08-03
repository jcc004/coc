import {
  nextSortState,
  NO_ROSTER_FILTERS,
  ROSTER_ASCENDING_BY_DEFAULT,
  type OwnerConflict,
  type RosterFilters,
  type RosterSortKey,
} from './saved-table.ts'

/**
 * The roster table's state machine.
 *
 * The table had thirteen `useState` hooks — selection, conflicts, approvals, three
 * filters, sort key, direction, page, bulk owner, note, busy, problem — and the
 * transitions between them were spread across six event handlers and two async
 * functions. Nothing was wrong with any single `setX`; what was wrong is that
 * "clearing the selection also drops the pending approvals, but cancelling the
 * approvals does *not* drop the selection" was a fact you could only establish by
 * reading every handler and holding ten variables in your head.
 *
 * So the transitions are named here instead, and they are the whole point of the
 * module: each action is one thing the user did, and the reducer is the only place
 * that decides what that does to the other nine values. Being pure, it is also the
 * cheap half to test — every rule below is asserted in `roster-state.test.ts` without
 * a DOM, a server, or a rendered table.
 *
 * What is deliberately *not* here: the rows themselves, the filtering, the sorting and
 * the paging. Those are `saved-table.ts`, they are already pure and tested, and they
 * are functions of the roster rather than state — duplicating them into the reducer
 * would give the table two answers to "which rows am I showing".
 *
 * The rows-per-page limit is also not here: it is persisted per browser by
 * `useRowLimit`, so it outlives every value in this state and belongs to the hook that
 * owns that storage.
 */

export interface RosterState {
  sortKey: RosterSortKey
  ascending: boolean
  page: number
  filters: RosterFilters
  /**
   * Tags ticked in the table. Deliberately not narrowed to the visible page: with
   * filters and paging a selection can include members you cannot currently see, and
   * a bulk apply still reaches them — which is why the bulk bar counts them
   * separately rather than pretending they are not selected.
   */
  selected: ReadonlySet<string>
  /** The account display name the bulk bar will write. `''` clears the assignment. */
  bulkOwner: string
  /** Rows a write did not touch because somebody is already recorded on them. */
  conflicts: OwnerConflict[] | null
  /** Of those, the ones the user has explicitly agreed to overwrite. */
  approved: ReadonlySet<string>
  /** What the last apply actually did, in words. */
  note: string | null
  busy: boolean
  /** A write that failed. Never shown alongside a note claiming one succeeded. */
  problem: string | null
}

export const INITIAL_ROSTER_STATE: RosterState = {
  sortKey: 'clanRank',
  ascending: true,
  page: 1,
  filters: NO_ROSTER_FILTERS,
  selected: new Set(),
  bulkOwner: '',
  conflicts: null,
  approved: new Set(),
  note: null,
  busy: false,
  problem: null,
}

/**
 * One thing the user (or the server) did. Named for the event rather than for the
 * field it happens to touch, because most of them touch several.
 */
export type RosterAction =
  /** A column head, or the stacked layout's Sort control. */
  | { type: 'sorted'; key: RosterSortKey }
  | { type: 'paged'; page: number }
  | { type: 'filtered'; field: keyof RosterFilters; value: string }
  | { type: 'filtersCleared' }
  | { type: 'rowPicked'; tag: string }
  /** The header checkbox. `tags` is this page's rows and nothing else. */
  | { type: 'pagePicked'; tags: readonly string[]; selecting: boolean }
  | { type: 'selectionDropped' }
  | { type: 'bulkOwnerPicked'; owner: string }
  | { type: 'writeStarted' }
  | { type: 'writeFailed'; problem: string }
  /** A write came back. `pending` is whatever still needs a human decision. */
  | { type: 'writeSettled'; note: string; pending: OwnerConflict[] }
  | { type: 'approvalPicked'; tag: string }
  /** Approve all / Approve none, which is one control reading its own state. */
  | { type: 'approvalsToggled' }
  /** Cancel: the approvals go, the selection stays, so it can be retried. */
  | { type: 'approvalsDropped' }
  /** Apply pressed with nothing ticked: every conflicting row keeps its owner. */
  | { type: 'approvalsDeclined' }

function toggled(set: ReadonlySet<string>, tag: string): Set<string> {
  const next = new Set(set)
  if (next.has(tag)) next.delete(tag)
  else next.add(tag)
  return next
}

export function rosterReducer(state: RosterState, action: RosterAction): RosterState {
  switch (action.type) {
    case 'sorted': {
      const next = nextSortState(
        { key: state.sortKey, ascending: state.ascending },
        action.key,
        ROSTER_ASCENDING_BY_DEFAULT,
      )
      /* Back to page 1: keeping the offset would land you in the middle of a freshly
         reordered list, which reads as rows having gone missing. */
      return { ...state, sortKey: next.key, ascending: next.ascending, page: 1 }
    }

    /* Same identity when the page has not moved, so the clamp that `paginate` reports
       back can be dispatched unconditionally without causing a render. */
    case 'paged':
      return state.page === action.page ? state : { ...state, page: action.page }

    /* Any filter change resets the page for the same reason a sort does — and because
       page 4 of a list that now has two pages is an empty table. */
    case 'filtered':
      return { ...state, filters: { ...state.filters, [action.field]: action.value }, page: 1 }

    case 'filtersCleared':
      return { ...state, filters: NO_ROSTER_FILTERS, page: 1 }

    case 'rowPicked':
      return { ...state, selected: toggled(state.selected, action.tag) }

    case 'pagePicked': {
      const selected = new Set(state.selected)
      for (const tag of action.tags) {
        if (action.selecting) selected.add(tag)
        else selected.delete(tag)
      }
      return { ...state, selected }
    }

    /*
     * Clear selection drops the pending approvals and the note with it: both describe
     * a selection that no longer exists, and a stale "3 need approval below" over an
     * empty conflict list is worse than nothing. The *problem* survives, because a
     * failed write is still a fact about the server whatever the user does next.
     */
    case 'selectionDropped':
      return { ...state, selected: new Set(), conflicts: null, note: null }

    case 'bulkOwnerPicked':
      return { ...state, bulkOwner: action.owner }

    case 'writeStarted':
      return { ...state, busy: true, problem: null }

    /* The note goes: nothing is claimed to have happened, because it may well not have. */
    case 'writeFailed':
      return { ...state, busy: false, note: null, problem: action.problem }

    /*
     * The selection is kept exactly when rows are still waiting on a decision — those
     * rows *are* the remaining work, and dropping the ticks would leave the approval
     * list describing members the table no longer shows as chosen.
     */
    case 'writeSettled':
      return {
        ...state,
        busy: false,
        note: action.note,
        conflicts: action.pending.length > 0 ? action.pending : null,
        approved: new Set(),
        selected: action.pending.length > 0 ? state.selected : new Set(),
      }

    case 'approvalPicked':
      return { ...state, approved: toggled(state.approved, action.tag) }

    case 'approvalsToggled': {
      const pending = state.conflicts ?? []
      return {
        ...state,
        approved:
          state.approved.size === pending.length
            ? new Set()
            : new Set(pending.map((conflict) => conflict.tag)),
      }
    }

    case 'approvalsDropped':
      return { ...state, conflicts: null, approved: new Set() }

    /* The note is left alone here: nothing was written, so the last one still
       describes the most recent thing that happened. */
    case 'approvalsDeclined':
      return { ...state, conflicts: null, approved: new Set(), selected: new Set() }
  }
}
