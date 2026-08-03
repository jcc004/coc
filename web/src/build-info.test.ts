import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BUILD_LAG_WORTH_SHOWING_MS,
  buildLine,
  parseStamp,
  type BuildInfo,
} from './build-info.ts'

/* A fixed formatter, so the assertions are about the rules and not about the host's
   locale or timezone. */
const fmt = (date: Date) => date.toISOString().slice(0, 16).replace('T', ' ')

const COMMITTED = '2026-08-03T17:42:00.000Z'
const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  commit: 'de7dd8d',
  commitDate: COMMITTED,
  builtAt: COMMITTED,
  ...over,
})

describe('parseStamp', () => {
  it('reads a real timestamp', () => {
    assert.equal(parseStamp(COMMITTED)?.toISOString(), COMMITTED)
  })

  it('answers null for anything that is not one', () => {
    // `new Date('')` is an Invalid Date, which formats as "Invalid Date" — the exact
    // string a footer must never print. Every one of these reaches production when a
    // build has no git: a tarball deploy, a shallow clone, an image without git.
    for (const raw of ['', ' ', 'unknown', 'not a date', 'HEAD']) {
      assert.equal(parseStamp(raw), null, `for ${JSON.stringify(raw)}`)
    }
  })
})

describe('buildLine', () => {
  it('shows the commit date to everybody, and nothing else to a member', () => {
    const line = buildLine(info(), false, fmt)
    assert.equal(line?.updated, 'Updated 2026-08-03 17:42')
    assert.equal(line?.detail, null)
  })

  it('shows the commit hash to an admin', () => {
    assert.equal(buildLine(info(), true, fmt)?.detail, 'de7dd8d')
  })

  it('never leaks the hash to a member', () => {
    // Not a secret, but it is diagnostic noise for somebody with no repository to
    // look it up in — and the request was explicit that it is admin-only.
    const line = buildLine(info(), false, fmt)
    assert.ok(!JSON.stringify(line).includes('de7dd8d'))
  })

  it('carries an exact timestamp for the tooltip alongside the readable one', () => {
    const line = buildLine(info(), true, fmt, (d) => `EXACT ${d.toISOString()}`)
    assert.equal(line?.exact, `EXACT ${COMMITTED}`)
  })

  it('stays quiet about the build time when it closely follows the commit', () => {
    // The normal case: you build what you just committed. Printing both would be noise.
    const soon = new Date(Date.parse(COMMITTED) + 5 * 60 * 1000).toISOString()
    assert.equal(buildLine(info({ builtAt: soon }), true, fmt)?.detail, 'de7dd8d')
  })

  it('names the build time to an admin once it lags the commit', () => {
    // "committed days ago, built minutes ago" is what answers "did my deploy run".
    const late = new Date(Date.parse(COMMITTED) + BUILD_LAG_WORTH_SHOWING_MS + 1000).toISOString()
    const detail = buildLine(info({ builtAt: late }), true, fmt)?.detail
    assert.match(detail ?? '', /^de7dd8d · built /)
  })

  it('does not show the build lag to a member', () => {
    const late = new Date(Date.parse(COMMITTED) + 48 * 60 * 60 * 1000).toISOString()
    assert.equal(buildLine(info({ builtAt: late }), false, fmt)?.detail, null)
  })

  it('prints nothing at all when the build knew nothing and you are a member', () => {
    // Better than "Updated unknown" in the place a real date goes: a line that says
    // something vacuous trains people to stop reading it.
    assert.equal(buildLine({ commit: '', commitDate: '', builtAt: '' }, false, fmt), null)
  })

  it('still gives an admin the hash when the dates are missing', () => {
    const line = buildLine({ commit: 'abc1234', commitDate: '', builtAt: '' }, true, fmt)
    assert.equal(line?.updated, 'Build')
    assert.equal(line?.detail, 'abc1234')
    assert.equal(line?.exact, null, 'no date means no tooltip to offer')
  })

  it('still gives everybody the date when the hash is missing', () => {
    const line = buildLine(info({ commit: '' }), true, fmt)
    assert.equal(line?.updated, 'Updated 2026-08-03 17:42')
    assert.equal(line?.detail, null)
  })

  it('names the build time to an admin even with no commit date to compare against', () => {
    // Absent a commit date there is nothing to call "close", so the build time is the
    // only age information there is and withholding it would leave the line empty.
    const line = buildLine({ commit: '', commitDate: '', builtAt: COMMITTED }, true, fmt)
    assert.match(line?.detail ?? '', /^built /)
  })

  it('never produces "Invalid Date" from any combination of junk', () => {
    for (const commitDate of ['', 'nope', COMMITTED]) {
      for (const builtAt of ['', 'nope', COMMITTED]) {
        for (const commit of ['', 'de7dd8d']) {
          for (const isAdmin of [true, false]) {
            const line = buildLine({ commit, commitDate, builtAt }, isAdmin, fmt)
            if (line === null) continue
            const text = `${line.updated} ${line.detail ?? ''} ${line.exact ?? ''}`
            assert.ok(!/Invalid Date|NaN/.test(text), `got ${JSON.stringify(text)}`)
          }
        }
      }
    }
  })
})
