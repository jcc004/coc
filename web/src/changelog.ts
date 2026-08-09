/**
 * The commits behind the running build: what `#/whats-new` lists, and how they got
 * into the bundle.
 *
 * **The browser cannot read git**, so the list is baked in at build time by
 * `vite.config.ts` exactly as `BUILD_INFO` is — see the note there for why the
 * build describes itself rather than asking the server. This module owns both ends
 * of that pipe: `parseGitLog` runs in the config, on `git log` output, and
 * `readChanges` runs in the browser, on the JSON the config wrote. Keeping the pair
 * in one tested file is the point. A parser in an untested config file and a reader
 * in a tested component would be two halves of one format that nothing checks
 * agree, and the failure they produce — a page of blank rows — looks like there is
 * simply nothing to show.
 *
 * **The timestamp is the committer date, and that is a decision.** The request was
 * for the merge date. There are no merge commits here and there never have been:
 * the droplet fast-forwards (`git merge --ff-only`, `deploy/update.sh`) and work
 * lands directly on `main`, so every commit is linear and carries an *author* date
 * and a *committer* date instead. The committer date is the honest answer, because
 * it is the moment the change became the thing on `main` that the next timer run
 * deploys. An author date can predate that by days across a rebase or an amend, and
 * a "what's new" page dated by when somebody started writing something would put an
 * entry below one that reached the site before it. It is also the same field the
 * footer's own stamp uses (`%cI`, `vite.config.ts`), so the newest entry here and
 * the "Updated …" line that links to it cannot disagree.
 *
 * **Not every commit belongs on it.** A commit is listed only if it changed a file
 * in one of the three npm workspaces — `shared/`, `server/`, `web/`. That is the
 * whole rule: no curated list to fall out of date, no keyword in a subject line for
 * somebody to forget. Everything it drops (docs, `deploy/`, CI workflows) changed
 * nothing about the app the reader is looking at, which is what the page claims to
 * describe; 24 of the first 81 commits here are that. The rule is anchored to the
 * workspaces because those are declared in `package.json` and named in
 * `docs/layout.md`, so it is not a private notion of "app code".
 *
 * **One deliberate exception**: a commit whose body carries a `No-Changelog` line
 * (see `skipsChangelog`) is dropped even though it touched app code. This exists for
 * the commit that touches a workspace but changes nothing a reader would recognize
 * as a feature — fixing bytes nobody could see wrong, an internal rename with
 * identical behavior. The bar is deliberately narrow ("would a member reading this
 * page learn anything true about what changed for them") and the marker deliberately
 * opt-in and rare, so this stays the one hand-typed exception to an otherwise
 * automatic rule rather than the start of a second rule nobody maintains.
 *
 * **A build with no git still has to work.** Every field degrades to an empty
 * string, the same way `BUILD_INFO` does, and every function here answers with an
 * empty list rather than throwing: a tarball deploy, a shallow clone or an image
 * without git gets a page that says it has no history, not a blank screen.
 *
 * **The payload itself is not in this module**, and that is deliberate — it lives
 * alone in `changelog-data.ts` so Rollup can give it a chunk of its own. The reason
 * is measured and is written down there.
 */

import { parseStamp } from './build-info.ts'

/** One commit, as the page shows it. */
export interface Change {
  /** Short hash. Not displayed; it is the entry's identity. */
  commit: string
  /** Committer date, ISO 8601. See the note above on why not the author date. */
  date: string
  /** The message's first line. Always non-empty. */
  subject: string
  /** Everything after it, verbatim and unreflowed. Empty for a one-line message. */
  body: string
}

/* ---------- the wire format ---------- */

/*
 * ASCII record and unit separators, which is what they are for. A commit body here
 * runs to twenty lines of prose containing blank lines, bullets, indented blocks and
 * every punctuation mark on the keyboard, so any printable delimiter is a delimiter
 * somebody will eventually type. These two are the only bytes git will never emit
 * from `%s` or `%b`.
 */
export const RECORD_SEPARATOR = '\u001e'
export const FIELD_SEPARATOR = '\u001f'

/**
 * The `git log --format` string, kept beside the parser that reads it.
 *
 * The record separator **leads** each record rather than terminating it, and that is
 * load-bearing: `--name-only` prints the changed paths *after* the formatted record,
 * so a trailing separator would leave the file list stranded outside any record. With
 * it in front, every record is `hash ␟ date ␟ subject ␟ body ␟ <paths>`, and the paths
 * are simply the fifth field. Splitting the body out from the paths any other way is
 * impossible, because a body contains newlines and blank lines of its own.
 */
export const GIT_LOG_FORMAT =
  `${RECORD_SEPARATOR}%h${FIELD_SEPARATOR}%cI${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${FIELD_SEPARATOR}`

/** The whole command, so the config cannot get the arguments subtly wrong. */
export const GIT_LOG_ARGS: readonly string[] = [
  'log',
  `--format=${GIT_LOG_FORMAT}`,
  '--name-only',
]

/** The workspaces whose files are the app. A commit touching none of them is not listed. */
export const APP_WORKSPACES: readonly string[] = ['shared/', 'server/', 'web/']

/** How many fields a well-formed record has: hash, date, subject, body, paths. */
const RECORD_FIELDS = 5

/**
 * Whether a commit changed anything that runs in front of the reader.
 *
 * Exported because it is the filter rule and the rule is the interesting part; the
 * page's honesty about what it omits rests on this being one line that nobody has to
 * maintain.
 */
export function touchesTheApp(paths: readonly string[]): boolean {
  return paths.some((path) => APP_WORKSPACES.some((workspace) => path.startsWith(workspace)))
}

/**
 * A commit body line reading `No-Changelog`, on its own line, case-insensitive,
 * with an optional `: reason` trailing it — the one hand-typed opt-out from an
 * otherwise fully automatic rule. Checked against the raw body, before
 * {@link trimBody} runs, so leading/trailing blank lines cannot hide it or
 * change its position.
 *
 * A trailer rather than a subject-line keyword on purpose: `git.md` already
 * asks for a subject that reads as the change's cause, not a tag — folding a
 * skip marker into it would be the same mistake a `[skip-ci]`-style prefix
 * makes elsewhere, one more thing competing with the sentence for the reader's
 * attention. It sits in the body instead, where nobody but this parser reads
 * it.
 */
export function skipsChangelog(body: string): boolean {
  return /^no-changelog\b/im.test(body)
}

/**
 * The listed commits, newest first, from the output of `git log` run with
 * `GIT_LOG_ARGS`.
 *
 * Forgiving throughout. An empty string — git missing, no history, the command
 * refused — is an empty list, and so is any record that does not have all five
 * fields, a subject, or a date that is really a date. The alternative is a page of
 * rows reading "Invalid Date", which is the failure `build-info.ts` exists to
 * prevent in the footer and there is no reason to reintroduce here.
 *
 * The sort is explicit rather than inherited from git's output order. `git log`
 * happens to print newest first on a linear history, but "newest first" is what the
 * page promises, and a promise the code does not make is one a `--reverse` or a
 * grafted history could quietly break.
 */
export function parseGitLog(raw: string): Change[] {
  const changes: Change[] = []

  for (const record of raw.split(RECORD_SEPARATOR)) {
    if (record.trim() === '') continue

    const fields = record.split(FIELD_SEPARATOR)
    if (fields.length < RECORD_FIELDS) continue

    const commit = (fields[0] ?? '').trim()
    const date = (fields[1] ?? '').trim()
    const subject = (fields[2] ?? '').trim()
    if (commit === '' || subject === '' || parseStamp(date) === null) continue

    const paths = (fields[4] ?? '').split('\n').filter((path) => path.trim() !== '')
    if (!touchesTheApp(paths)) continue

    const rawBody = fields[3] ?? ''
    if (skipsChangelog(rawBody)) continue

    changes.push({ commit, date, subject, body: trimBody(rawBody) })
  }

  return sortNewestFirst(changes)
}

/**
 * The body with its surrounding blank lines removed and **nothing else touched**.
 *
 * Only the ends. The interior is left exactly as it was written, hard wraps and all,
 * because these bodies carry bullet lists with hanging indents and indented literal
 * blocks — a table of file paths against short hashes, a `git show` invocation — and
 * joining their lines to reflow them for a phone would turn both into a paragraph of
 * run-together fragments. The page renders this with `white-space: pre-wrap`, which
 * keeps the author's shape and still wraps at the container edge rather than
 * scrolling sideways.
 */
function trimBody(body: string): string {
  return body.replace(/^\s*\n/, '').replace(/\s+$/, '')
}

/** Newest first, by committer date. */
function sortNewestFirst(changes: Change[]): Change[] {
  return changes.sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
}

/* ---------- the browser end ---------- */

/**
 * The changes this bundle was compiled with, from the JSON `vite.config.ts` wrote.
 *
 * Guarded rather than trusted, for the same reason `parseStamp` exists: the value is
 * a string substituted into the source at build time, so a build that produced junk
 * — or none at all — must be a page that says it has nothing to show, never an
 * exception during render with no error boundary above it to catch it.
 */
export function readChanges(raw: string): Change[] {
  if (!raw) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const changes: Change[] = []
  for (const entry of parsed) {
    const change = asChange(entry)
    if (change !== null) changes.push(change)
  }
  return sortNewestFirst(changes)
}

/** One entry of the parsed JSON, if it is really one. */
function asChange(entry: unknown): Change | null {
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>

  const commit = record.commit
  const date = record.date
  const subject = record.subject
  const body = record.body

  if (typeof commit !== 'string' || commit === '') return null
  if (typeof subject !== 'string' || subject === '') return null
  if (typeof date !== 'string' || parseStamp(date) === null) return null

  return { commit, date, subject, body: typeof body === 'string' ? body : '' }
}

/**
 * The list, fetched and parsed at most once per page load.
 *
 * **Asynchronous because the payload is a chunk of its own**, which is the whole
 * reason `changelog-data.ts` exists as a separate module — see the note there. Held
 * in the main bundle it added 133KB to a 374KB download that this app re-issues on
 * every deploy, and it grows by every commit. Reached only through `import()`, it
 * costs nothing until somebody opens the page.
 *
 * The promise is cached so a second visit in the same session is free, but a
 * *failed* one is not: a deploy replacing `dist` under an already-open page is the
 * way this realistically fails, and that is worth retrying rather than remembering.
 * The rejection is left to propagate, so the view can say the list could not be
 * loaded instead of showing the same empty state a build with no git produces.
 */
let loaded: Promise<Change[]> | null = null

export function loadChanges(): Promise<Change[]> {
  loaded ??= import('./changelog-data.ts')
    .then((module) => readChanges(module.BUILD_CHANGES_JSON))
    .catch((cause: unknown) => {
      loaded = null
      throw cause
    })
  return loaded
}

/* ---------- routing ---------- */

/**
 * The element id one entry of the list renders as, keyed on its commit — the same
 * identity `key={change.commit}` already uses one level up in `WhatsNewView`. A
 * link built from {@link whatsNewHref} points at a route carrying this same
 * commit; `WhatsNewView` turns the route back into this id to find the element to
 * scroll to. Exported so the two ends — the id an entry renders and the id a
 * scroll goes looking for — cannot drift apart into two different naming schemes.
 */
export function changeEntryId(commit: string): string {
  return `change-${commit}`
}

/**
 * The commit a `#/whats-new/<param>` link is asking for, or `null` for the whole
 * page.
 *
 * The shape mirrors `helpSection` in `help.ts` — a route carrying an optional
 * path segment, `null` meaning "the whole page" — but not the method. A help
 * section is a closed enum this module can validate on the spot; a commit is
 * whichever ones happen to be in the build's own baked-in list, which is data
 * `loadChanges` has not necessarily fetched yet when `parseHash` runs. So this
 * does the only thing it safely can: hands back a trimmed, non-empty segment as
 * the commit. Whether that commit is actually one of the loaded entries is
 * `WhatsNewView`'s question to ask once the list has arrived — a commit that
 * turns out not to be there is a no-op scroll, not a route that refuses to open,
 * the same "missing is a no-op" rule `scrollAndFocus` (`card-sections.ts`)
 * already follows for exactly this reason.
 */
export function whatsNewCommit(param: string | null | undefined): string | null {
  if (!param) return null
  const trimmed = param.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The href for the What's New page, or for one entry of it.
 *
 * `hrefFor` in `hooks.ts` delegates to this exactly as it does to `helpHref`, so
 * the whole scheme — including the `null` case that must not leave a trailing
 * slash — is testable without pulling React in.
 */
export function whatsNewHref(commit: string | null): string {
  return commit === null ? '#/whats-new' : `#/whats-new/${encodeURIComponent(commit)}`
}
