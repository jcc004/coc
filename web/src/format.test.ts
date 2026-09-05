import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_DATE_FORMAT, type DateFormatPreference } from './date-format.ts'
import { formatDate, formatDateTime, formatShortDate, summarize } from './format.ts'

describe('summarize', () => {
  it('returns text unchanged when it already fits', () => {
    assert.equal(summarize('short', 200), 'short')
  })

  it('returns text unchanged at exactly the limit, not truncated', () => {
    assert.equal(summarize('12345', 5), '12345')
  })

  it('cuts at the nearest word boundary rather than mid-word', () => {
    const text = 'one two three four five'
    // Cutting at 12 chars lands inside "three" — the boundary before it is at 8.
    assert.equal(summarize(text, 12), 'one two…')
  })

  it('falls back to a raw cut when there is no space to break on', () => {
    // A single unbroken word longer than the limit has no earlier space at
    // all, so `lastIndexOf(' ')` returns -1 and the raw 10-char slice is kept.
    assert.equal(summarize('supercalifragilisticexpialidocious', 10), 'supercalif…')
    assert.equal(summarize('a'.repeat(20), 10), `${'a'.repeat(10)}…`)
  })

  it('never returns a bare ellipsis with nothing before it', () => {
    // If the only space within the cut sits at index 0, `lastSpace > 0`
    // (not `>= 0`) refuses to treat it as a real boundary — slicing to it
    // would produce an empty string plus "…" with nothing readable at all.
    // The raw one-character cut (a lone space) is kept instead.
    assert.equal(summarize(' abcdefgh', 1), ' …')
  })
})

/**
 * Wiring only — every actual order/separator/hour-cycle combination is
 * `date-format.test.ts`'s job, against `composeDate`/`composeTime` directly. What
 * matters here is that `formatDateTime`/`formatShortDate`/`formatDate` actually pass
 * a caller's `preference` through rather than ignoring it, and that omitting it
 * falls back to `DEFAULT_DATE_FORMAT` — the same default `format.ts` used to give
 * everyone unconditionally, before this was configurable.
 */
describe('formatDateTime / formatShortDate / formatDate honor an explicit preference', () => {
  const ISO: DateFormatPreference = { order: 'YMD', separator: '-', hourCycle: '24h' }
  const instant = new Date(2026, 7, 24, 17, 42)

  it('formatDateTime composes date and time per the preference', () => {
    assert.equal(formatDateTime(instant, ISO), '2026-08-24, 17:42')
    assert.equal(formatDateTime(instant, DEFAULT_DATE_FORMAT), '08/24/2026, 5:42 PM')
  })

  it('formatDateTime defaults to DEFAULT_DATE_FORMAT when no preference is passed', () => {
    assert.equal(formatDateTime(instant), formatDateTime(instant, DEFAULT_DATE_FORMAT))
  })

  it('formatShortDate composes only the date, with a two-digit year', () => {
    assert.equal(formatShortDate(instant, ISO), '26-08-24')
    assert.equal(formatShortDate(instant, DEFAULT_DATE_FORMAT), '08/24/26')
  })

  it('formatDate composes per the preference', () => {
    // Not hardcoded as "2026-08-24": `formatDate` parses at UTC midnight and then
    // reads *local* date components (see its own doc comment), so what calendar day
    // that resolves to depends on this machine's timezone. Deriving the expectation
    // from the same `Date` the function itself builds is what makes this assertion
    // correct regardless of where it runs, while still proving the preference
    // actually reaches the output.
    const resolved = new Date('2026-08-24T00:00:00Z')
    const y = String(resolved.getFullYear())
    const m = String(resolved.getMonth() + 1).padStart(2, '0')
    const d = String(resolved.getDate()).padStart(2, '0')

    assert.equal(formatDate('2026-08-24', ISO), `${y}-${m}-${d}`)
    assert.equal(formatDate('2026-08-24', DEFAULT_DATE_FORMAT), `${m}/${d}/${y}`)
  })

  it('formatDate defaults to DEFAULT_DATE_FORMAT when no preference is passed', () => {
    assert.equal(formatDate('2026-08-24'), formatDate('2026-08-24', DEFAULT_DATE_FORMAT))
  })
})
