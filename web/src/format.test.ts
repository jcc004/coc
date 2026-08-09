import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { summarize } from './format.ts'

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
