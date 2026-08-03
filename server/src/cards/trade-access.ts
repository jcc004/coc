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
 * in a mutual agreement, so the authorisation for those two writes is the *trade
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
 * complete or declined"), so one rule can answer two questions without either
 * caller inventing its own wording.
 */
function partyDecision(actor: BaseWriter, sides: TradeSides, verb: string): TradeActionDecision {
  if (actor.disabled) {
    return {
      allowed: false,
      refusal: 'accountDisabled',
      message: `Your account has been disabled, so it cannot ${verb}.`,
    }
  }

  if (isParty(actor, sides)) return ALLOWED
  if (actor.role === 'admin') return ALLOWED

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
