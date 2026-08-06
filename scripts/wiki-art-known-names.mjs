/**
 * Static backstop for names `discoverNames()` in fetch-wiki-art.mjs might not find
 * by sampling live accounts.
 *
 * Live sampling only looks up a name if some sampled maxed account happens to have
 * it equipped — for hero equipment that is a real gap: with 41 items split across
 * six heroes, no small sample of accounts owns all of them, so any item nobody
 * sampled happened to be wearing was never looked up at all, and its art was never
 * vendored. This module is the complete, hand-verified catalog that fills that gap
 * regardless of what any sampled account owns.
 *
 * Pets have the same shape and ride the troop kind rather than a dedicated one:
 * there is no `'pet'` entry in `ArtKind` (`web/src/wiki-art.ts`), because
 * `artKindFor` (`web/src/unit-display.ts`) already maps `'pet' -> 'troop'` and pet
 * art has always been vendored as part of the general troop sweep.
 *
 * Verified against the wiki, ClashVault and individual item pages. "Revenge Deck"
 * (Dragon Duke's would-be 6th equipment) is deliberately excluded: as of this
 * writing it does not release until 2026-08-12 and has no wiki page yet, so
 * including it would only ever be a guaranteed miss.
 */

const KNOWN_EQUIPMENT_NAMES = [
  // Barbarian King
  'Barbarian Puppet',
  'Rage Vial',
  'Earthquake Boots',
  'Vampstache',
  'Giant Gauntlet',
  'Spiky Ball',
  'Snake Bracelet',
  'Stick Horse',
  // Archer Queen
  'Archer Puppet',
  'Invisibility Vial',
  'Giant Arrow',
  'Healer Puppet',
  'Frozen Arrow',
  'Magic Mirror',
  'Action Figure',
  'Monolith Arrow',
  // Minion Prince
  'Henchmen Puppet',
  'Dark Orb',
  'Metal Pants',
  'Noble Iron',
  'Dark Crown',
  'Meteor Staff',
  // Grand Warden
  'Eternal Tome',
  'Life Gem',
  'Rage Gem',
  'Healing Tome',
  'Fireball',
  'Lavaloon Puppet',
  'Heroic Torch',
  // Royal Champion
  'Royal Gem',
  'Seeking Shield',
  'Hog Rider Puppet',
  'Haste Vial',
  'Rocket Spear',
  'Electro Boots',
  'Frost Flake',
  // Dragon Duke (Revenge Deck excluded — not live yet, see header)
  'Fire Heart',
  'Flame Blower',
  'Stun Blaster',
  'Electro Fangs',
  'Rocket Backpack',
]

const KNOWN_PET_NAMES = [
  'L.A.S.S.I',
  'Electro Owl',
  'Mighty Yak',
  'Unicorn',
  'Frosty',
  'Diggy',
  'Poison Lizard',
  'Phoenix',
  'Spirit Fox',
  'Angry Jelly',
  'Sneezy',
  'Greedy Raven',
]

/**
 * Static entries in the same `{ kind, name, village }` shape `discoverNames()`
 * builds from live sampling. All of it is `village: 'home'` — every hero (and
 * therefore every hero's equipment) and every pet lives in the home village.
 */
export const KNOWN_ENTRIES = [
  ...KNOWN_EQUIPMENT_NAMES.map((name) => ({ kind: 'equipment', name, village: 'home' })),
  // Pets have no dedicated ArtKind — see header — so they file under 'troop'.
  ...KNOWN_PET_NAMES.map((name) => ({ kind: 'troop', name, village: 'home' })),
]

/**
 * Merges live-sampled entries with the static known-name list, deduped by
 * `kind:name`. A live-sampled entry wins over a static one on a collision — it
 * reflects an actual account, whereas the static list's fields exist only to file
 * a missed name into the right kind/priority bucket.
 */
export function mergeKnownNames(discovered, known) {
  const entries = new Map(discovered.map((entry) => [`${entry.kind}:${entry.name}`, entry]))
  for (const entry of known) {
    const key = `${entry.kind}:${entry.name}`
    if (!entries.has(key)) entries.set(key, entry)
  }
  return [...entries.values()]
}
