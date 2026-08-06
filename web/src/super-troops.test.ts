import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UnitLevel } from '@coc/shared'
import { excludeSuperTroops } from './super-troops.ts'

function unit(name: string): UnitLevel {
  return { name, level: 1, maxLevel: 1 }
}

describe('excludeSuperTroops', () => {
  it('drops Super Troop entries even when the name does not start with "Super"', () => {
    // Confirmed against real captured data (bambamrainbow's troops_json): several
    // Super forms are not spelled "Super X", so a name-pattern filter would miss them.
    const units = [
      unit('Barbarian'),
      unit('Super Barbarian'),
      unit('Goblin'),
      unit('Sneaky Goblin'),
      unit('Balloon'),
      unit('Rocket Balloon'),
      unit('Dragon'),
      unit('Inferno Dragon'),
      unit('Ice Hound'),
    ]
    const result = excludeSuperTroops(units)
    assert.deepEqual(
      result.map((u) => u.name),
      ['Barbarian', 'Goblin', 'Balloon', 'Dragon'],
    )
  })

  it('leaves a list with no Super Troops untouched', () => {
    const units = [unit('Barbarian'), unit('Archer')]
    assert.deepEqual(excludeSuperTroops(units), units)
  })

  it('returns an empty list unchanged', () => {
    assert.deepEqual(excludeSuperTroops([]), [])
  })
})
