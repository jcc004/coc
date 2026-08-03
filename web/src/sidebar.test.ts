import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  clanTargetTag,
  hashTarget,
  lastClanKey,
  lastRouteKey,
  routeToRemember,
  shouldRestoreRoute,
} from './last-route.ts'
import {
  addRecent,
  MAX_RECENTS_PER_KIND,
  parseRecents,
  recentsOfKind,
  type Recent,
} from './recents.ts'

const player = (tag: string, name = tag): Recent => ({ kind: 'player', tag, name })
const clan = (tag: string, name = tag): Recent => ({ kind: 'clan', tag, name })

const tags = (list: Recent[]) => list.map((item) => item.tag)

describe('addRecent', () => {
  it('puts the newest visit first', () => {
    const list = addRecent([player('#A')], player('#B'))
    assert.deepEqual(tags(list), ['#B', '#A'])
  })

  it('moves a repeat visit to the front instead of duplicating it', () => {
    const list = addRecent([player('#A'), player('#B')], player('#B'))
    assert.deepEqual(tags(list), ['#B', '#A'])
  })

  it('refreshes the stored name on a repeat visit', () => {
    const list = addRecent([player('#A', 'old name')], player('#A', 'new name'))
    assert.deepEqual(list, [player('#A', 'new name')])
  })

  it(`keeps at most ${MAX_RECENTS_PER_KIND} of a kind`, () => {
    let list: Recent[] = []
    for (const tag of ['#A', '#B', '#C', '#D']) list = addRecent(list, player(tag))

    assert.equal(list.length, MAX_RECENTS_PER_KIND)
    assert.deepEqual(tags(list), ['#D', '#C', '#B'], 'the oldest player falls off')
  })

  it('caps each kind independently, so players cannot evict clans', () => {
    let list: Recent[] = [clan('#CLAN1'), clan('#CLAN2')]
    // Four player lookups is more than the whole list used to hold.
    for (const tag of ['#P1', '#P2', '#P3', '#P4']) list = addRecent(list, player(tag))

    assert.deepEqual(tags(recentsOfKind(list, 'clan')), ['#CLAN1', '#CLAN2'])
    assert.equal(recentsOfKind(list, 'player').length, MAX_RECENTS_PER_KIND)
  })

  it('keeps overall recency order across kinds', () => {
    let list: Recent[] = []
    list = addRecent(list, player('#P1'))
    list = addRecent(list, clan('#C1'))
    list = addRecent(list, player('#P2'))

    assert.deepEqual(tags(list), ['#P2', '#C1', '#P1'])
  })

  it('does not mutate the list it is given', () => {
    const original = [player('#A')]
    addRecent(original, player('#B'))
    assert.deepEqual(tags(original), ['#A'])
  })
})

describe('recentsOfKind', () => {
  it('filters by kind and truncates', () => {
    const list = [player('#P1'), clan('#C1'), player('#P2'), player('#P3'), player('#P4')]
    assert.deepEqual(tags(recentsOfKind(list, 'clan')), ['#C1'])
    // A list stored before the per-kind cap existed can hold more than the max.
    assert.equal(recentsOfKind(list, 'player').length, MAX_RECENTS_PER_KIND)
  })

  it('returns an empty list rather than throwing when a kind is absent', () => {
    assert.deepEqual(recentsOfKind([player('#P1')], 'clan'), [])
  })
})

describe('parseRecents', () => {
  it('reads a well-formed list', () => {
    const stored = JSON.stringify([player('#A'), clan('#B')])
    assert.deepEqual(tags(parseRecents(stored)), ['#A', '#B'])
  })

  it('falls back to empty on anything unusable', () => {
    for (const raw of [null, '', 'not json', '{}', '42', '"a string"', 'null']) {
      assert.deepEqual(parseRecents(raw), [], `expected [] for ${JSON.stringify(raw)}`)
    }
  })

  it('drops entries that are not recognisable visits', () => {
    const stored = JSON.stringify([
      player('#GOOD'),
      { kind: 'player', tag: 123, name: 'numeric tag' },
      { kind: 'guild', tag: '#X', name: 'unknown kind' },
      { tag: '#Y', name: 'no kind' },
      null,
      'string',
    ])
    assert.deepEqual(tags(parseRecents(stored)), ['#GOOD'])
  })
})

describe('lastRouteKey', () => {
  it('is scoped per account, so a shared browser does not cross wires', () => {
    assert.notEqual(lastRouteKey(1), lastRouteKey(2))
    assert.match(lastRouteKey(7), /7$/)
  })
})

describe('lastClanKey', () => {
  it('is scoped per account, and is not the last-route key', () => {
    assert.notEqual(lastClanKey(1), lastClanKey(2))
    // Two different things: the last route is usually not a clan at all.
    assert.notEqual(lastClanKey(1), lastRouteKey(1))
  })
})

describe('clanTargetTag', () => {
  it('gives back the stored clan, canonicalised', () => {
    assert.equal(clanTargetTag('#G88CYQP'), '#G88CYQP')
    assert.equal(clanTargetTag('g88cyqp'), '#G88CYQP')
    assert.equal(clanTargetTag('%23G88CYQP'), '#G88CYQP')
  })

  it('answers null before any clan has been visited', () => {
    // The caller's cue to fall back to the saved-clans list, so the Clan button
    // in the topbar always goes somewhere.
    assert.equal(clanTargetTag(null), null)
  })

  it('answers null for junk left in storage rather than navigating to it', () => {
    for (const stored of ['', '!!', '#', 'a'.repeat(40)]) {
      assert.equal(clanTargetTag(stored), null, `for ${JSON.stringify(stored)}`)
    }
  })
})

describe('shouldRestoreRoute', () => {
  it('restores when the app was opened with no hash', () => {
    for (const current of ['', '#', '#/']) {
      assert.equal(shouldRestoreRoute(current, '#/clan/%23G88CYQP'), true, `for ${current}`)
    }
  })

  it('leaves an explicit deep link alone', () => {
    // Someone who opened a link, or reloaded a sub page, has already chosen.
    assert.equal(shouldRestoreRoute('#/player/%232GCJ2QPU', '#/clan/%23G88CYQP'), false)
  })

  it('does nothing without a usable stored route', () => {
    for (const stored of [null, '', '#', '#/']) {
      assert.equal(shouldRestoreRoute('', stored), false, `for ${JSON.stringify(stored)}`)
    }
  })
})

describe('hashTarget', () => {
  it('strips the leading hash, which location.hash adds back', () => {
    assert.equal(hashTarget('#/clan/%23ABC'), '/clan/%23ABC')
  })

  it('accepts a value stored without the prefix', () => {
    assert.equal(hashTarget('/clan/%23ABC'), '/clan/%23ABC')
  })

  it('strips only one hash, leaving an encoded tag intact', () => {
    assert.equal(hashTarget('#/clan/%23G88CYQP'), '/clan/%23G88CYQP')
  })
})

describe('routeToRemember', () => {
  it('remembers a real page', () => {
    assert.equal(routeToRemember('#/war/%23G88CYQP'), '#/war/%23G88CYQP')
  })

  it('forgets when the user is on the home page', () => {
    // Otherwise going home then signing back in would jump to a stale sub page.
    for (const hash of ['', '#', '#/']) {
      assert.equal(routeToRemember(hash), null, `for ${JSON.stringify(hash)}`)
    }
  })
})
