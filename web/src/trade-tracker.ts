import type { OwnerRecord, SessionUser, TradeRecord, TradeStatus } from '@coc/shared'
import { baseOwnerOf, type BaseOwner } from './card-entry.ts'

/**
 * The rules behind the Trade Tracker: who may act on a trade, and what order the
 * list is in.
 *
 * Here rather than in `TradeTracker.tsx` for the same reason `card-entry.ts` is not
 * in `BaseCardEditor` — each has a wrong answer that costs something real and that
 * a screenshot would not catch:
 *
 * - **who may act.** Completing a trade *moves cards on two bases*, one of which the
 *   person clicking very likely does not own. Offering that button to somebody the
 *   server will refuse is a lie told at the moment of clicking; hiding it from a
 *   genuine party strands an agreed swap with nobody able to record it;
 * - **what order.** Pending trades are the only rows anybody has to do something
 *   about, so they come first regardless of age. Resolved rows are history and read
 *   newest-first. A comparator that stopped at the status would leave same-status
 *   rows in arrival order, which reshuffles between polls.
 *
 * `tradeAction` mirrors `server/src/cards/trade-access.ts` — the server remains the
 * enforcement, this only stops the UI offering what will be refused — so both are
 * pure functions with their own tests and the wording is deliberately the same.
 */

/* ---------- who may act ---------- */

/**
 * One side of a trade: the base, and who — if anyone — holds it.
 *
 * The tag travels with the ownership because the refusal has to name the side it is
 * talking about, and an unowned base has no other name to give.
 */
export interface TradeSide extends BaseOwner {
  tag: string
}

export interface TradeSides {
  baseA: TradeSide
  baseB: TradeSide
}

/** Resolves the two tags against the owner list, the way the grid resolves one. */
export function sidesOfTrade(
  trade: Pick<TradeRecord, 'baseA' | 'baseB'>,
  owners: readonly OwnerRecord[],
): TradeSides {
  const find = (tag: string): TradeSide => ({
    tag,
    ...baseOwnerOf(owners.find((record) => record.tag === tag)),
  })
  return { baseA: find(trade.baseA), baseB: find(trade.baseB) }
}

export type TradeRefusal = 'notAParty' | 'alreadyResolved'

export type TradeAccess =
  | { allowed: true }
  | { allowed: false; refusal: TradeRefusal; message: string }

const ALLOWED: TradeAccess = { allowed: true }

/** `Jared`, or a phrase saying why the side names nobody who can act. */
function describeSide(side: TradeSide): string {
  if (side.ownerUserId !== null) return side.ownerLabel ?? `${side.tag}'s owner`
  if (side.ownerLabel !== null) return `${side.ownerLabel} (not linked to an account)`
  return `${side.tag} (no owner set)`
}

/** True when this account owns one of the two bases. Ids only — labels never. */
function isParty(user: Pick<SessionUser, 'id'>, sides: TradeSides): boolean {
  return (
    (sides.baseA.ownerUserId !== null && sides.baseA.ownerUserId === user.id) ||
    (sides.baseB.ownerUserId !== null && sides.baseB.ownerUserId === user.id)
  )
}

/**
 * May this session propose a swap between these two bases?
 *
 * Owning **one** side is enough: a swap is worth recording as soon as one party
 * means it, and the other party is the one who resolves it. Owning neither is not,
 * because that is putting words in two other people's mouths — they would have to
 * decline something they never discussed. An admin may do either, for the reason
 * they may write any base's counts: they can reassign ownership to themselves in
 * one request, so refusing them would stop nothing.
 *
 * A base carrying only a **legacy text label** grants nobody anything, exactly as
 * in `cardEntryAccess`. The label is a note about a person, not a permission held
 * by a session.
 */
export function tradeProposeAccess(
  user: Pick<SessionUser, 'id' | 'role'>,
  sides: TradeSides,
  verb = 'propose this trade',
): TradeAccess {
  if (isParty(user, sides) || user.role === 'admin') return ALLOWED

  return {
    allowed: false,
    refusal: 'notAParty',
    message: `This swap is between ${describeSide(sides.baseA)} and ${describeSide(
      sides.baseB,
    )}. Only either owner, or an admin, can ${verb}.`,
  }
}

/**
 * May this session mark this trade complete or declined?
 *
 * Party-or-admin, then **once**: re-completing would move the same two cards a
 * second time — silent, wrong, and exactly the accident the refusal exists to
 * prevent — and re-declining would rewrite the audit stamp of a decision somebody
 * else already made. Who is checked before what state the trade is in, matching the
 * server, so a stranger is told who can act rather than what has happened.
 */
export function tradeResolveAccess(
  user: Pick<SessionUser, 'id' | 'role'>,
  trade: Pick<TradeRecord, 'status' | 'resolvedBy' | 'resolvedAt'>,
  sides: TradeSides,
): TradeAccess {
  const party = tradeProposeAccess(user, sides, 'complete or decline it')
  if (!party.allowed) return party

  if (trade.status !== 'pending') {
    const who = trade.resolvedBy ?? 'someone whose account has since been deleted'
    return {
      allowed: false,
      refusal: 'alreadyResolved',
      message: `Already marked ${trade.status} by ${who}. A trade is resolved once.`,
    }
  }

  return ALLOWED
}

export type TradeUndoRefusal = 'notAdmin' | 'notComplete'

export type TradeUndoAccess =
  | { allowed: true }
  | { allowed: false; refusal: TradeUndoRefusal; message: string }

const UNDO_ALLOWED: TradeUndoAccess = { allowed: true }

/**
 * May this session undo this trade?
 *
 * **Admin only — no party exception**, unlike `tradeResolveAccess`. Undo reopens a
 * trade that already closed rather than making the first decision about an open
 * one, so it is not one more thing either party gets to do; it is granted only to
 * the account that can already reassign a base's ownership or overwrite its counts
 * outright. Mirrors the server's `mayUndoTrade`; this only stops the UI offering a
 * button the server would refuse.
 */
export function tradeUndoAccess(
  user: Pick<SessionUser, 'role'>,
  trade: Pick<TradeRecord, 'status' | 'undoneBy' | 'undoneAt'>,
): TradeUndoAccess {
  if (user.role !== 'admin') {
    return {
      allowed: false,
      refusal: 'notAdmin',
      message: 'Undoing a trade is admin-only. Ask an admin if this one needs to be reversed.',
    }
  }

  if (trade.status === 'undone') {
    const who = trade.undoneBy ?? 'someone whose account has since been deleted'
    return {
      allowed: false,
      refusal: 'notComplete',
      message: `Already undone by ${who}. A trade can be undone once.`,
    }
  }

  if (trade.status !== 'complete') {
    return {
      allowed: false,
      refusal: 'notComplete',
      message:
        trade.status === 'pending'
          ? 'This trade is still pending — there is nothing to undo yet.'
          : 'This trade was declined, so nothing moved and there is nothing to undo.',
    }
  }

  return UNDO_ALLOWED
}

/* ---------- what order, and which rows ---------- */

/**
 * Pending first, then resolved newest-first.
 *
 * Pending is the only status anybody has to act on, so it leads however old it is;
 * within it, **oldest first**, because a swap that has been waiting three days is
 * the one being forgotten. Resolved rows are history and read newest-first, which is
 * the order you want when checking whether something just went through. The id
 * breaks every remaining tie — two trades proposed in the same second must not swap
 * places between polls.
 */
export function sortTrades(trades: readonly TradeRecord[]): TradeRecord[] {
  const pendingFirst = (status: TradeStatus) => (status === 'pending' ? 0 : 1)

  return [...trades].sort((a, b) => {
    const byStatus = pendingFirst(a.status) - pendingFirst(b.status)
    if (byStatus !== 0) return byStatus

    if (a.status === 'pending') {
      return a.proposedAt.localeCompare(b.proposedAt) || a.id - b.id
    }

    // An undone trade keeps its original `resolvedAt` (undo is a third event, not a
    // rewrite of the second — see `TradeRecord.undoneAt`), so it sorts by *that*
    // stamp here rather than by when it was undone unless `undoneAt` is read first.
    const resolved = (trade: TradeRecord) => trade.undoneAt ?? trade.resolvedAt ?? trade.proposedAt
    return resolved(b).localeCompare(resolved(a)) || b.id - a.id
  })
}

/**
 * The trades one base is a side of.
 *
 * Filtered on the **tag**, not on the owner: the player page's panel is about that
 * base, and a base can change hands while its trades stand.
 */
export function tradesInvolving(trades: readonly TradeRecord[], tag: string): TradeRecord[] {
  return trades.filter((trade) => trade.baseA === tag || trade.baseB === tag)
}

/** How many still need somebody to act — the number the panel's heading carries. */
export function pendingCount(trades: readonly TradeRecord[]): number {
  return trades.filter((trade) => trade.status === 'pending').length
}

/**
 * The DOM id `TrackerTable` gives a trade's row, so a control elsewhere on the page
 * — `ProposeButton`'s "On the tracker" link — can look it up by `document.getElementById`
 * rather than a second copy of this string template drifting from the one the row
 * itself uses.
 */
export function tradeRowId(id: number): string {
  return `trade-row-${id}`
}

/**
 * The pending row for this exact swap, if the tracker already holds one.
 *
 * The same four columns the server's partial unique index is on, so "already
 * proposed" means the same thing on both sides. It answers two questions with one
 * comparison: it recovers the existing row after a 409, and it is what lets a
 * suggestion's Propose button read `On the tracker` before anything is clicked.
 *
 * **Both inputs must be oriented** — smaller tag as `baseA`, its card with it. Every
 * producer here already is: `suggestTrades` orients its output, the server orients
 * what it stores, and a proposal is built from a suggestion. So this compares rather
 * than re-orienting, which would quietly paper over an unoriented row.
 */
export function findPendingSwap(
  trades: readonly TradeRecord[],
  swap: Pick<TradeRecord, 'baseA' | 'baseB' | 'cardFromA' | 'cardFromB'>,
): TradeRecord | undefined {
  return trades.find(
    (trade) =>
      trade.status === 'pending' &&
      trade.baseA === swap.baseA &&
      trade.baseB === swap.baseB &&
      trade.cardFromA === swap.cardFromA &&
      trade.cardFromB === swap.cardFromB,
  )
}
