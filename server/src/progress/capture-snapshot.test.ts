import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  ClanMembersResponse,
  OwnerRecord,
  Player,
  PlayerItemLevel,
  SavedClanRecord,
} from '@coc/shared'
import { openDatabase } from '../db.ts'
import {
  buildAutoCapturePayload,
  captureAllSnapshots,
  collectTrackedTags,
  currentWeekStart,
  petNamesFromReference,
  splitTroopsAndPets,
  type CaptureDeps,
  type RosterDeps,
} from './capture-snapshot.ts'
import { createProgressStore } from './store.ts'

/*
 * Four things worth testing without a database or a live API call:
 * `currentWeekStart` (a pure date calculation), `splitTroopsAndPets` (the pet
 * classification, given a fabricated reference name set), `buildAutoCapturePayload`'s
 * home-village filter (Builder Base contamination must never reach a captured
 * payload), and `captureAllSnapshots`'s per-tag failure isolation and
 * `collectTrackedTags`'s roster union, both against a fake `CocClient` — the same
 * fake-upstream shape `app.test.ts` uses for it.
 */

function troop(name: string, level = 1, maxLevel = 10): PlayerItemLevel {
  return { name, level, maxLevel, village: 'home' }
}

function builderTroop(name: string, level = 1, maxLevel = 10): PlayerItemLevel {
  return { name, level, maxLevel, village: 'builderBase' }
}

describe('currentWeekStart', () => {
  it('returns the same date when given a Tuesday', () => {
    // 2026-08-04 is a Tuesday.
    assert.equal(currentWeekStart(new Date('2026-08-04T15:30:00Z')), '2026-08-04')
  })

  it('returns the prior Tuesday when given a Monday', () => {
    // 2026-08-03 is a Monday; the prior Tuesday is 2026-07-28.
    assert.equal(currentWeekStart(new Date('2026-08-03T00:00:00Z')), '2026-07-28')
  })

  it('returns the prior Tuesday when given a Sunday', () => {
    // 2026-08-09 is a Sunday; the prior Tuesday is 2026-08-04.
    assert.equal(currentWeekStart(new Date('2026-08-09T23:59:59Z')), '2026-08-04')
  })
})

describe('petNamesFromReference', () => {
  it('collects only the rows categorized as a pet', () => {
    const names = petNamesFromReference([
      { category: 'pet', name: 'L.A.S.S.I', thLevel: 15, maxLevel: 10, updatedAt: '' },
      { category: 'pet', name: 'Mighty Yak', thLevel: 15, maxLevel: 10, updatedAt: '' },
      { category: 'troop', name: 'Barbarian', thLevel: 1, maxLevel: 10, updatedAt: '' },
      { category: 'hero', name: 'Barbarian King', thLevel: 7, maxLevel: 100, updatedAt: '' },
    ])
    assert.deepEqual([...names].sort(), ['L.A.S.S.I', 'Mighty Yak'])
  })

  it('returns an empty set when the reference table is empty', () => {
    assert.equal(petNamesFromReference([]).size, 0)
  })
})

describe('splitTroopsAndPets', () => {
  it('moves only names present in the pet set into pets, and drops the extra API fields', () => {
    const petNames = new Set(['L.A.S.S.I', 'Mighty Yak'])
    const { troops, pets } = splitTroopsAndPets(
      [troop('Barbarian', 9, 11), troop('L.A.S.S.I', 5, 10), troop('Mighty Yak', 3, 10)],
      petNames,
    )
    assert.deepEqual(troops, [{ name: 'Barbarian', level: 9, maxLevel: 11 }])
    assert.deepEqual(pets, [
      { name: 'L.A.S.S.I', level: 5, maxLevel: 10 },
      { name: 'Mighty Yak', level: 3, maxLevel: 10 },
    ])
  })

  it('classifies everything as a troop when the pet set is empty (bootstrap gap)', () => {
    const { troops, pets } = splitTroopsAndPets(
      [troop('Barbarian'), troop('L.A.S.S.I')],
      new Set(),
    )
    assert.equal(troops.length, 2)
    assert.equal(pets.length, 0)
  })
})

describe('buildAutoCapturePayload', () => {
  it('shapes a Player into an AutoCapturePayload, splitting troops from pets', () => {
    const player: Player = {
      tag: '#PLAYER',
      name: 'Test',
      townHallLevel: 15,
      expLevel: 100,
      trophies: 0,
      bestTrophies: 0,
      warStars: 0,
      attackWins: 0,
      defenseWins: 0,
      donations: 0,
      donationsReceived: 0,
      clanCapitalContributions: 0,
      achievements: [],
      labels: [],
      troops: [troop('Barbarian'), troop('L.A.S.S.I')],
      heroes: [troop('Barbarian King', 80, 100)],
      heroEquipment: [troop('Barbarian Puppet', 18, 27)],
      spells: [troop('Lightning Spell', 10, 11)],
    }

    const payload = buildAutoCapturePayload(player, new Set(['L.A.S.S.I']))

    assert.equal(payload.thLevel, 15)
    assert.deepEqual(payload.heroes, [{ name: 'Barbarian King', level: 80, maxLevel: 100 }])
    assert.deepEqual(payload.equipment, [{ name: 'Barbarian Puppet', level: 18, maxLevel: 27 }])
    assert.deepEqual(payload.troops, [{ name: 'Barbarian', level: 1, maxLevel: 10 }])
    assert.deepEqual(payload.pets, [{ name: 'L.A.S.S.I', level: 1, maxLevel: 10 }])
    assert.deepEqual(payload.spells, [{ name: 'Lightning Spell', level: 10, maxLevel: 11 }])
  })

  it('filters out every Builder Base entry, so no builder-base stat reaches the payload', () => {
    const player: Player = {
      tag: '#PLAYER',
      name: 'Test',
      townHallLevel: 15,
      expLevel: 100,
      trophies: 0,
      bestTrophies: 0,
      warStars: 0,
      attackWins: 0,
      defenseWins: 0,
      donations: 0,
      donationsReceived: 0,
      clanCapitalContributions: 0,
      achievements: [],
      labels: [],
      // A realistic mixed-village fixture: home-village units alongside the
      // Battle Machine (a hero) and Battle Copter (a troop) that only exist on
      // the Builder Base.
      troops: [troop('Barbarian'), builderTroop('Battle Copter', 10, 10)],
      heroes: [troop('Barbarian King', 80, 100), builderTroop('Battle Machine', 20, 30)],
      heroEquipment: [troop('Barbarian Puppet', 18, 27)],
      spells: [troop('Lightning Spell', 10, 11), builderTroop('Not A Real Builder Spell', 1, 1)],
    }

    const payload = buildAutoCapturePayload(player, new Set())

    assert.deepEqual(payload.heroes, [{ name: 'Barbarian King', level: 80, maxLevel: 100 }])
    assert.deepEqual(payload.troops, [{ name: 'Barbarian', level: 1, maxLevel: 10 }])
    assert.deepEqual(payload.spells, [{ name: 'Lightning Spell', level: 10, maxLevel: 11 }])
    assert.deepEqual(payload.equipment, [{ name: 'Barbarian Puppet', level: 18, maxLevel: 27 }])
    // thLevel is home-base-specific already, so it passes through untouched.
    assert.equal(payload.thLevel, 15)
  })

  it('never lets a Builder Base unit be misclassified as a home-village pet', () => {
    // "Battle Copter" is not a real pet name, but the point of this test is the
    // ordering guarantee: even if a builder-base unit's name collided with a pet
    // name in the reference table, the village filter runs first, so it is
    // dropped before pet classification ever sees it.
    const player: Player = {
      tag: '#PLAYER',
      name: 'Test',
      townHallLevel: 15,
      expLevel: 100,
      trophies: 0,
      bestTrophies: 0,
      warStars: 0,
      attackWins: 0,
      defenseWins: 0,
      donations: 0,
      donationsReceived: 0,
      clanCapitalContributions: 0,
      achievements: [],
      labels: [],
      troops: [troop('L.A.S.S.I'), builderTroop('L.A.S.S.I')],
      heroes: [],
      spells: [],
    }

    const payload = buildAutoCapturePayload(player, new Set(['L.A.S.S.I']))

    assert.deepEqual(payload.pets, [{ name: 'L.A.S.S.I', level: 1, maxLevel: 10 }])
    assert.deepEqual(payload.troops, [])
  })

  it('defaults equipment to an empty array when the API omits heroEquipment', () => {
    const player: Player = {
      tag: '#PLAYER',
      name: 'Test',
      townHallLevel: 5,
      expLevel: 10,
      trophies: 0,
      bestTrophies: 0,
      warStars: 0,
      attackWins: 0,
      defenseWins: 0,
      donations: 0,
      donationsReceived: 0,
      clanCapitalContributions: 0,
      achievements: [],
      labels: [],
      troops: [],
      heroes: [],
      spells: [],
    }
    assert.deepEqual(buildAutoCapturePayload(player, new Set()).equipment, [])
  })
})

describe('captureAllSnapshots', () => {
  function basePlayer(tag: string, thLevel: number): Player {
    return {
      tag,
      name: tag,
      townHallLevel: thLevel,
      expLevel: 1,
      trophies: 0,
      bestTrophies: 0,
      warStars: 0,
      attackWins: 0,
      defenseWins: 0,
      donations: 0,
      donationsReceived: 0,
      clanCapitalContributions: 0,
      achievements: [],
      labels: [],
      troops: [],
      heroes: [],
      spells: [],
    }
  }

  it('captures every tag that succeeds and records the tag and reason for every one that fails', async () => {
    const db = openDatabase(':memory:')
    const progress = createProgressStore(db)

    const coc: CaptureDeps['coc'] = {
      getPlayer: async (tag: string) => {
        if (tag === '#BAD') throw new Error('404 notFound: no player with that tag')
        return basePlayer(tag, 16)
      },
    }

    const summary = await captureAllSnapshots(
      ['#GOOD1', '#BAD', '#GOOD2'],
      '2026-08-04',
      new Set(),
      { coc, progress },
    )

    assert.deepEqual(summary.succeeded, ['#GOOD1', '#GOOD2'])
    assert.deepEqual(summary.failed, [{ tag: '#BAD', reason: '404 notFound: no player with that tag' }])

    // The two successful tags actually landed in the store, not just in the summary.
    assert.equal(progress.getHistory('#GOOD1').length, 1)
    assert.equal(progress.getHistory('#GOOD2').length, 1)
    assert.equal(progress.getHistory('#BAD').length, 0)

    db.close()
  })

  it('continues past a failure in the middle of the batch rather than aborting the run', async () => {
    const db = openDatabase(':memory:')
    const progress = createProgressStore(db)
    const seen: string[] = []

    const coc: CaptureDeps['coc'] = {
      getPlayer: async (tag: string) => {
        seen.push(tag)
        if (tag === '#MID') throw new Error('upstream hiccup')
        return basePlayer(tag, 10)
      },
    }

    const summary = await captureAllSnapshots(['#FIRST', '#MID', '#LAST'], '2026-08-04', new Set(), {
      coc,
      progress,
    })

    // Every tag was attempted, in order, despite the failure in the middle.
    assert.deepEqual(seen, ['#FIRST', '#MID', '#LAST'])
    assert.deepEqual(summary.succeeded, ['#FIRST', '#LAST'])
    assert.equal(summary.failed.length, 1)
    assert.equal(summary.failed[0]?.tag, '#MID')

    db.close()
  })

  it('reports a non-Error throw by stringifying it, rather than crashing the run', async () => {
    const db = openDatabase(':memory:')
    const progress = createProgressStore(db)

    const coc: CaptureDeps['coc'] = {
      getPlayer: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately not an Error, to prove a non-Error throw is stringified rather than crashing the run
        throw 'plain string failure'
      },
    }

    const summary = await captureAllSnapshots(['#WEIRD'], '2026-08-04', new Set(), {
      coc,
      progress,
    })

    assert.deepEqual(summary.failed, [{ tag: '#WEIRD', reason: 'plain string failure' }])
    db.close()
  })
})

describe('collectTrackedTags', () => {
  function owner(tag: string): OwnerRecord {
    return { tag, owner: 'Someone' }
  }

  function clan(tag: string): SavedClanRecord {
    return { tag, name: 'Clan' }
  }

  function membersResponse(tags: string[]): ClanMembersResponse {
    return {
      items: tags.map((tag) => ({
        tag,
        name: tag,
        role: 'member',
        townHallLevel: 10,
        expLevel: 1,
        trophies: 0,
        clanRank: 1,
        previousClanRank: 1,
        donations: 0,
        donationsReceived: 0,
      })),
    }
  }

  it('unions live clan members with owner-assigned tags, deduped', async () => {
    const deps: RosterDeps = {
      coc: { getClanMembers: async () => membersResponse(['#MEMBER1', '#MEMBER2', '#OWNED']) },
      sharedData: {
        listOwners: () => [owner('#OWNED'), owner('#LEFTCLAN')],
        listSavedClans: () => [clan('#CLAN1')],
      },
    }

    const tags = await collectTrackedTags(deps)
    assert.deepEqual(
      new Set(tags),
      new Set(['#MEMBER1', '#MEMBER2', '#OWNED', '#LEFTCLAN']),
    )
  })

  it('keeps an owner tag whose base has since left the clan roster', async () => {
    const deps: RosterDeps = {
      coc: { getClanMembers: async () => membersResponse(['#STILLIN']) },
      sharedData: {
        listOwners: () => [owner('#LEFT')],
        listSavedClans: () => [clan('#CLAN1')],
      },
    }

    const tags = await collectTrackedTags(deps)
    assert.ok(tags.includes('#LEFT'), 'an owner tag no longer on the roster must still be tracked')
    assert.ok(tags.includes('#STILLIN'))
  })

  it("does not abort the run, or drop owner tags, when one clan's roster fails to load", async () => {
    const seen: string[] = []
    const deps: RosterDeps = {
      coc: {
        getClanMembers: async (tag: string) => {
          seen.push(tag)
          if (tag === '#BADCLAN') throw new Error('upstream hiccup')
          return membersResponse(['#GOODMEMBER'])
        },
      },
      sharedData: {
        listOwners: () => [owner('#OWNED')],
        listSavedClans: () => [clan('#BADCLAN'), clan('#GOODCLAN')],
      },
    }

    const tags = await collectTrackedTags(deps)
    assert.deepEqual(seen, ['#BADCLAN', '#GOODCLAN'], 'every clan is still attempted')
    assert.deepEqual(new Set(tags), new Set(['#OWNED', '#GOODMEMBER']))
  })

  it('returns just the owner tags when there are no saved clans', async () => {
    const deps: RosterDeps = {
      coc: { getClanMembers: async () => membersResponse([]) },
      sharedData: {
        listOwners: () => [owner('#ONLYOWNER')],
        listSavedClans: () => [],
      },
    }

    const tags = await collectTrackedTags(deps)
    assert.deepEqual(tags, ['#ONLYOWNER'])
  })
})
