import type { BaseInventory, CardCategory } from './card-types.ts'

/**
 * The Trade Tracker, as it crosses the wire.
 *
 * A *suggestion* (`web/src/card-trades.ts`) is computed from the shared
 * inventories and is ephemeral — a list of swaps that would help, recomputed
 * every time the counts change. A **trade** is what two people have agreed to
 * act on: one stored row, visible to everybody, that either party can mark
 * complete or declined. Completing one is what actually moves the cards.
 *
 * Like every other card row these are **shared, not per-user**: two people
 * looking at the same pending trade have to see the same thing, or "did you do
 * that swap?" has two answers.
 */

/**
 * A trade's life: proposed, then resolved exactly once.
 *
 * There is no `canceled` distinct from `declined`. Either party — and an admin
 * — may resolve a trade, so "I have changed my mind" and "no thanks" are the
 * same event with the same consequence (nothing moves), and `resolvedBy` says
 * which side it came from.
 */
export type TradeStatus = 'pending' | 'complete' | 'declined'

/** Restated as a `CHECK` in the schema (migration v7). */
export const TRADE_STATUSES: readonly TradeStatus[] = ['pending', 'complete', 'declined']

/**
 * The fewest copies a base must hold to give one away: **two**.
 *
 * This is the one invariant the tracker really protects. A base that trades away
 * its last copy has lost a card rather than swapped one, and the event scores
 * distinct cards, so it is a strictly worse position than before. It is checked
 * again at completion against the *current* counts, not the ones the proposal was
 * drawn from — see `TradeResolveRefusal`.
 */
export const MIN_TRADEABLE_COUNT = 2

/**
 * One stored trade.
 *
 * Orientation is canonical: `baseA` is the lexicographically smaller tag, the
 * same way `suggestTrades` orients its output, so the same swap proposed from
 * either side is one row rather than two mirror images.
 *
 * The user columns come in pairs — an id for identity and a display name for the
 * screen. Both are nullable because the account may be gone (`ON DELETE SET
 * NULL`): a resolved trade has to survive the account that resolved it being
 * deleted, since it is the record of a swap that really happened.
 */
export interface TradeRecord {
  id: number
  /** `CARD_SEASON` at the time it was proposed. Never taken from a request. */
  season: string
  /** Canonical `#TAG`, lexicographically smaller than `baseB`. Gives `cardFromA`. */
  baseA: string
  baseB: string
  /** Travels A → B. */
  cardFromA: number
  /** Travels B → A. */
  cardFromB: number
  /**
   * The deck both cards belong to, as the proposing client reported it.
   *
   * Recorded for display and grouping, **not** enforced: the card id → category
   * map is generated into `web/`, so the server cannot check that two ids really
   * share a deck. It validates the value is one of the four and nothing more.
   */
  category: CardCategory
  status: TradeStatus
  proposedByUserId: number | null
  /** Display name of the proposer; `null` if that account is gone. */
  proposedBy: string | null
  proposedAt: string
  /** Who marked it complete or declined. `null` while pending. */
  resolvedByUserId: number | null
  resolvedBy: string | null
  /**
   * When it was resolved — the audit half of "who and when", shown beside the
   * trade. `null` exactly while the status is `pending`, which the schema checks.
   */
  resolvedAt: string | null
}

export interface TradesResponse {
  season: string
  trades: TradeRecord[]
}

/** What `POST /api/cards/trades` accepts. The season is the server's. */
export interface ProposeTradeRequest {
  baseA: string
  baseB: string
  cardFromA: number
  cardFromB: number
  category: CardCategory
}

export interface TradeResponse {
  season: string
  trade: TradeRecord
}

/**
 * What resolving answers with: the trade in its new state, plus **both** bases'
 * current counts.
 *
 * The bases are included on a decline as well as a completion, and are the state
 * *after* the write, so a client can refresh two bases from one response rather
 * than re-reading the whole inventory to find out what a completion did.
 */
export interface ResolveTradeResponse extends TradeResponse {
  bases: BaseInventory[]
}
