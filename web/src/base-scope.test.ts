import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activeTag,
  baseScopeFor,
  baseScopeKey,
  isBaseScope,
  ownsAnyBase,
  tagsInScope,
  type ScopedBase,
} from './base-scope.ts'

const ME = 7
const SOMEBODY_ELSE = 9

const BASES: ScopedBase[] = [
  { tag: '#MINE1', ownerUserId: ME },
  { tag: '#THEIRS', ownerUserId: SOMEBODY_ELSE },
  { tag: '#LABEL', ownerUserId: null }, // an owner name never matched to an account
  { tag: '#MINE2', ownerUserId: ME },
]

describe('baseScopeKey — one browser, several people', () => {
  it('keys the choice per account, like the last-clan button does', () => {
    assert.notEqual(baseScopeKey(1), baseScopeKey(2))
    assert.equal(baseScopeKey(3), 'coc:baseScope:3')
  })
})

describe('baseScopeFor — which filter to open on', () => {
  it('defaults to Mine for an account that owns a base', () => {
    assert.equal(baseScopeFor(null, true), 'mine')
  })

  it('defaults to All for an account that owns nothing, rather than an empty screen', () => {
    assert.equal(baseScopeFor(null, false), 'all')
  })

  it('honors a stored choice either way', () => {
    assert.equal(baseScopeFor('all', true), 'all')
    assert.equal(baseScopeFor('mine', true), 'mine')
  })

  it('honors a stored Mine even for an account that now owns nothing', () => {
    // They asked for it, and the empty list says so in words. Overriding a choice
    // somebody made would leave the empty-Mine message unreachable.
    assert.equal(baseScopeFor('mine', false), 'mine')
  })

  it('treats anything else in storage as nothing stored', () => {
    // localStorage is hand-editable and outlives versions.
    for (const stored of ['', 'MINE', 'ours', '{}', 'null']) {
      assert.equal(baseScopeFor(stored, false), 'all')
      assert.equal(baseScopeFor(stored, true), 'mine')
    }
    assert.equal(isBaseScope('mine'), true)
    assert.equal(isBaseScope(null), false)
  })
})

describe('ownsAnyBase — what the default turns on', () => {
  it('is true when an assignment points at this account', () => {
    assert.equal(ownsAnyBase(BASES, ME), true)
  })

  it('is false for an account with no assignment', () => {
    assert.equal(ownsAnyBase(BASES, 42), false)
  })

  it('is false when the only match is an unlinked owner label', () => {
    // A label is a note about a person, not a permission — the same reading the
    // write rule takes.
    assert.equal(ownsAnyBase([{ tag: '#LABEL', ownerUserId: null }], ME), false)
  })
})

describe('tagsInScope — membership only', () => {
  it('offers everything under All', () => {
    assert.deepEqual(tagsInScope(BASES, 'all', ME), ['#MINE1', '#THEIRS', '#LABEL', '#MINE2'])
  })

  it('offers only this account’s bases under Mine', () => {
    assert.deepEqual(tagsInScope(BASES, 'mine', ME), ['#MINE1', '#MINE2'])
  })

  it('never counts an unlinked label as mine, whoever it names', () => {
    assert.deepEqual(tagsInScope([{ tag: '#LABEL', ownerUserId: null }], 'mine', ME), [])
  })

  it('is empty, not everything, when Mine matches nothing', () => {
    assert.deepEqual(tagsInScope(BASES, 'mine', 42), [])
  })

  it('leaves the order alone — `baseOptions` is what orders the picker', () => {
    const reversed = [...BASES].reverse()
    assert.deepEqual(tagsInScope(reversed, 'all', ME), reversed.map((base) => base.tag))
  })
})

describe('activeTag — the selection cannot point outside the list', () => {
  const mine = [{ tag: '#MINE1' }, { tag: '#MINE2' }]

  it('keeps a selection the list still offers', () => {
    assert.equal(activeTag(mine, '#MINE2'), '#MINE2')
  })

  it('moves a selection the filter has dropped to the head of the list', () => {
    // The case that matters: switching to Mine while viewing somebody else's base.
    assert.equal(activeTag(mine, '#THEIRS'), '#MINE1')
  })

  it('defaults to the first offered when nothing has been chosen', () => {
    assert.equal(activeTag(mine, null), '#MINE1')
  })

  it('is null only when there is nothing to offer', () => {
    assert.equal(activeTag([], '#THEIRS'), null)
    assert.equal(activeTag([], null), null)
  })
})
