import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { activeTag } from './base-scope.ts'
import { lastBaseKey, rememberedBaseTag } from './last-base.ts'

/** The picker's options as `baseOptions` hands them over, ordered by member name. */
const OFFERED = [{ tag: '#MINE1' }, { tag: '#THEIRS' }, { tag: '#MINE2' }]

/** What the card page actually does with a stored value: seed, then repair. */
function opensOn(stored: string | null, options: readonly { tag: string }[] = OFFERED) {
  return activeTag(options, rememberedBaseTag(stored))
}

describe('lastBaseKey — one browser, several people', () => {
  it('keys the remembered base per account, as the Mine/All filter is keyed', () => {
    assert.equal(lastBaseKey(3), 'coc:cardBase:3')
    assert.notEqual(lastBaseKey(1), lastBaseKey(2))
  })
})

describe('rememberedBaseTag — what came back out of storage', () => {
  it('returns the stored tag when there is one', () => {
    assert.equal(rememberedBaseTag('#2GCJ2QPU'), '#2GCJ2QPU')
  })

  it('canonicalises a tag written by hand, so it can match the picker’s options', () => {
    assert.equal(rememberedBaseTag('2gcj2qpu'), '#2GCJ2QPU')
  })

  it('is null for an account that has never chosen a base', () => {
    assert.equal(rememberedBaseTag(null), null)
  })

  it('is null for an empty string, which is a key written and then cleared', () => {
    assert.equal(rememberedBaseTag(''), null)
  })

  it('reads malformed stored data as nothing remembered rather than throwing', () => {
    // localStorage is user-writable. `normalizeTag` throws on input it cannot read,
    // and this value seeds React state during render, where a throw is the whole
    // app — the same class of failure as the truncated percent-escape in `parseHash`.
    for (const stored of ['#', '%', '#AB', '#a b!', '{"tag":"#AAA"}', '   ', '#TOOLONGATAG12']) {
      assert.equal(rememberedBaseTag(stored), null, `expected null for ${JSON.stringify(stored)}`)
    }
  })
})

describe('the base the card page opens on', () => {
  it('reselects the remembered base when the list still offers it', () => {
    assert.equal(opensOn('#THEIRS'), '#THEIRS')
  })

  it('falls back to the head of the list when the remembered base is gone', () => {
    // Unassigned, removed, or dropped by the Mine filter — the page picks what it
    // picks today rather than showing an empty editor or an error.
    assert.equal(opensOn('#GONE'), '#MINE1')
    assert.equal(opensOn('#THEIRS', [{ tag: '#MINE1' }, { tag: '#MINE2' }]), '#MINE1')
  })

  it('picks the first offered base on a first visit, with nothing remembered', () => {
    assert.equal(opensOn(null), '#MINE1')
  })

  it('picks the first offered base when the stored value is malformed', () => {
    assert.equal(opensOn('{"tag":"#MINE2"}'), '#MINE1')
  })

  it('is null, not a crash, when there are no bases to offer at all', () => {
    assert.equal(opensOn('#THEIRS', []), null)
    assert.equal(opensOn(null, []), null)
  })
})
