import {
  CARD_ID_MAX,
  CARD_ID_MIN,
  MAX_CARD_COUNT,
  type BaseInventory,
  type CardCategory,
  type CardCount,
} from '@coc/shared'
import { CARDS, type GeneratedCard } from './cards.generated.ts'

/**
 * The hand-written half of the card list. The sixty cards themselves are
 * generated (`cards.generated.ts`); everything here is lookup and shaping, which
 * is the part that can silently rot, so it carries tests.
 *
 * Nothing in this module knows about the server. Counts arrive as a
 * `BaseInventory` from `card-inventory.ts` and are turned into the dense,
 * ordered rows a grid wants — the sparse-to-dense join lives here rather than in
 * a component so it can be tested without a DOM.
 */

export type { GeneratedCard } from './cards.generated.ts'

export const ALL_CARDS: readonly GeneratedCard[] = CARDS

/** Id → card. Built once; sixty linear scans per render would be sixty too many. */
const BY_ID = new Map<number, GeneratedCard>(CARDS.map((card) => [card.id, card]))

export function cardById(id: number): GeneratedCard | undefined {
  return BY_ID.get(id)
}

/**
 * The category a card belongs to, or `undefined` for an id we do not know.
 *
 * This is the shape `suggestTrades` wants: an unknown id has no category, so it
 * can never match another card's, and an inventory row left behind by a card
 * that has since been removed simply stops producing suggestions rather than
 * pairing with something arbitrary.
 */
export function categoryOfCard(id: number): CardCategory | undefined {
  return BY_ID.get(id)?.category
}

/** The categories actually present, in manifest order — the grid's section order. */
export function cardCategoriesInOrder(): CardCategory[] {
  const seen: CardCategory[] = []
  for (const card of CARDS) if (!seen.includes(card.category)) seen.push(card.category)
  return seen
}

export function cardsInCategory(category: CardCategory): GeneratedCard[] {
  return CARDS.filter((card) => card.category === category)
}

/**
 * A category as an attribute value: `'Dark Elixir'` → `'dark-elixir'`.
 *
 * The deck's frame colour is picked in CSS off `[data-deck=…]` rather than being
 * set inline from `CARD_CATEGORY_BORDER`, because a colour that has to work on
 * parchment *and* on dark wood is a theme decision, and every other colour role
 * in this app is declared as a custom property in all three theme scopes. The
 * constant in `shared/` stays the record of the event's nominal frame colours;
 * `--deck-*` in styles.css is what the page actually paints.
 */
export function deckSlug(category: CardCategory): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/** A card plus how many of it a base holds. `count` is 0 for a card it lacks. */
export interface CardHolding {
  card: GeneratedCard
  count: number
}

/**
 * Sparse counts → one entry per card, in id order.
 *
 * The grid always shows all sixty, so the absent-means-zero storage has to be
 * expanded exactly once, here. Ids the card list does not recognise are dropped:
 * they cannot be rendered, and inventing a tile for them would be worse.
 */
export function holdingsFor(inventory: BaseInventory | undefined): CardHolding[] {
  const counts = countMap(inventory)
  return CARDS.map((card) => ({ card, count: counts.get(card.id) ?? 0 }))
}

/** Sparse counts as a map, with anything unusable dropped. */
export function countMap(inventory: BaseInventory | undefined): Map<number, number> {
  const counts = new Map<number, number>()
  for (const entry of inventory?.counts ?? []) {
    if (!BY_ID.has(entry.cardId)) continue
    if (entry.count > 0) counts.set(entry.cardId, entry.count)
  }
  return counts
}

/**
 * Back to the sparse wire shape: only non-zero counts, ascending by id.
 *
 * Zeroes are dropped rather than sent, because the route treats a zero as
 * "delete the row" and a whole-base write already deletes everything first — so
 * sending sixty entries to store nine would be fifty-one no-ops on the wire.
 */
export function toCardCounts(counts: ReadonlyMap<number, number>): CardCount[] {
  return [...counts.entries()]
    .filter(([id, count]) => BY_ID.has(id) && count > 0)
    .sort(([a], [b]) => a - b)
    .map(([cardId, count]) => ({ cardId, count }))
}

/**
 * Clamps a typed count into the range the server will accept.
 *
 * Done on the way in rather than on submit, so the box cannot hold a number that
 * is about to be rejected. Anything unparseable becomes 0 — an empty box means
 * "none", which is the only reading that does not invent a holding.
 */
export function clampCardCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.min(parsed, MAX_CARD_COUNT)
}

/** Whether an id is one the schema and the route will accept. */
export function isCardId(id: number): boolean {
  return Number.isInteger(id) && id >= CARD_ID_MIN && id <= CARD_ID_MAX
}

/** How many distinct cards a base holds, and how many copies in total. */
export function inventorySummary(inventory: BaseInventory | undefined): {
  distinct: number
  total: number
  duplicates: number
} {
  const counts = countMap(inventory)
  let total = 0
  let duplicates = 0
  for (const count of counts.values()) {
    total += count
    // A spare is any copy past the first — the ones a base could trade away.
    if (count > 1) duplicates += count - 1
  }
  return { distinct: counts.size, total, duplicates }
}
