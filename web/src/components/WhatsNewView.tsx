import { useEffect, useRef } from 'react'
import { parseStamp } from '../build-info.ts'
import { scrollAndFocus, scrollBehaviorFor } from '../card-sections.ts'
import { changeEntryId, loadChanges, type Change } from '../changelog.ts'
import { useAsync } from '../hooks.ts'
import { ErrorPanel, Loading } from './primitives.tsx'

/**
 * `#/whats-new` — every change to the app, newest first, with the date and time it
 * landed.
 *
 * Reached from the footer's "Updated …" stamp, which is the moment somebody wonders
 * what changed, and from the account menu, which is where somebody looks for it
 * without knowing the stamp is a link.
 *
 * **Nothing here decides anything.** The list arrives already parsed, filtered and
 * ordered from `changelog.ts` — that is where the committer-date choice, the
 * three-workspace filter and the newest-first sort live, with the tests. This file
 * is the framing and one formatting call.
 *
 * **The subject is the entry; the body is a disclosure.** Messages in this
 * repository run to twenty lines of reasoning, and eighty of those stacked is not a
 * page anybody reads. So the first line is always visible and the rest sits behind
 * `details.group`, the collapsed idiom this app already uses under the trade panels
 * and the raid weekends. The body is printed **verbatim**: hard wraps, bullets and
 * indented blocks are the author's, and `white-space: pre-wrap` keeps them while
 * still wrapping at the container edge instead of scrolling a phone sideways.
 *
 * **The paragraphs below carry no measure**, and that is the asked-for behavior rather
 * than an omission. They used to add `help-prose` — the help page's 68ch — which held
 * them to about 600px inside a panel that is the shell's full width, so the intro
 * stopped roughly halfway across the page and read as text that had been abandoned
 * there. Without it they set at the card, which at 1280px is around 140 characters to
 * the line. That is long by any typographic convention and it is the intended result:
 * the request was for the header to fill the width it has. Re-imposing a measure here,
 * whether `help-prose` or a new one, undoes it.
 *
 * **There is no "new since you last looked" badge**, deliberately. Most commits
 * change nothing a reader can see, so a dot on every deploy would be a signal that
 * is wrong more often than it is right, and it would need per-account last-seen
 * state to be wrong with.
 *
 * **The list is loaded, not imported.** It is still baked in at build time — there
 * is no request to the server — but it sits in a chunk of its own, so the 130KB of
 * commit messages is fetched when this page is opened and not by every session that
 * never opens it. `changelog-data.ts` says why that was worth doing. It is the
 * app's ordinary async shape from there: `useAsync`, `Loading`, `ErrorPanel`.
 *
 * **Scrolling to one entry is ours to do**, the same reason and the same shape as
 * `HelpView`'s own section scroll: the route carries the commit as a path segment
 * (`#/whats-new/<commit>`, `whatsNewCommit`/`whatsNewHref` in `changelog.ts`), the
 * hash is already the router, and a second `#` in it would not be a fragment the
 * browser acts on. The wrinkle `HelpView` does not have is that the target does
 * not exist until the list has actually loaded — `changeEntryId` names an id that
 * is only in the DOM once `state.status === 'ready'` — so the effect below waits
 * for that before it goes looking. A commit that is not in the loaded list at all
 * (aged out of the log, squashed away, or `No-Changelog`) is a no-op, not a throw:
 * `scrollAndFocus` (`card-sections.ts`) already answers that question.
 */

/*
 * Date *and* time, and the same fields the footer's stamp uses — the newest entry
 * here is that stamp, so the two reading differently would look like two different
 * facts. Seconds and the timezone stay in the tooltip.
 */
const STAMP_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}

export function WhatsNewView({ commit }: { commit: string | null }) {
  const state = useAsync(() => loadChanges(), [])

  /* Keyed by the commit, not by a boolean "have we scrolled yet", so the effect can
     tell "arrived at this entry" from an unrelated re-render — the same shape
     `HelpView`'s own `scrolled` ref uses for its section — without re-scrolling the
     page out from under somebody already reading it. */
  const scrolledTo = useRef<string | null>(null)

  useEffect(() => {
    if (commit === null || state.status !== 'ready' || scrolledTo.current === commit) return
    scrolledTo.current = commit

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scrollAndFocus(changeEntryId(commit), scrollBehaviorFor(reducedMotion))
  }, [commit, state.status])

  return (
    <>
      <section className="card">
        <h1 className="section-title">What's new</h1>
        <p className="empty-hint">
          Every change to this app, newest first. Each is dated by when it landed on{' '}
          <code>main</code>, which is the moment it became what the site deploys — the droplet
          fast-forwards to it every five minutes. Changes to the documentation, the deploy scripts
          and the CI workflows are not listed, because none of them altered anything you can see
          here.
        </p>
        <p className="empty-hint">
          The note under an entry is the message its author wrote at the time, printed as written.
          It explains why the change was made, which is usually the part worth having.
        </p>
      </section>

      <section className="card">
        {state.status === 'loading' || state.status === 'idle' ? (
          <Loading what="the list of changes" />
        ) : null}

        {/* Distinct from the empty list below, and that distinction is the reason the
            loader lets a rejection through: "the build has no history" and "the chunk
            would not load" are different facts, and one empty panel for both would
            hide a deploy that replaced `dist` under an open page. */}
        {state.status === 'error' ? <ErrorPanel error={state.error} /> : null}

        {state.status === 'ready' && state.data.length === 0 ? (
          /* Not an error. A build made from a tarball or a shallow clone has no
             history to bake in, and saying so is better than an empty panel that
             looks like it failed to load. */
          <p className="empty-hint">
            This build was made without its repository history, so there is nothing to list.
          </p>
        ) : null}

        {state.status === 'ready' && state.data.length > 0 ? (
          <ol className="changelog">
            {state.data.map((change) => (
              <ChangeEntry key={change.commit} change={change} />
            ))}
          </ol>
        ) : null}
      </section>
    </>
  )
}

/**
 * One change: when, what, and — behind a disclosure — why.
 *
 * The time comes first and is the quiet part, because the subjects are what somebody
 * scans down; a column of gold dates with the sentences subordinate to them would
 * make the page about the calendar.
 */
function ChangeEntry({ change }: { change: Change }) {
  /* Never null in practice — an entry with an unreadable date does not survive
     `readChanges` — but `parseStamp` is the guard that makes that true, so this is
     the one place it is worth honoring rather than asserting past. */
  const when = parseStamp(change.date)

  return (
    // `id` is what a resolution's link (`whatsNewHref`/`changeEntryId`) scrolls to;
    // `tabIndex={-1}` is what lets `scrollAndFocus` also move the caret here, the
    // same pairing `HelpView`'s section headings and `CardsView`'s jump targets use.
    <li className="changelog__entry" id={changeEntryId(change.commit)} tabIndex={-1}>
      <p className="changelog__when">
        <time dateTime={change.date} title={when?.toString()}>
          {when === null ? change.date : when.toLocaleString(undefined, STAMP_FORMAT)}
        </time>
      </p>
      <h2 className="changelog__subject">{change.subject}</h2>
      {change.body === '' ? null : (
        <details className="group changelog__more">
          <summary>Why</summary>
          <div className="group__body">
            <p className="changelog__body">{change.body}</p>
          </div>
        </details>
      )}
    </li>
  )
}
