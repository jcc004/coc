/**
 * The August card-collecting event, as it crosses the wire.
 *
 * Like saved clans and owner assignments, an inventory row is **shared, not
 * per-user**: a base's card counts are a fact about that base, and ten people
 * keeping private copies would give ten disagreeing answers to "can we trade".
 * There is no API for any of this — Supercell exposes nothing about the event —
 * so every count is typed in by hand.
 */

/**
 * The season every row is scoped to. **One line to change next August.**
 *
 * Without it, next year's counts would merge silently into this year's and the
 * trade suggestions would be drawn from a mix of two events. There is
 * deliberately no season-switching UI: the constant is the switch.
 */
export const CARD_SEASON = '2026-08'

/**
 * Card ids run 1…60 contiguously, matching `web/public/coc/cards/manifest.json`
 * and the generated `web/src/cards.generated.ts`.
 *
 * The upper bound is repeated as a `CHECK` in the schema (migration v4), so
 * raising it needs a migration as well as a re-run of the card generator.
 */
export const CARD_ID_MIN = 1
export const CARD_ID_MAX = 60

/** The most copies of one card a base can record. */
export const MAX_CARD_COUNT = 10

/**
 * The four decks the event ships. Fixed by the manifest, not by the API, so a
 * new category next year is a manifest change and a change here.
 */
export type CardCategory = 'Elixir' | 'Dark Elixir' | 'Builder Base' | 'Super Troop'

export const CARD_CATEGORIES: readonly CardCategory[] = [
  'Elixir',
  'Dark Elixir',
  'Builder Base',
  'Super Troop',
]

/**
 * The frame colour each deck draws its cards in — the border that tells two
 * cards sharing one piece of art apart (the home and Builder Base Baby Dragons
 * use the same picture but sit in the pink and blue decks respectively).
 *
 * It is a property of the *category*, not the card, so it lives here as one entry
 * per deck rather than being stamped onto all sixty cards in the manifest. Values
 * are sampled from the event's card frames. The grid uses them for the tile
 * border and any deck-tinted chrome.
 */
export const CARD_CATEGORY_BORDER: Readonly<Record<CardCategory, string>> = {
  Elixir: '#EB56F1',
  'Dark Elixir': '#6D1E92',
  'Builder Base': '#4CA7F1',
  'Super Troop': '#F07951',
}

/** One non-zero holding. An id absent from a base's list means zero copies. */
export interface CardCount {
  cardId: number
  count: number
}

/**
 * One base's holdings for the current season.
 *
 * `counts` is **sparse and ascending by `cardId`** — only cards the base
 * actually holds appear, so an empty base is an empty array rather than sixty
 * zeroes.
 *
 * `updatedAt` / `updatedBy` are recorded on **every** save, in their own table
 * (`card_base_updates`, migration v5) rather than derived from the count rows.
 * That is deliberate: counts are sparse, so a base cleared back to zero has no
 * count rows left, and a stamp derived from them would vanish for exactly the
 * base most likely to prompt "when did we last check this one?". They are absent
 * only for a base nobody has ever saved.
 */
export interface BaseInventory {
  /** Canonical `#TAG`. */
  tag: string
  counts: CardCount[]
  updatedAt?: string
  /** Display name of whoever last wrote it; `null` if that account is gone. */
  updatedBy?: string | null
}

export interface CardInventoryResponse {
  season: string
  bases: BaseInventory[]
}

export interface BaseInventoryResponse {
  season: string
  base: BaseInventory
}

/** What a whole-base write sends. One request per base, never one per card. */
export interface SaveBaseInventoryRequest {
  counts: CardCount[]
}
