import type { UserRole } from '@coc/shared'

/**
 * The four answers "Propose a change" needs — submit, amend, cancel, hide,
 * resolve — as pure functions with their own tests, the same discipline this
 * repo's `mayWriteBaseCounts` and `trade-access.ts` already follow: this repo's
 * `CLAUDE.md` calls that "the only interesting authorization decision in the
 * app" for card counts, and treats the trade rules the same way. A route here
 * decides nothing on its own.
 *
 * The actors are the request's own **author**, any **admin**, and everybody
 * else. Three of the five questions have the same shape as `mayWriteBaseCounts`
 * — the owning account or an admin, nobody else — but there is no "admin
 * override" on amend/cancel/hide the way there is for a base's card counts.
 * Those three are span personal to the requester: an admin cannot amend, cancel
 * or hide *another account's* request on their behalf, because none of them
 * write shared data the way completing a trade or assigning an owner does —
 * they are the requester's own record of their own ask, and the admin's tool
 * for a request they disagree with is `mayResolveChangeRequest`, not a stand-in
 * for the author.
 *
 * Resolving is the mirror image: **admin only, no author exception at all** — a
 * request's author never resolves their own request, because "resolved" is an
 * answer from the app's side, not a state either party to a request may declare.
 * Trade actions are not the useful comparison here that they once were: propose,
 * resolve *and* undo are all party-or-admin in `trade-access.ts` now, so nothing
 * left there is admin-only-with-no-exception the way this is.
 */

/** Just enough of the caller's session to decide. Same shape as `BaseWriter`. */
export interface ChangeRequestActor {
  id: number
  role: UserRole
  /** Optional for the reason `BaseWriter.disabled` is: a session user is never
   *  disabled in practice, since a session is revoked the moment the account is.
   *  This is defense in depth, not the enforcement. */
  disabled?: boolean
}

/**
 * Just enough of a stored request to decide who may act on it.
 *
 * `resolution` is shaped like `ChangeRequest.resolution` (present or `null`)
 * rather than a flat `resolvedAt`, on purpose: passing the real stored request
 * straight through has to type-check, and a flat field here would silently
 * always read `undefined` against the nested shape the wire type actually
 * has — which is exactly the bug a narrower, hand-shaped test fixture would
 * not have caught, and did not, until the route was driven end to end.
 */
export interface OwnedChangeRequest {
  requestedByUserId: number | null
  canceledAt?: string | null
  resolution?: { resolvedAt: string } | null
}

export type ChangeRequestRefusal = 'accountDisabled' | 'notAuthor' | 'closed' | 'notAdmin'

export type ChangeRequestDecision =
  | { allowed: true }
  | { allowed: false; refusal: ChangeRequestRefusal; message: string }

const ALLOWED: ChangeRequestDecision = { allowed: true }

function disabledRefusal(verb: string): ChangeRequestDecision {
  return {
    allowed: false,
    refusal: 'accountDisabled',
    message: `Your account has been disabled, so it cannot ${verb}.`,
  }
}

/** True when this account is the request's own author. Ids only — never a name. */
function isAuthor(actor: ChangeRequestActor, request: OwnedChangeRequest): boolean {
  return request.requestedByUserId !== null && request.requestedByUserId === actor.id
}

/** Any signed-in, non-disabled account. Everyone reaches this page — see `docs/proposed-changes.md`. */
export function maySubmitChangeRequest(actor: ChangeRequestActor): ChangeRequestDecision {
  if (actor.disabled) return disabledRefusal('submit a request')
  return ALLOWED
}

/**
 * May this session add an amendment to this request?
 *
 * **Author only — no admin exception.** An amendment is the requester adding to
 * their own ask, not a shared record an admin has a stake in changing.
 *
 * **Locked once the request is canceled or resolved.** This is a judgment call
 * this feature's spec left open, and the choice made here is *no*: once a
 * request is closed either way it is a closed record, matching how this app
 * already treats a resolved `TradeRecord` — nothing about the original
 * proposal changes once `resolvedAt` is set, only a separate `undo` event can
 * happen afterwards, and that is admin-only. Amending a closed request would
 * let a requester keep talking to a conversation the app has already recorded
 * an answer to, with nothing forcing the admin to notice the new text.
 */
export function mayAmendChangeRequest(
  actor: ChangeRequestActor,
  request: OwnedChangeRequest,
): ChangeRequestDecision {
  if (actor.disabled) return disabledRefusal('amend a request')
  if (!isAuthor(actor, request)) {
    return {
      allowed: false,
      refusal: 'notAuthor',
      message: 'Only the person who submitted a request can add to it.',
    }
  }
  if (request.canceledAt || request.resolution) {
    return {
      allowed: false,
      refusal: 'closed',
      message:
        'This request is closed (canceled or resolved), so it can no longer be amended. ' +
        'Submit a new request if there is more to say.',
    }
  }
  return ALLOWED
}

/**
 * May this session cancel this request?
 *
 * **Author only, and allowed at any time** — whatever the request's current
 * cancel or resolution state. Canceling an already-canceled request is a
 * harmless no-op rather than a refusal (there is nothing to protect by
 * refusing it a second time, unlike a trade's guarded status change, which
 * exists to stop the same cards moving twice). Canceling a resolved request is
 * allowed too, for the same "at any time" reason hiding is: it is the
 * requester's own bookkeeping and has no effect on the resolution beside it.
 */
export function mayCancelChangeRequest(
  actor: ChangeRequestActor,
  request: OwnedChangeRequest,
): ChangeRequestDecision {
  if (actor.disabled) return disabledRefusal('cancel a request')
  if (!isAuthor(actor, request)) {
    return {
      allowed: false,
      refusal: 'notAuthor',
      message: 'Only the person who submitted a request can cancel it.',
    }
  }
  return ALLOWED
}

/**
 * May this session hide or unhide this request on their own "My requests" list?
 *
 * **Author only, and always allowed** — hide is a personal, reversible display
 * preference with no effect on anything else, so unlike amend there is no
 * "closed" restriction: there is no reason to lock a toggle that changes
 * nothing but what one person's own list shows them.
 */
export function mayHideChangeRequest(
  actor: ChangeRequestActor,
  request: OwnedChangeRequest,
): ChangeRequestDecision {
  if (actor.disabled) return disabledRefusal('hide a request')
  if (!isAuthor(actor, request)) {
    return {
      allowed: false,
      refusal: 'notAuthor',
      message: 'Only the person who submitted a request can hide it from their own list.',
    }
  }
  return ALLOWED
}

/**
 * May this session resolve (or re-resolve) a request?
 *
 * **Admin only, no author exception, whatever the request's cancel state** —
 * "resolved" is the app's own answer to a request, not something either side
 * of a negotiation declares, so there is no party symmetry to preserve the way
 * `mayResolveTrade` preserves one between two owners.
 *
 * **Deliberately not single-shot**, unlike `mayResolveTrade`. Completing a
 * trade moves real card counts, so resolving it twice would move them twice —
 * the refusal exists to stop a real-world effect from happening again.
 * Resolving a change request has no effect beyond recording an answer, so
 * letting an admin resolve one a second time — to correct a note, or change
 * "outside of scope" to "tied to commit `abc123`" once that commit ships — is
 * pure bookkeeping with nothing to protect by refusing it. The spec's own
 * wording ("an admin can resolve any request at any time") is read literally
 * here rather than narrowed to "the first time".
 */
export function mayResolveChangeRequest(actor: ChangeRequestActor): ChangeRequestDecision {
  if (actor.disabled) return disabledRefusal('resolve a request')
  if (actor.role !== 'admin') {
    return {
      allowed: false,
      refusal: 'notAdmin',
      message: 'Resolving a request is admin-only.',
    }
  }
  return ALLOWED
}
