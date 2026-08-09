/**
 * "Propose a change" — any signed-in user can ask for something about the app to
 * be different; an admin resolves the request, later, with a reason. Modeled on
 * the Trade Tracker (`trade-types.ts`): one member-initiated stored row, an audit
 * trail of who/when, and resolution as a separate, later event rather than an
 * edit of the original — never inline in a route, see `server/src/change-requests/access.ts`.
 *
 * Three ways a request can move after submission, and they are **independent of
 * each other** — a request can be both canceled and resolved, in either order:
 *
 * - **Amend**: append-only. The original `subject`/`body` are never edited in
 *   place; more text is added as a dated {@link ChangeRequestAmendment}, the same
 *   shape as an event trail rather than a second editable field. Locked once the
 *   request is canceled or resolved — `mayAmendChangeRequest` in
 *   `server/src/change-requests/access.ts` says why that is a deliberate choice
 *   and not the only one available, mirroring how a resolved `TradeRecord`'s
 *   original proposal never changes once `resolvedAt` is set.
 * - **Cancel**: the requester's own withdrawal. One-way — there is no uncancel —
 *   unlike hide below, which is explicitly reversible because there is no reason
 *   to make *that* a one-way door. The row is never deleted or hidden from the
 *   admin table; it stays, marked canceled.
 * - **Hide**: a personal, reversible display preference on the requester's own
 *   "My requests" list only. It never affects the admin table, which always shows
 *   every request regardless of what any requester has hidden.
 *
 * No image upload yet — explicitly out of scope — but the shape does not assume
 * "exactly one text blob and nothing else": a future attachment is a nullable
 * column addable by a plain `ALTER TABLE`, and an optional field on
 * {@link SubmitChangeRequest} that every existing caller can ignore. Nothing here
 * needed to change to leave that door open.
 */

/**
 * Server-enforced max on the subject line — validated in
 * `server/src/change-requests/routes.ts`, not just an HTML `maxlength`, the same
 * way every other write in this app is bounded at its API boundary
 * (`server/src/cards/trade-routes.ts`, `server/src/http.ts`).
 */
export const CHANGE_REQUEST_SUBJECT_MAX = 255

/**
 * Server-enforced max on the body, and on each amendment — the same bound for
 * both, so there is one number to reason about rather than two.
 *
 * No existing free-text field in this codebase caps length server-side (checked:
 * no `maxLength`/length-cap pattern in `server/src/`), so this is a fresh choice
 * rather than a match to an established one. 4,000 characters is roughly a page
 * of prose — comfortably more than a considered change request needs, including
 * a few paragraphs of context — while being small enough that a pasted-in log
 * file or config dump is refused with a clear 400 rather than landing in the
 * table and growing every backup for good. An unbounded text column is the kind
 * of thing that looks fine until someone, accidentally or not, pastes something
 * huge into it.
 */
export const CHANGE_REQUEST_BODY_MAX = 4000

/**
 * The three admin resolutions. A closed union, like `TradeStatus`, so the reader
 * of a resolved request and the writer of one cannot drift apart on what the
 * options even are.
 */
export type ChangeRequestResolutionType = 'asDesigned' | 'outOfScope' | 'commit'

export const CHANGE_REQUEST_RESOLUTION_TYPES: readonly ChangeRequestResolutionType[] = [
  'asDesigned',
  'outOfScope',
  'commit',
]

/** One appended note on a request. Never edited or removed once written. */
export interface ChangeRequestAmendment {
  id: number
  body: string
  createdAt: string
  /** Always the request's own author today — see `mayAmendChangeRequest`. */
  createdByUserId: number | null
  /** Display name of whoever added it; `null` if that account is gone. */
  createdBy: string | null
}

/**
 * The admin's answer, once given. `null` on the request until then.
 *
 * The commit fields exist only for `type: 'commit'`, and only ever arrive from
 * the client as plain data: **the server has no git history at runtime** to
 * check a hash against (`web/src/changelog.ts`'s own doc comment is explicit
 * that a build with no git still has to work), so the admin picks a commit off
 * the What's New list already loaded in the browser and these are recorded for
 * display, exactly as `TradeRecord.category` is "not enforced" for the same
 * reason in `trade-types.ts`.
 */
export interface ChangeRequestResolution {
  type: ChangeRequestResolutionType
  /** Optional even on a one-click resolve — every type accepts one or none. */
  note: string | null
  commitHash: string | null
  commitSubject: string | null
  resolvedByUserId: number | null
  resolvedBy: string | null
  resolvedAt: string
}

export interface ChangeRequest {
  id: number
  subject: string
  body: string
  requestedByUserId: number | null
  /** Display name of the requester; `null` if that account is gone. */
  requestedBy: string | null
  requestedAt: string
  /** In the order they were added. `[]` for a request nobody has amended. */
  amendments: ChangeRequestAmendment[]
  /**
   * `null` unless the requester has withdrawn it. One-way: there is no route
   * that clears this once set — see the module doc comment on why cancel and
   * hide are treated differently.
   */
  canceledAt: string | null
  /**
   * `null` until an admin resolves it. Independent of `canceledAt` — an admin
   * may resolve an already-canceled request (harmless bookkeeping: e.g. tagging
   * it "outside of scope" for the record) and may resolve one more than once to
   * correct or update the reason, since resolving here only records an answer
   * rather than moving real data the way completing a `TradeRecord` does — see
   * `mayResolveChangeRequest`.
   */
  resolution: ChangeRequestResolution | null
  /**
   * Personal to the requester's own list; the admin table ignores this entirely
   * and always shows every request. Reversible.
   */
  hiddenAt: string | null
}

export interface ChangeRequestsResponse {
  requests: ChangeRequest[]
}

export interface ChangeRequestResponse {
  request: ChangeRequest
}

/**
 * `GET /api/admin/change-requests/pending-count` — the account-menu badge's
 * only read. "Pending" here is exactly `changeRequestStatus`'s `'open'` in
 * `web/src/change-request-rules.ts`: neither canceled nor resolved. A
 * dedicated endpoint rather than the client counting `allChangeRequests`
 * itself, so an admin session pays for one integer to render a badge instead
 * of fetching and holding every request just to learn how many are open.
 */
export interface ChangeRequestPendingCountResponse {
  count: number
}

/**
 * `GET /api/change-requests/unseen-resolved-count` — the other half of the
 * account-menu badge: how many of *this* caller's own requests were resolved
 * since they last visited `#/change-requests`. Unlike
 * {@link ChangeRequestPendingCountResponse}, this one has a way to clear it —
 * {@link MarkChangeRequestsViewedResponse} — because "resolved since I looked"
 * needs a "when did I look" to compare against, where "open" needs nothing but
 * the rows themselves.
 */
export interface ChangeRequestUnseenResolvedCountResponse {
  count: number
}

/** `POST /api/change-requests/mark-viewed` — records "now" as the caller's last visit. */
export interface MarkChangeRequestsViewedResponse {
  ok: true
}

/** What `POST /api/change-requests` accepts. The requester and the time are the server's. */
export interface SubmitChangeRequest {
  subject: string
  body: string
}

/** What `POST /api/change-requests/:id/amend` accepts. */
export interface AmendChangeRequest {
  body: string
}

/** What `POST /api/change-requests/:id/hide` accepts. */
export interface HideChangeRequest {
  hidden: boolean
}

/**
 * What `POST /api/admin/change-requests/:id/resolve` accepts. `commitHash` and
 * `commitSubject` are required by the route only when `type` is `'commit'` —
 * see the doc comment on {@link ChangeRequestResolution}.
 */
export interface ResolveChangeRequest {
  type: ChangeRequestResolutionType
  note?: string
  commitHash?: string
  commitSubject?: string
}
