import type { TradeStatus } from '@coc/shared'
import type { BaseOwnership, BaseWriter } from './write-access.ts'

/**
 * The one answer to "may this user propose this trade" and "may this user resolve
 * it" — a pure function per question, in one file, with its own tests, for the
 * same reason `mayWriteBaseCounts` is next door.
 *
 * A trade is **mutual**, which makes its rule different from the per-base write:
 *
 * - **Card counts** belong to the base's owner. One base, one decision.
 * - **A trade** belongs to *both* bases. Either owner may propose it and either
 *   owner may resolve it, because a swap is not something one side does to the
 *   other. That is the user's rule verbatim: "either party to the trade (owner)
 *   can mark it as complete or declined."
 *
 * The consequence worth saying out loud: **completing a trade writes to two
 * bases, one of which the resolver very likely does not own.** That is inherent
 * in a mutual agreement, so the authorization for those two writes is the *trade
 * record*, not the per-base owner rule — see the comment on
 * `TradeStore.complete`. This module is where that is decided, deliberately, once.
 *
 * An **admin** may propose and resolve anything, for the reason they may write any
 * base's counts: they can reassign ownership to themselves in one request, so
 * refusing them would stop nothing and remove their only way to clear up a mess.
 *
 * A base whose assignment is only a **legacy text label** grants nobody
 * anything, exactly as in `write-access.ts`. The label is a note about a person,
 * not a permission held by a session, so such a trade is an admin's to resolve
 * until an admin links the base to an account.
 *
 * A fourth function, `mayUndoTrade`, answers a different question: not who may act
 * on an *open* trade, but who may reopen a *closed* one. It is the same
 * party-or-admin shape as proposing and resolving — reopening a completed swap is
 * no longer treated as a special case reserved for admins alone — see its own doc
 * comment for the reasoning and for what stayed the same regardless (the
 * confirmation dialog, and the once-only-while-complete rule).
 */

/** Both sides of a trade, as the owner column reports them. */
export interface TradeSides {
  baseA: BaseOwnership
  baseB: BaseOwnership
}

/** Just enough of a stored trade to say whether it is still open. */
export interface ResolvableTrade {
  status: TradeStatus
  /** Display name of whoever resolved it, for the refusal message. */
  resolvedBy?: string | null
  resolvedAt?: string | null
}

export type TradeActionRefusal = 'accountDisabled' | 'notAParty' | 'alreadyResolved'

export type TradeActionDecision =
  | { allowed: true }
  | { allowed: false; refusal: TradeActionRefusal; message: string }

const ALLOWED: TradeActionDecision = { allowed: true }

/** `#TAG (Jared)`, or `#TAG (no linked owner)` when nobody's account holds it. */
function describeSide(side: BaseOwnership): string {
  if (side.ownerUserId !== null) return `${side.tag} (${side.ownerLabel ?? 'its owner'})`
  if (side.ownerLabel !== null) return `${side.tag} (${side.ownerLabel}, not linked to an account)`
  return `${side.tag} (no linked owner)`
}

/** True when this account owns one of the two bases. Ids only — labels never. */
function isParty(actor: BaseWriter, sides: TradeSides): boolean {
  return (
    (sides.baseA.ownerUserId !== null && sides.baseA.ownerUserId === actor.id) ||
    (sides.baseB.ownerUserId !== null && sides.baseB.ownerUserId === actor.id)
  )
}

/**
 * The shared part: a disabled account does nothing, a party or an admin may act,
 * and anyone else is refused with a message that **names who can** — "belongs to
 * Jared or Sam" is actionable, "forbidden" is a wall.
 *
 * `verb` is the phrase for the refusal ("propose this trade" / "mark this trade
 * complete or declined" / "undo this trade"), so one rule can answer three
 * questions without any caller inventing its own wording.
 *
 * Its own refusal set — `'accountDisabled' | 'notAParty'` — is narrower than any
 * one caller's own decision type. `alreadyResolved` (propose/resolve) and
 * `notComplete` (undo) both depend on the trade's *status*, which this function
 * never looks at; each caller adds its own status check afterward, once this one
 * has passed. That narrower type is what lets `mayUndoTrade` return this result
 * directly even though its own refusal type doesn't include `alreadyResolved` at
 * all — a narrower literal union is structurally assignable to any wider union
 * that is a superset of it, so this compiles with no cast in either caller.
 */
function partyDecision(
  actor: BaseWriter,
  sides: TradeSides,
  verb: string,
): { allowed: true } | { allowed: false; refusal: 'accountDisabled' | 'notAParty'; message: string } {
  if (actor.disabled) {
    return {
      allowed: false,
      refusal: 'accountDisabled',
      message: `Your account has been disabled, so it cannot ${verb}.`,
    }
  }

  if (isParty(actor, sides)) return { allowed: true }
  if (actor.role === 'admin') return { allowed: true }

  return {
    allowed: false,
    refusal: 'notAParty',
    message: `This trade is between ${describeSide(sides.baseA)} and ${describeSide(
      sides.baseB,
    )}. Only the owner of either base, or an admin, can ${verb}.`,
  }
}

/**
 * Proposing. Owning one of the two bases is enough — a swap is worth recording as
 * soon as one side means it — but owning neither is not: a member inventing
 * trades between two other people's bases is putting words in their mouths, and
 * the other party would have to decline something they never discussed.
 */
export function mayProposeTrade(actor: BaseWriter, sides: TradeSides): TradeActionDecision {
  return partyDecision(actor, sides, 'propose this trade')
}

/**
 * Resolving — completing or declining.
 *
 * Who is checked before what state the trade is in. The state is public (every
 * signed-in caller can list trades), so nothing leaks either way, and "here is
 * who may act on this" is the more useful of the two refusals to a stranger.
 *
 * A trade is resolved **once**. Re-completing one would move the same two cards a
 * second time, which is silent, wrong, and exactly the accident this refusal
 * exists to prevent; re-declining is harmless but would rewrite the audit stamp of
 * a decision somebody else already made.
 */
export function mayResolveTrade(
  actor: BaseWriter,
  trade: ResolvableTrade,
  sides: TradeSides,
): TradeActionDecision {
  const party = partyDecision(actor, sides, 'mark this trade complete or declined')
  if (!party.allowed) return party

  if (trade.status !== 'pending') {
    const who = trade.resolvedBy ?? 'someone whose account has since been deleted'
    const when = trade.resolvedAt ? ` on ${trade.resolvedAt}` : ''
    return {
      allowed: false,
      refusal: 'alreadyResolved',
      message: `This trade was already marked ${trade.status} by ${who}${when}. It cannot be resolved twice.`,
    }
  }

  return ALLOWED
}

/** Just enough of a stored trade to say whether it can be undone. */
export interface UndoableTrade {
  status: TradeStatus
  /** Display name of whoever already undid it, for the refusal message. */
  undoneBy?: string | null
  undoneAt?: string | null
}

export type TradeUndoRefusal = 'accountDisabled' | 'notAParty' | 'notComplete'

export type TradeUndoDecision =
  | { allowed: true }
  | { allowed: false; refusal: TradeUndoRefusal; message: string }

const UNDO_ALLOWED: TradeUndoDecision = { allowed: true }

/**
 * May this session undo this trade?
 *
 * **Party-or-admin, the same shape as proposing and resolving.** This used to be
 * admin-only with no party exception at all, on the reasoning that undo reopens a
 * record that already closed rather than making the first decision about an open
 * one, so it was not one more step either side of a mutual agreement got to take
 * unilaterally. That restriction is lifted here, on purpose: an owner of either
 * base may now undo a trade they are a party to, exactly as they may complete or
 * decline it. An admin keeps the ability to undo *any* trade regardless of
 * ownership, for the same reason `partyDecision` grants an admin everything below
 * it — refusing them would stop nothing and remove the only way to fix a trade
 * neither current party can reach (an unlinked legacy label, a deleted account).
 *
 * What did **not** change, because neither follows from *who* is asking: undo is
 * still allowed only while the trade is `complete` (checked below), and it is
 * still once-only — a trade already `undone` cannot be undone again. A party
 * undoing their own trade can still get the state wrong or fire twice by mistake,
 * the same as a stranger could have. The confirmation dialog before this ever
 * reaches the server (`web/src/components/TradeTracker.tsx`'s `undoTrade`) is
 * independent of this function too, and also did not change — it is now the one
 * action left on a trade that still asks, now that completing no longer does.
 *
 * Who is checked before what state the trade is in, matching `mayResolveTrade`:
 * the state is public to every signed-in reader, so nothing leaks either way, and
 * "here is who may act on this" is the more useful refusal to hand a stranger than
 * a status they could not act on regardless.
 */
export function mayUndoTrade(
  actor: BaseWriter,
  trade: UndoableTrade,
  sides: TradeSides,
): TradeUndoDecision {
  const party = partyDecision(actor, sides, 'undo this trade')
  if (!party.allowed) return party

  if (trade.status === 'undone') {
    const who = trade.undoneBy ?? 'someone whose account has since been deleted'
    const when = trade.undoneAt ? ` on ${trade.undoneAt}` : ''
    return {
      allowed: false,
      refusal: 'notComplete',
      message: `This trade was already undone by ${who}${when}. It cannot be undone twice.`,
    }
  }

  if (trade.status !== 'complete') {
    return {
      allowed: false,
      refusal: 'notComplete',
      message:
        trade.status === 'pending'
          ? 'This trade is still pending, so there is nothing to undo yet.'
          : 'This trade was declined, so nothing moved and there is nothing to undo.',
    }
  }

  return UNDO_ALLOWED
}

/**
 * One swap, before it is stored, in whichever order the client sent it.
 *
 * Orienting by tag — smaller tag first, its card with it — is what makes the same
 * swap one row rather than two mirror images, and matches `suggestTrades`, whose
 * output is oriented the same way for the same reason. It is here rather than in
 * the store because it is a rule about what a trade *is*, and it is the thing that
 * makes the "one pending proposal per swap" index meaningful: without it, A→B and
 * B→A would be two different rows describing one agreement.
 */
export interface UnorientedTrade {
  baseA: string
  baseB: string
  cardFromA: number
  cardFromB: number
}

export function orientTrade<T extends UnorientedTrade>(trade: T): T {
  if (trade.baseA <= trade.baseB) return trade
  return {
    ...trade,
    baseA: trade.baseB,
    baseB: trade.baseA,
    cardFromA: trade.cardFromB,
    cardFromB: trade.cardFromA,
  }
}
