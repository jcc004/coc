import type { UnitLevel } from '@coc/shared'
import { CARDS } from './cards.generated.ts'

/**
 * Names of every Super Troop the card-collecting event knows about — the
 * game's own list, not a name pattern. Several Super forms are not spelled
 * "Super X" (`Sneaky Goblin`, `Rocket Balloon`, `Inferno Dragon`, `Ice
 * Hound`, ...), so a `startsWith('Super ')` filter would miss them.
 * `cards.generated.ts` already carries one entry per card with
 * `category: "Super Troop"` for every one of them, so that is the source of
 * truth here rather than a second, hand-maintained list that can drift from it.
 */
const SUPER_TROOP_NAMES: ReadonlySet<string> = new Set(
  CARDS.filter((card) => card.category === 'Super Troop').map((card) => card.name),
)

/**
 * A Super Troop's level is derived from its base troop's level — the game
 * does not track it independently — so listing it as its own row in the
 * weekly progress panel would duplicate what the base troop's row already
 * shows. Drops any unit whose name is a known Super Troop; everything else
 * passes through unchanged, in order.
 */
export function excludeSuperTroops(units: readonly UnitLevel[]): UnitLevel[] {
  return units.filter((unit) => !SUPER_TROOP_NAMES.has(unit.name))
}
