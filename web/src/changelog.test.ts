import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  APP_WORKSPACES,
  changeEntryId,
  FIELD_SEPARATOR,
  GIT_LOG_ARGS,
  GIT_LOG_FORMAT,
  parseGitLog,
  readChanges,
  RECORD_SEPARATOR,
  skipsChangelog,
  touchesTheApp,
  whatsNewCommit,
  whatsNewHref,
  type Change,
} from './changelog.ts'

/**
 * Both ends of the pipe, in one file because they are one format.
 *
 * The build parses `git log`; the browser parses the JSON the build wrote. Nothing
 * on screen catches a disagreement between them — the page simply renders no rows,
 * which is indistinguishable from a repository with no history.
 */

const LATER = '2026-08-04T13:26:11-05:00'
const EARLIER = '2026-08-01T09:00:00-05:00'

interface RecordParts {
  commit?: string
  date?: string
  subject?: string
  body?: string
  paths?: readonly string[]
}

/** One record in exactly the shape `GIT_LOG_FORMAT` plus `--name-only` produces. */
function record({
  commit = 'de7dd8d',
  date = LATER,
  subject = 'Let the chosen banner win on a dev install',
  body = '',
  paths = ['web/src/App.tsx'],
}: RecordParts = {}): string {
  const fields = [commit, date, subject, body].join(FIELD_SEPARATOR)
  /* git prints the formatted record, then the paths on their own lines. The trailing
     field separator is the last thing the format emits, so the paths follow it. */
  return `${RECORD_SEPARATOR}${fields}${FIELD_SEPARATOR}\n\n${paths.join('\n')}\n`
}

describe('GIT_LOG_FORMAT', () => {
  it('leads each record with the separator, so the --name-only paths land in a field', () => {
    // Terminating instead would strand the paths after the last field, where nothing
    // could tell them apart from the tail of a body that has blank lines of its own.
    assert.ok(GIT_LOG_FORMAT.startsWith(RECORD_SEPARATOR))
    assert.ok(GIT_LOG_FORMAT.endsWith(FIELD_SEPARATOR))
  })

  it('delimits with the two ASCII control bytes a commit message cannot contain', () => {
    assert.equal(RECORD_SEPARATOR, '\u001e')
    assert.equal(FIELD_SEPARATOR, '\u001f')
  })

  it('asks git for the committer date, not the author date', () => {
    // The decision the whole page rests on: %cI is when the change landed on main and
    // so became deployable, and it is the field the footer's own stamp already uses.
    assert.ok(GIT_LOG_FORMAT.includes('%cI'))
    assert.ok(!GIT_LOG_FORMAT.includes('%aI'))
  })

  it('passes --name-only, which is what makes the filter possible at all', () => {
    assert.ok(GIT_LOG_ARGS.includes('--name-only'))
    assert.ok(GIT_LOG_ARGS.includes(`--format=${GIT_LOG_FORMAT}`))
  })
})

describe('touchesTheApp', () => {
  it('accepts a path in any of the three workspaces', () => {
    for (const workspace of APP_WORKSPACES) {
      assert.equal(touchesTheApp([`${workspace}src/thing.ts`]), true, workspace)
    }
  })

  it('refuses a commit that only moved documentation, deploy scripts or CI around', () => {
    assert.equal(
      touchesTheApp(['docs/ui.md', 'CLAUDE.md', 'deploy/update.sh', '.github/workflows/verify.yml']),
      false,
    )
  })

  it('accepts a commit that touched one app file among several that are not', () => {
    // The common shape here: a change plus the documentation that describes it.
    assert.equal(touchesTheApp(['docs/ui.md', 'web/src/styles.css']), true)
  })

  it('matches on the leading segment, so a workspace named inside a path does not count', () => {
    assert.equal(touchesTheApp(['docs/web/notes.md', 'notes/server/plan.md']), false)
  })

  it('refuses a commit that changed nothing at all', () => {
    assert.equal(touchesTheApp([]), false)
  })
})

describe('skipsChangelog', () => {
  it('recognizes the bare marker on its own line', () => {
    assert.equal(skipsChangelog('Fixed some invisible bytes.\n\nNo-Changelog'), true)
  })

  it('recognizes the marker with a trailing reason', () => {
    assert.equal(skipsChangelog('No-Changelog: nothing a reader would notice'), true)
  })

  it('is case-insensitive', () => {
    assert.equal(skipsChangelog('no-changelog'), true)
    assert.equal(skipsChangelog('NO-CHANGELOG: why'), true)
  })

  it('is false for an ordinary body, including one that just mentions changelogs', () => {
    assert.equal(skipsChangelog(''), false)
    assert.equal(skipsChangelog('Because the old behavior was wrong.'), false)
    assert.equal(skipsChangelog('Updated the changelog page styling.'), false)
  })

  it('only matches at the start of a line, not mid-sentence', () => {
    assert.equal(skipsChangelog('This is a No-Changelog kind of fix, sort of.'), false)
  })
})

describe('parseGitLog', () => {
  it('reads a record into its hash, date, subject and body', () => {
    const [change] = parseGitLog(record({ body: 'Because it was wrong.' }))
    assert.deepEqual(change, {
      commit: 'de7dd8d',
      date: LATER,
      subject: 'Let the chosen banner win on a dev install',
      body: 'Because it was wrong.',
    })
  })

  it('leaves a one-line message with an empty body rather than a placeholder', () => {
    assert.equal(parseGitLog(record())[0]?.body, '')
  })

  it('keeps a body verbatim: hard wraps, blank lines, bullets and indented blocks', () => {
    // These messages carry a table of paths against short hashes and hanging-indent
    // bullet lists. Reflowing them for a phone would run both together into prose,
    // so the page uses `white-space: pre-wrap` and the parser touches nothing.
    const body = [
      'The first paragraph, hard wrapped by hand at about eighty',
      'columns, as every message in this repository is.',
      '',
      '- a bullet whose continuation line is indented under it',
      '  and carries on here',
      '',
      '  web/src/App.tsx   9a2b550 -> 5e6c1b2',
    ].join('\n')
    assert.equal(parseGitLog(record({ body }))[0]?.body, body)
  })

  it('strips only the blank lines around a body, never anything inside it', () => {
    const body = '\n\nFirst line.\n\nLast line.\n\n  \n'
    assert.equal(parseGitLog(record({ body }))[0]?.body, 'First line.\n\nLast line.')
  })

  it('drops a commit that changed nothing in the three workspaces', () => {
    assert.deepEqual(parseGitLog(record({ paths: ['docs/ui.md', 'CLAUDE.md'] })), [])
  })

  it('drops a commit marked No-Changelog even though it touched app code', () => {
    const body = 'Replaced four invisible null bytes with spaces.\n\nNo-Changelog'
    assert.deepEqual(parseGitLog(record({ body, paths: ['web/src/progress-percent.ts'] })), [])
  })

  it('keeps an ordinary commit that merely mentions "changelog" in its body', () => {
    const body = 'Fixed the changelog page failing to load on a fresh clone.'
    assert.equal(parseGitLog(record({ body }))[0]?.body, body)
  })

  it('reads a whole log of several records', () => {
    const log = [
      record({ commit: 'aaaaaaa', date: LATER, subject: 'Newer' }),
      record({ commit: 'bbbbbbb', date: EARLIER, subject: 'Older' }),
    ].join('')
    assert.deepEqual(
      parseGitLog(log).map((change) => change.subject),
      ['Newer', 'Older'],
    )
  })

  it('orders newest first however git happened to print them', () => {
    // "Newest first" is what the page promises. git prints that way on a linear
    // history, but a promise the code does not make is one --reverse could break.
    const log = [
      record({ commit: 'bbbbbbb', date: EARLIER, subject: 'Older' }),
      record({ commit: 'aaaaaaa', date: LATER, subject: 'Newer' }),
    ].join('')
    assert.deepEqual(
      parseGitLog(log).map((change) => change.subject),
      ['Newer', 'Older'],
    )
  })

  it('answers with an empty list when the build had no git to ask', () => {
    // A tarball deploy, a shallow clone, an image without git: `gitValue` returns ''
    // for every one of them, exactly as it does for BUILD_INFO.
    for (const raw of ['', ' ', '\n']) {
      assert.deepEqual(parseGitLog(raw), [], JSON.stringify(raw))
    }
  })

  it('skips a record that is missing fields rather than inventing empty ones', () => {
    const truncated = `${RECORD_SEPARATOR}de7dd8d${FIELD_SEPARATOR}${LATER}\n`
    assert.deepEqual(parseGitLog(truncated), [])
  })

  it('skips a record whose date is not a date', () => {
    for (const date of ['', 'unknown', 'HEAD']) {
      assert.deepEqual(parseGitLog(record({ date })), [], date)
    }
  })

  it('skips a record with no subject, which would render as a blank row', () => {
    assert.deepEqual(parseGitLog(record({ subject: '   ' })), [])
  })

  it('never yields an entry the page could print as "Invalid Date"', () => {
    for (const date of ['', 'nope', 'HEAD', LATER]) {
      for (const change of parseGitLog(record({ date }))) {
        assert.ok(!Number.isNaN(Date.parse(change.date)), `got ${JSON.stringify(change.date)}`)
      }
    }
  })
})

describe('readChanges', () => {
  const written = (changes: readonly Change[]) => JSON.stringify(changes)

  it('reads back exactly what the build wrote', () => {
    const parsed = parseGitLog(record({ body: 'Two\nlines.' }))
    assert.deepEqual(readChanges(written(parsed)), parsed)
  })

  it('answers with an empty list for a build that baked in nothing', () => {
    assert.deepEqual(readChanges(''), [])
  })

  it('answers with an empty list rather than throwing on anything that is not JSON', () => {
    // There is no error boundary above this app, so a throw during render is the
    // whole page gone — the same reason `parseHash` swallows a bad percent-escape.
    for (const raw of ['{', 'undefined', '<!doctype html>']) {
      assert.deepEqual(readChanges(raw), [], raw)
    }
  })

  it('answers with an empty list for JSON that is not an array of entries', () => {
    for (const raw of ['null', '42', '"a string"', '{"commit":"de7dd8d"}']) {
      assert.deepEqual(readChanges(raw), [], raw)
    }
  })

  it('drops a malformed entry and keeps the sound ones beside it', () => {
    const raw = JSON.stringify([
      { commit: 'aaaaaaa', date: LATER, subject: 'Kept', body: '' },
      { commit: 'bbbbbbb', date: 'not a date', subject: 'Dropped', body: '' },
      { commit: 'ccccccc', subject: 'No date at all' },
      null,
      'a string',
      { commit: 'ddddddd', date: EARLIER, subject: 'Also kept', body: '' },
    ])
    assert.deepEqual(
      readChanges(raw).map((change) => change.subject),
      ['Kept', 'Also kept'],
    )
  })

  it('treats a missing body as an empty one, so an entry is not lost over it', () => {
    const raw = JSON.stringify([{ commit: 'aaaaaaa', date: LATER, subject: 'Kept' }])
    assert.equal(readChanges(raw)[0]?.body, '')
  })

  it('orders newest first, whatever order the JSON held them in', () => {
    const raw = JSON.stringify([
      { commit: 'bbbbbbb', date: EARLIER, subject: 'Older', body: '' },
      { commit: 'aaaaaaa', date: LATER, subject: 'Newer', body: '' },
    ])
    assert.deepEqual(
      readChanges(raw).map((change) => change.subject),
      ['Newer', 'Older'],
    )
  })
})

describe('changeEntryId', () => {
  it('keys the id on the commit, the same identity the React list key uses', () => {
    assert.equal(changeEntryId('de7dd8d'), 'change-de7dd8d')
  })
})

describe('whatsNewHref', () => {
  it('is the bare page for no commit, with no trailing slash', () => {
    assert.equal(whatsNewHref(null), '#/whats-new')
  })

  it('puts the commit in a path segment, like every other route here', () => {
    assert.equal(whatsNewHref('de7dd8d'), '#/whats-new/de7dd8d')
  })
})

describe('whatsNewCommit', () => {
  it('answers null for no commit, which is the whole page', () => {
    for (const param of [null, undefined, '', '   ']) {
      assert.equal(whatsNewCommit(param), null, `for ${JSON.stringify(param)}`)
    }
  })

  it('trims surrounding space, because this is a pasted URL', () => {
    assert.equal(whatsNewCommit(' de7dd8d '), 'de7dd8d')
  })

  it('round-trips a commit through the href', () => {
    const param = whatsNewHref('de7dd8d').slice('#/whats-new/'.length)
    assert.equal(whatsNewCommit(param), 'de7dd8d')
  })
})
