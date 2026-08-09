import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import {
  CHANGE_REQUEST_BODY_MAX,
  CHANGE_REQUEST_RESOLUTION_TYPES,
  CHANGE_REQUEST_SUBJECT_MAX,
  type ChangeRequest,
  type ChangeRequestResolutionType,
  type SessionUser,
} from '@coc/shared'
import { api, describe } from '../api.ts'
import {
  useAllChangeRequests,
  useMyChangeRequests,
  type AllChangeRequests,
  type MyChangeRequests,
} from '../change-requests.ts'
import {
  changeRequestAmendAccess,
  changeRequestCancelAccess,
  changeRequestHideAccess,
  changeRequestStatus,
  hiddenChangeRequestCount,
  sortChangeRequests,
  visibleChangeRequests,
  type ChangeRequestDisplayStatus,
} from '../change-request-rules.ts'
import { type Change, loadChanges, whatsNewHref } from '../changelog.ts'
import { formatDateTime, formatRelative, formatShortDate, summarize } from '../format.ts'
import { useAsync } from '../hooks.ts'
import { ChangeRequestRules } from './help-copy.tsx'
import { ErrorPanel, HelpLink, Loading } from './primitives.tsx'

/**
 * `#/change-requests` — "Propose a change": any signed-in user can ask for
 * something about the app to be different, and an admin resolves the request
 * later, with a reason.
 *
 * **One page, one route, for everyone — not role-gated the way `#/admin` is.**
 * Everybody, admins included, gets the submit form and their own "My requests"
 * list; an admin additionally sees every account's requests, in a resolution
 * table below their own section, on the same page. That is a genuinely
 * different shape from `AdminView.tsx`, which refuses a member outright
 * (`NotAnAdmin`) — there is no refused state here, because there is nothing on
 * this page that is not also a member's.
 *
 * Mirrors the Trade Tracker's split throughout: `change-request-rules.ts` holds
 * the pure "who may act" and "what order" logic (mirroring the server's
 * `access.ts`, tested on both sides), and this file only draws what it is
 * given.
 *
 * **Landing here clears the account-menu badge.** Any signed-in caller with a
 * request resolved since their last visit sees a count on the silhouette in
 * the topbar (`UserMenu.tsx`); mounting this view marks that moment "now" via
 * `api.markChangeRequestsViewed()`, which is the whole of what "cleared by
 * going to the change request page" means server-side — see
 * `useUnseenResolvedChangeRequestCount` in `change-requests.ts`.
 */

const RESOLUTION_LABEL: Record<ChangeRequestResolutionType, string> = {
  asDesigned: 'As designed',
  outOfScope: 'Outside of project scope',
  commit: 'Tied to a commit',
}

const STATUS_LABEL: Record<ChangeRequestDisplayStatus, string> = {
  open: 'Open',
  canceled: 'Canceled',
  resolved: 'Resolved',
  resolvedCanceled: 'Resolved · Canceled',
}

/** Absolute in the tooltip, relative on screen, as everywhere else in this app. */
function Stamp({ at }: { at: string }) {
  const when = new Date(at)
  return (
    <time dateTime={at} title={when.toLocaleString()}>
      {formatRelative(when)}
    </time>
  )
}

/** `open` / `canceled` / `resolved` / both, on the same fixed-badge shape `trade-status` uses. */
function StatusBadge({ status }: { status: ChangeRequestDisplayStatus }) {
  return <span className={`request-status request-status--${status}`}>{STATUS_LABEL[status]}</span>
}

/**
 * A request's own description, summarized to a character count by default
 * with a toggle to read the rest — the admin table's own version of this
 * (`AdminRequestRow`'s `card-meta` cell reflows normally, no preserved line
 * breaks, so a character count is a fair stand-in for "how long does this
 * look"). A body can run up to `CHANGE_REQUEST_BODY_MAX` (4000) characters;
 * shown in full by default, one long request pushed everything below it off
 * the screen and the table it sits in unreadable — reported 2026-08-08.
 *
 * **Not what "My requests" uses** — see `ClampedBody` below for why a
 * character count is the wrong measure there specifically.
 *
 * `SUMMARY_LENGTH` is a plain constant rather than something measured off a
 * reference the way the card badge's dimensions were: there is no real-world
 * screen to match here, only "short enough to scan a table of these, long
 * enough that the summary is still worth reading on its own" — a judgment
 * call, not a measurement.
 */
const SUMMARY_LENGTH = 200

function ExpandableBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const needsToggle = text.length > SUMMARY_LENGTH

  if (!needsToggle) return <>{text}</>

  return (
    <>
      {expanded ? text : summarize(text, SUMMARY_LENGTH)}{' '}
      <button
        type="button"
        className="request-body-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((was) => !was)}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </>
  )
}

const CLAMPED_LINES = 4

/**
 * The same "read a summary, expand for the rest" shape as `ExpandableBody`
 * above, for "My requests" (`RequestEntry`) specifically — but measured in
 * *lines*, not characters, because `.changelog__body` keeps the author's own
 * line breaks (`white-space: pre-wrap`, borrowed from the changelog display
 * this styling is shared with). A short body typed as several short lines
 * can already be visually tall even though its character count is nowhere
 * near `ExpandableBody`'s threshold — `ExpandableBody` cannot see that at
 * all, since it only ever counts characters. Reported 2026-08-08, right
 * after `ExpandableBody` shipped for the *other* table: "the my requests
 * table shows the whole description no matter what."
 *
 * There is no way to know from the string alone whether it will actually
 * take more than {@link CLAMPED_LINES} lines once rendered — that depends on
 * the box's own width and the font, which is exactly what CSS `line-clamp`
 * already knows how to do without reimplementing line-breaking in JS. What
 * JS *is* needed for is knowing whether the clamp actually did anything, so
 * the toggle button only appears when there is truly more to show — the same
 * `ResizeObserver`-on-a-callback-ref shape `useMeasuredWidth` (`hooks.ts`)
 * already uses elsewhere on this page, so a width change (a phone rotated, a
 * window resized) that changes whether the same text still needs clamping
 * re-checks itself rather than getting stuck on whatever was true at mount.
 */
function ClampedBody({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const [element, setElement] = useState<HTMLParagraphElement | null>(null)

  useEffect(() => {
    if (!element) return

    const measure = () => {
      // Once expanded, the clamp class is off the element and there is
      // nothing left to measure — and nothing should un-set `clamped`
      // either, or the toggle would vanish out from under an open view.
      if (expanded) return
      setClamped(element.scrollHeight > element.clientHeight + 1)
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, expanded, text])

  return (
    <>
      <p
        ref={setElement}
        className={[className, expanded ? null : 'request-body--clamped'].filter(Boolean).join(' ')}
        style={expanded ? undefined : ({ '--clamp-lines': CLAMPED_LINES } as CSSProperties)}
      >
        {text}
      </p>
      {clamped ? (
        <button
          type="button"
          className="request-body-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((was) => !was)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  )
}

/**
 * The resolution, once there is one: what it was, who decided, when, and why.
 *
 * Shared between "My requests" (`RequestEntry`) and the admin's "Every request"
 * table (`AdminRequestRow`'s rendering inside `AdminChangeRequestsCard`) — one
 * component drawing the same data both places, so a commit link fixed here is
 * fixed in both without a special case for either.
 */
function ResolutionSummary({ resolution }: { resolution: NonNullable<ChangeRequest['resolution']> }) {
  return (
    <p className="empty-hint request-resolution">
      <strong>{RESOLUTION_LABEL[resolution.type]}</strong>
      {resolution.type === 'commit' && resolution.commitHash ? (
        <>
          {' — '}
          {/* Links into the entry's own spot on What's New — `changeEntryId` in
              `changelog.ts` is what `WhatsNewView` scrolls to on arrival. */}
          <a href={whatsNewHref(resolution.commitHash)}>
            <code>{resolution.commitHash}</code> {resolution.commitSubject}
          </a>
        </>
      ) : null}
      {' · '}
      {resolution.resolvedBy ?? 'a deleted account'} <Stamp at={resolution.resolvedAt} />
      {resolution.note ? (
        <>
          <br />
          {resolution.note}
        </>
      ) : null}
    </p>
  )
}

/* ---------- submitting ---------- */

function SubmitCard({ onSubmit }: { onSubmit: MyChangeRequests['submit'] }) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setProblem(null)
    try {
      await onSubmit({ subject: subject.trim(), body: body.trim() })
      setSubject('')
      setBody('')
    } catch (cause) {
      setProblem(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h1 className="section-title">
        Propose a change{' '}
        <HelpLink section="change-requests" topic="amending, canceling, hiding, and how resolving works" />
      </h1>
      <p className="empty-hint">
        Ask for something about this app to be different. An admin resolves every request over
        time — as designed, outside of scope, or tied to a commit that already addressed it — with
        an optional note either way. Nothing you submit changes anything by itself.
      </p>

      <form className="progress-form" onSubmit={(event) => void submit(event)}>
        <label className="progress-form__field">
          <span className="progress-form__label">
            Subject ({subject.length}/{CHANGE_REQUEST_SUBJECT_MAX})
          </span>
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={CHANGE_REQUEST_SUBJECT_MAX}
            placeholder="One line — what should change"
            aria-label="Subject"
            autoComplete="off"
          />
        </label>
        <label className="progress-form__field">
          <span className="progress-form__label">
            Description ({body.length}/{CHANGE_REQUEST_BODY_MAX})
          </span>
          <textarea
            className="progress-form__notes"
            rows={5}
            value={body}
            maxLength={CHANGE_REQUEST_BODY_MAX}
            onChange={(event) => setBody(event.target.value)}
            placeholder="What you'd like changed, and why"
            aria-label="Description"
          />
        </label>
        <button type="submit" disabled={busy || !subject.trim() || !body.trim()}>
          {busy ? 'Submitting…' : 'Submit'}
        </button>
        {problem ? <p className="notice__hint">{problem}</p> : null}
      </form>
    </section>
  )
}

/* ---------- one request, as the requester sees it ---------- */

function AmendForm({
  request,
  onAmend,
}: {
  request: ChangeRequest
  onAmend: MyChangeRequests['amend']
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!open) {
    return (
      <button type="button" className="icon-button" onClick={() => setOpen(true)}>
        Add an amendment
      </button>
    )
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await onAmend(request.id, text.trim())
      setText('')
      setOpen(false)
    } catch (cause) {
      setProblem(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="row-edit" onSubmit={(event) => void submit(event)}>
      <textarea
        className="progress-form__notes"
        rows={3}
        value={text}
        maxLength={CHANGE_REQUEST_BODY_MAX}
        onChange={(event) => setText(event.target.value)}
        placeholder="More to add"
        aria-label={`Amendment for ${request.subject}`}
        autoFocus
      />
      <button type="submit" className="icon-button" disabled={busy || !text.trim()}>
        {busy ? 'Adding…' : 'Add'}
      </button>
      <button type="button" className="icon-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </form>
  )
}

function RequestActions({
  user,
  request,
  onAmend,
  onCancel,
  onSetHidden,
}: {
  user: Pick<SessionUser, 'id'>
  request: ChangeRequest
  onAmend: MyChangeRequests['amend']
  onCancel: MyChangeRequests['cancel']
  onSetHidden: MyChangeRequests['setHidden']
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<'cancel' | 'hide' | null>(null)

  const amendAccess = changeRequestAmendAccess(user, request)
  const cancelAccess = changeRequestCancelAccess(user, request)
  const hideAccess = changeRequestHideAccess(user, request)

  async function cancel(): Promise<void> {
    if (!window.confirm('Cancel this request? It stays visible, marked canceled — nothing is deleted.')) {
      return
    }
    setBusy('cancel')
    setProblem(null)
    try {
      await onCancel(request.id)
    } catch (cause) {
      setProblem(describe(cause))
    } finally {
      setBusy(null)
    }
  }

  async function toggleHidden(): Promise<void> {
    setBusy('hide')
    setProblem(null)
    try {
      await onSetHidden(request.id, request.hiddenAt === null)
    } catch (cause) {
      setProblem(describe(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="row-actions">
      {amendAccess.allowed ? <AmendForm request={request} onAmend={onAmend} /> : null}
      {cancelAccess.allowed && request.canceledAt === null ? (
        <button type="button" className="icon-button" disabled={busy !== null} onClick={() => void cancel()}>
          {busy === 'cancel' ? 'Canceling…' : 'Cancel'}
        </button>
      ) : null}
      {hideAccess.allowed ? (
        <button type="button" className="icon-button" disabled={busy !== null} onClick={() => void toggleHidden()}>
          {busy === 'hide' ? 'Working…' : request.hiddenAt === null ? 'Hide' : 'Unhide'}
        </button>
      ) : null}
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </div>
  )
}

function RequestEntry({
  user,
  request,
  onAmend,
  onCancel,
  onSetHidden,
}: {
  user: Pick<SessionUser, 'id'>
  request: ChangeRequest
  onAmend: MyChangeRequests['amend']
  onCancel: MyChangeRequests['cancel']
  onSetHidden: MyChangeRequests['setHidden']
}) {
  const status = changeRequestStatus(request)

  return (
    <li className="changelog__entry">
      <p className="changelog__when">
        <Stamp at={request.requestedAt} />
      </p>
      <h2 className="changelog__subject">
        {request.subject} <StatusBadge status={status} />
      </h2>
      <ClampedBody text={request.body} className="changelog__body" />
      {request.amendments.map((amendment) => (
        <p key={amendment.id} className="changelog__body request-amendment">
          <span className="card-meta">
            Added <Stamp at={amendment.createdAt} />
          </span>
          <br />
          {amendment.body}
        </p>
      ))}
      {request.resolution ? <ResolutionSummary resolution={request.resolution} /> : null}
      <RequestActions
        user={user}
        request={request}
        onAmend={onAmend}
        onCancel={onCancel}
        onSetHidden={onSetHidden}
      />
    </li>
  )
}

function MyRequestsCard({ user, mine }: { user: SessionUser; mine: MyChangeRequests }) {
  const [showHidden, setShowHidden] = useState(false)
  const hiddenCount = hiddenChangeRequestCount(mine.requests)
  const rows = sortChangeRequests(visibleChangeRequests(mine.requests, showHidden))

  return (
    <section className="card">
      <h2 className="section-title">My requests</h2>

      {mine.status === 'loading' && mine.requests.length === 0 ? (
        <Loading what="your requests" />
      ) : null}
      {mine.status === 'error' && mine.requests.length === 0 && mine.error ? (
        <ErrorPanel error={mine.error} />
      ) : null}

      {mine.status !== 'loading' && mine.requests.length === 0 ? (
        <p className="empty-hint">Nothing submitted yet — the form above is where that starts.</p>
      ) : null}

      {rows.length > 0 ? (
        <ol className="changelog">
          {rows.map((request) => (
            <RequestEntry
              key={request.id}
              user={user}
              request={request}
              onAmend={mine.amend}
              onCancel={mine.cancel}
              onSetHidden={mine.setHidden}
            />
          ))}
        </ol>
      ) : null}

      {hiddenCount > 0 ? (
        <button type="button" className="icon-button" onClick={() => setShowHidden((was) => !was)}>
          {showHidden
            ? 'Hide the hidden requests again'
            : `Show ${hiddenCount} hidden request${hiddenCount === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </section>
  )
}

/* ---------- admin: resolving every request ---------- */

/**
 * A commit picked off the What's New list already loaded in the browser, sent
 * to the server as plain data. The server has no git history at runtime to
 * check a hash against — see `changelog.ts`'s own doc comment — so this is
 * recorded for display, exactly as `TradeRecord.category` is not enforced,
 * for the same reason.
 */
function CommitPicker({
  changes,
  value,
  onChange,
}: {
  changes: Change[]
  value: string
  onChange: (commit: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Commit this resolution ties to"
    >
      <option value="">Choose a commit from What's New…</option>
      {changes.map((change) => (
        <option key={change.commit} value={change.commit}>
          {change.commit} — {change.subject}
        </option>
      ))}
    </select>
  )
}

function ResolveForm({
  request,
  changes,
  onResolve,
}: {
  request: ChangeRequest
  changes: Change[]
  onResolve: AllChangeRequests['resolve']
}) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ChangeRequestResolutionType>('asDesigned')
  const [note, setNote] = useState('')
  const [commit, setCommit] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!open) {
    return (
      <button type="button" className="icon-button" onClick={() => setOpen(true)}>
        {request.resolution ? 'Update resolution' : 'Resolve'}
      </button>
    )
  }

  const chosenChange = changes.find((change) => change.commit === commit)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    if (type === 'commit' && !chosenChange) {
      setProblem('Choose which commit this ties to.')
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      await onResolve(request.id, {
        type,
        note: note.trim() ? note.trim() : undefined,
        commitHash: chosenChange?.commit,
        commitSubject: chosenChange?.subject,
      })
      setOpen(false)
      setNote('')
      setCommit('')
    } catch (cause) {
      setProblem(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="row-edit" onSubmit={(event) => void submit(event)}>
      <select
        value={type}
        onChange={(event) => setType(event.target.value as ChangeRequestResolutionType)}
        aria-label={`Resolution for ${request.subject}`}
      >
        {CHANGE_REQUEST_RESOLUTION_TYPES.map((option) => (
          <option key={option} value={option}>
            {RESOLUTION_LABEL[option]}
          </option>
        ))}
      </select>
      {type === 'commit' ? (
        <CommitPicker changes={changes} value={commit} onChange={setCommit} />
      ) : null}
      <textarea
        className="progress-form__notes"
        rows={2}
        value={note}
        maxLength={CHANGE_REQUEST_BODY_MAX}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Optional note"
        aria-label="Optional note"
      />
      <button type="submit" className="icon-button" disabled={busy}>
        {busy ? 'Saving…' : 'Save resolution'}
      </button>
      <button type="button" className="icon-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </form>
  )
}

function AdminChangeRequestsCard({ all }: { all: AllChangeRequests }) {
  /*
   * Loaded once, lazily — the same async shape `WhatsNewView` uses for the same
   * chunk. A build with no git history answers with an empty list rather than
   * throwing, so `Choose a commit…` simply offers nothing rather than the page
   * failing to render.
   */
  const changesState = useAsync(() => loadChanges(), [])
  const changes = changesState.status === 'ready' ? changesState.data : []

  const rows = sortChangeRequests(all.requests)

  return (
    <section className="card">
      <h2 className="section-title">Every request</h2>
      <p className="empty-hint">
        Every account's requests, regardless of what any requester has hidden from their own list.
      </p>

      {all.status === 'loading' && all.requests.length === 0 ? (
        <Loading what="every request" />
      ) : null}
      {all.status === 'error' && all.requests.length === 0 && all.error ? (
        <ErrorPanel error={all.error} />
      ) : null}

      {all.status !== 'loading' && rows.length === 0 ? (
        <p className="empty-hint">Nothing submitted yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <div className="table-wrap">
          <table className="roster roster--stack roster--divided" role="table" aria-label="Every change request">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader">Requested by</th>
                <th role="columnheader">Requested</th>
                <th role="columnheader">Subject</th>
                <th role="columnheader">Resolution</th>
                <th role="columnheader" />
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.map((request) => (
                <tr key={request.id} role="row">
                  <td className="stack-title" role="cell">
                    {request.requestedBy ?? 'a deleted account'}
                  </td>
                  <td role="cell" data-label="Requested">
                    {/* Short date on screen, the full date and time in the tooltip —
                        same split `Stamp` above makes for relative time, just with
                        the short/full roles swapped: this column is a date to scan
                        down, not a "how long ago", so the exact moment is what's one
                        hover away instead. */}
                    <time
                      dateTime={request.requestedAt}
                      title={formatDateTime(new Date(request.requestedAt))}
                    >
                      {formatShortDate(new Date(request.requestedAt))}
                    </time>
                  </td>
                  <td role="cell" data-label="Subject">
                    <span className="request-subject">{request.subject}</span>{' '}
                    <StatusBadge status={changeRequestStatus(request)} />
                    <br />
                    <span className="card-meta">
                      <ExpandableBody text={request.body} />
                    </span>
                  </td>
                  <td role="cell" data-label="Resolution">
                    {request.resolution ? (
                      <ResolutionSummary resolution={request.resolution} />
                    ) : (
                      <span className="empty-hint">Not resolved yet</span>
                    )}
                  </td>
                  <td className="row-actions" role="cell" data-label="Actions">
                    <ResolveForm request={request} changes={changes} onResolve={all.resolve} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

/* ---------- the page ---------- */

export function ChangeRequestsView({ user }: { user: SessionUser }) {
  const mine = useMyChangeRequests()
  // Only fetched at all while an admin has this page open — see `useAllChangeRequests`.
  const isAdmin = user.role === 'admin'

  /*
   * "Cleared by them going to the change request page" — a one-shot,
   * best-effort call the moment this component mounts, not tied to whether
   * `mine` has actually loaded yet. A failure here just leaves the badge
   * showing a stale count until the next successful visit; it must never
   * block or degrade the page itself, the same reasoning the polling hooks in
   * `change-requests.ts` give for swallowing a failed poll.
   */
  useEffect(() => {
    api.markChangeRequestsViewed().catch(() => {})
  }, [])

  /*
   * Bumped after every successful submission and handed down to `AdminSection`
   * as `refreshKey`, so an admin's own new request — patched straight into
   * `mine` locally, never touching the admin list's own state — still shows
   * up in the table below without a manual reload. See `useAllChangeRequests`'
   * own doc comment for why the two lists don't already agree on their own.
   */
  const [submitCount, setSubmitCount] = useState(0)

  const mineSubmit = mine.submit
  const submit = useCallback(
    async (input: Parameters<typeof mineSubmit>[0]) => {
      const request = await mineSubmit(input)
      setSubmitCount((count) => count + 1)
      return request
    },
    [mineSubmit],
  )

  return (
    <>
      <SubmitCard onSubmit={submit} />
      <MyRequestsCard user={user} mine={mine} />

      {/* Rendered whatever state the list is in, sharing `ChangeRequestRules` with
          the help page — the same "disclosure survives an empty list" reasoning
          `TradeTracker.tsx` gives for its own rules block. */}
      <details className="group">
        <summary>Amending, canceling, hiding, and how resolving works</summary>
        <div className="group__body help-prose">
          <ChangeRequestRules />
        </div>
      </details>

      {isAdmin ? (
        <AdminSection refreshKey={submitCount} onResolved={mine.patch} />
      ) : null}
    </>
  )
}

/**
 * Split out so `useAllChangeRequests` is only ever called while `isAdmin` is
 * true — hooks cannot be called conditionally, so the fetch-on-mount has to
 * live in a component that itself only mounts for an admin, rather than in a
 * branch inside `ChangeRequestsView`.
 *
 * `onResolved` is `mine.patch` from the parent — called after a successful
 * resolve so an admin resolving one of *their own* requests updates "My
 * requests" too, not just this table's own state. See `MyChangeRequests.patch`'s
 * doc comment for the full reasoning; this is the other half of it.
 */
function AdminSection({
  refreshKey,
  onResolved,
}: {
  refreshKey: number
  onResolved: (request: ChangeRequest) => void
}) {
  const all = useAllChangeRequests(refreshKey)

  const allResolve = all.resolve
  const resolve = useCallback(
    async (id: number, input: Parameters<typeof allResolve>[1]) => {
      const request = await allResolve(id, input)
      onResolved(request)
      return request
    },
    [allResolve, onResolved],
  )

  return <AdminChangeRequestsCard all={{ ...all, resolve }} />
}
