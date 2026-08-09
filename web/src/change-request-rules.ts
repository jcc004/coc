import type { ChangeRequest, SessionUser } from '@coc/shared'

/**
 * The rules behind "Propose a change": who may amend, cancel or hide a request
 * on the "My requests" list, what a request's display status is, and what
 * order the two lists read in.
 *
 * Here rather than inline in `ChangeRequestsView.tsx`, the same reasoning
 * `trade-tracker.ts` gives for its own split from `TradeTracker.tsx`: offering
 * an Amend button on a row the server will refuse is a lie told at the moment
 * of clicking, and these are the two facts (who, and in what order) a
 * screenshot would not catch either way wrong.
 *
 * `changeRequestAmendAccess`/`changeRequestCancelAccess`/`changeRequestHideAccess`
 * mirror `server/src/change-requests/access.ts` — the server remains the
 * enforcement, this only stops the UI offering what will be refused. There is
 * no client-side mirror of `mayResolveChangeRequest`: unlike a row's Amend or
 * Cancel button, which sits on the shared "My requests" list everybody sees,
 * the admin resolution table only ever renders for an admin at all (the same
 * page-level gate `AdminView.tsx` uses), so there is no row on a member's
 * screen that could offer a Resolve button in the first place.
 */

/* ---------- display status ---------- */

export type ChangeRequestDisplayStatus = 'open' | 'canceled' | 'resolved' | 'resolvedCanceled'

/**
 * Cancel and resolve are independent columns on the wire (`ChangeRequest`
 * doc comment), so a request can be both at once — this is the one place that
 * cross-product is named, for a badge to read off.
 */
export function changeRequestStatus(
  request: Pick<ChangeRequest, 'canceledAt' | 'resolution'>,
): ChangeRequestDisplayStatus {
  if (request.canceledAt && request.resolution) return 'resolvedCanceled'
  if (request.resolution) return 'resolved'
  if (request.canceledAt) return 'canceled'
  return 'open'
}

/* ---------- who may act, on the requester's own list ---------- */

export type ChangeRequestRefusal = 'notAuthor' | 'closed'

export type ChangeRequestAccess =
  | { allowed: true }
  | { allowed: false; refusal: ChangeRequestRefusal; message: string }

const ALLOWED: ChangeRequestAccess = { allowed: true }

function isAuthor(user: Pick<SessionUser, 'id'>, request: Pick<ChangeRequest, 'requestedByUserId'>): boolean {
  return request.requestedByUserId !== null && request.requestedByUserId === user.id
}

/**
 * May this session add an amendment to this request?
 *
 * Author only, and locked once the request is closed (canceled or resolved) —
 * mirrors `mayAmendChangeRequest`'s deliberate choice, documented there: a
 * closed request is a closed record, the same way a resolved `TradeRecord`
 * never changes once `resolvedAt` is set.
 */
export function changeRequestAmendAccess(
  user: Pick<SessionUser, 'id'>,
  request: Pick<ChangeRequest, 'requestedByUserId' | 'canceledAt' | 'resolution'>,
): ChangeRequestAccess {
  if (!isAuthor(user, request)) {
    return {
      allowed: false,
      refusal: 'notAuthor',
      message: 'Only the person who submitted this request can add to it.',
    }
  }
  if (request.canceledAt || request.resolution) {
    return {
      allowed: false,
      refusal: 'closed',
      message: 'This request is closed, so it can no longer be amended.',
    }
  }
  return ALLOWED
}

/** May this session cancel this request? Author only, allowed at any time. */
export function changeRequestCancelAccess(
  user: Pick<SessionUser, 'id'>,
  request: Pick<ChangeRequest, 'requestedByUserId'>,
): ChangeRequestAccess {
  if (!isAuthor(user, request)) {
    return {
      allowed: false,
      refusal: 'notAuthor',
      message: 'Only the person who submitted this request can cancel it.',
    }
  }
  return ALLOWED
}

/** May this session hide or unhide this request? Author only, allowed at any time. */
export function changeRequestHideAccess(
  user: Pick<SessionUser, 'id'>,
  request: Pick<ChangeRequest, 'requestedByUserId'>,
): ChangeRequestAccess {
  if (!isAuthor(user, request)) {
    return {
      allowed: false,
      refusal: 'notAuthor',
      message: 'Only the person who submitted this request can hide it from their own list.',
    }
  }
  return ALLOWED
}

/* ---------- order, and which rows ---------- */

/**
 * Open first — oldest first, because a request that has waited longest is the
 * one being forgotten, the same reasoning `sortTrades` gives for pending
 * trades. Closed requests (canceled, resolved, or both) follow, newest first
 * by whichever closing event was last, so a request just resolved or just
 * canceled surfaces near the top of that group rather than by its original
 * submission date. The id breaks every remaining tie.
 */
export function sortChangeRequests(requests: readonly ChangeRequest[]): ChangeRequest[] {
  const isOpen = (request: ChangeRequest) =>
    request.canceledAt === null && request.resolution === null

  return [...requests].sort((a, b) => {
    const byOpen = Number(isOpen(b)) - Number(isOpen(a))
    if (byOpen !== 0) return byOpen

    if (isOpen(a)) {
      return a.requestedAt.localeCompare(b.requestedAt) || a.id - b.id
    }

    const closedAt = (request: ChangeRequest) => {
      const stamps = [request.canceledAt, request.resolution?.resolvedAt ?? null].filter(
        (stamp): stamp is string => stamp !== null,
      )
      return stamps.length > 0 ? stamps.sort().at(-1)! : request.requestedAt
    }
    return closedAt(b).localeCompare(closedAt(a)) || b.id - a.id
  })
}

/** The requester's own list, with anything hidden filtered out unless asked to show it. */
export function visibleChangeRequests(
  requests: readonly ChangeRequest[],
  showHidden: boolean,
): ChangeRequest[] {
  return showHidden ? [...requests] : requests.filter((request) => request.hiddenAt === null)
}

export function hiddenChangeRequestCount(requests: readonly ChangeRequest[]): number {
  return requests.filter((request) => request.hiddenAt !== null).length
}
