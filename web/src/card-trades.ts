import { MAX_CHAT_LENGTH, type BaseInventory, type CardCategory } from '@coc/shared'

/**
 * Which two bases should swap which two cards.
 *
 * This is the only part of the card feature with real rules in it, so it is a
 * pure module with its own tests and no knowledge of React, the server, or the
 * generated card list. Categories arrive through a resolver rather than an
 * import, which is what lets the tests exercise the rules against three made-up
 * cards instead of sixty real ones.
 *
 * A trade is a **swap**, not a gift: both sides give one card and receive one.
 * The four rules, and why each is there:
 *
 * 1. **The giver must hold 2 or more.** A base never trades away its last copy —
 *    that would be losing a card, not swapping one. A count of exactly 1 is
 *    therefore not tradeable, which is the rule people get wrong by hand.
 * 2. **The receiver must hold zero.** There is no point receiving a card you
 *    already have; the event rewards distinct cards, so a second copy of
 *    something you hold once is worth nothing to you.
 * 3. **Same category.** The game only swaps within a deck, so an Elixir card
 *    cannot be traded for a Dark Elixir one however well the counts line up.
 * 4. **Different bases.** A base cannot trade with itself, including when the
 *    same tag appears twice in the input.
 *
 * Rule 1 and rule 2 together make `X === Y` impossible without a special case:
 * A would need 2 or more of X while B has none of it, *and* B would need 2 or
 * more of the same X. There is a test for that rather than a comment alone.
 */

/** One swap: A gives `cardFromA`, B gives `cardFromB`, both in `category`. */
export interface TradeSuggestion {
  /** The lexicographically smaller of the two tags. See `suggestTrades`. */
  baseA: string
  baseB: string
  /** A holds 2+ of this and B holds none. Travels A → B. */
  cardFromA: number
  /** B holds 2+ of this and A holds none. Travels B → A. */
  cardFromB: number
  category: CardCategory
}

/** Resolves a card id to its deck. `undefined` for an id the caller does not know. */
export type CategoryResolver = (cardId: number) => CardCategory | undefined

interface Holdings {
  tag: string
  /** Only positive counts; an absent id means the base holds none. */
  counts: Map<number, number>
}

/**
 * Sparse wire counts → a lookup, dropping anything that cannot mean a holding.
 *
 * A non-positive count is treated as absent so that a 0 which somehow survived
 * the route reads as "does not own", not as a distinct third state. A repeated
 * id keeps the **largest** value rather than the last: with no way to tell which
 * the user meant, the reading that risks suggesting a trade the base cannot
 * honour is the wrong one — but the larger count is also the one that matches
 * "how many are actually on the screen they copied", and a suggestion is only a
 * suggestion.
 */
function toHoldings(base: BaseInventory): Holdings {
  const counts = new Map<number, number>()
  for (const entry of base.counts) {
    if (!Number.isInteger(entry.cardId)) continue
    if (!Number.isFinite(entry.count) || entry.count <= 0) continue
    counts.set(entry.cardId, Math.max(counts.get(entry.cardId) ?? 0, entry.count))
  }
  return { tag: base.tag, counts }
}

/** The cards a base can give away: everything it holds two or more of. */
function spares(holdings: Holdings): number[] {
  return [...holdings.counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([cardId]) => cardId)
    .sort((a, b) => a - b)
}

/**
 * Every swap available across `bases`, deduplicated and in a stable order.
 *
 * **Mirrors are reported once.** A↔B and B↔A are the same trade seen from two
 * sides, so each unordered pair of bases is considered exactly once and the
 * result is always oriented with the lexicographically smaller tag as `baseA`.
 * That makes the output independent of the order the bases were passed in,
 * which is the property the tests pin down.
 *
 * One pair can yield several suggestions, and one spare card can appear in
 * suggestions with several partners. That is intended: these are options to
 * choose between, not a plan. Committing to one does not invalidate the others
 * until the counts are re-entered, at which point the list is recomputed.
 */
export function suggestTrades(
  bases: BaseInventory[],
  categoryOf: CategoryResolver,
): TradeSuggestion[] {
  const all = bases.map(toHoldings)
  const suggestions: TradeSuggestion[] = []

  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const left = all[i]
      const right = all[j]
      if (!left || !right) continue
      // Rule 4. Two entries for one tag are one base, however they got here.
      if (left.tag === right.tag) continue

      // Orientation by tag, not by position, so the output does not depend on
      // the order the caller happened to hand the bases over in.
      const [a, b] = left.tag < right.tag ? [left, right] : [right, left]

      for (const cardFromA of spares(a)) {
        // Rule 2, for the card A is giving.
        if ((b.counts.get(cardFromA) ?? 0) > 0) continue
        const category = categoryOf(cardFromA)
        if (category === undefined) continue

        for (const cardFromB of spares(b)) {
          // Rule 2 again, mirrored.
          if ((a.counts.get(cardFromB) ?? 0) > 0) continue
          // Rule 3.
          if (categoryOf(cardFromB) !== category) continue

          suggestions.push({ baseA: a.tag, baseB: b.tag, cardFromA, cardFromB, category })
        }
      }
    }
  }

  return suggestions.sort(
    (x, y) =>
      x.baseA.localeCompare(y.baseA) ||
      x.baseB.localeCompare(y.baseB) ||
      x.cardFromA - y.cardFromA ||
      x.cardFromB - y.cardFromB,
  )
}

/**
 * The same suggestions, collected under the pair of bases they involve.
 *
 * The flat list is the tested thing; this is presentation, because "these two
 * should talk, and here are the four ways" is what someone actually acts on,
 * rather than four rows repeating the same two tags.
 */
export interface TradePair {
  baseA: string
  baseB: string
  trades: TradeSuggestion[]
}

/**
 * The chat message that proposes one swap.
 *
 * Exactly four things, and nothing else:
 *
 * ```
 * <member> gives <card> <-> <member> gives <card>
 * ```
 *
 * No category prefix and no full stop, by request. The category is not in the
 * text because the swap already names two cards that a reader can see are in the
 * same deck, and the sentence is going into a chat box a human will edit before
 * sending — the shorter it is, the less there is to tidy.
 *
 * **It names members, not owners.** That is a deliberate trade: the message now
 * says which two *bases* should swap rather than which two *people* to contact,
 * so an owner who plays a base under another name is no longer identified. What
 * it buys is a line that reads as a sentence about two players, which is what
 * gets pasted into a clan chat. The owner is still on screen in the suggestion
 * table next to the button, so the person is one glance away.
 *
 * Pure, and here rather than in the component, because it has rules: member names
 * are unbounded free text — they come off a live roster — so "it will obviously
 * fit" is not a safe assumption, and an over-long body is a 400 from the chat
 * route and a button that looks broken.
 *
 * It degrades in a deliberate order:
 *
 * 1. **fall back to the tags**, which are bounded (`#` plus 3–12 characters) and
 *    are the identity the counts and the trades are keyed on anyway. The message
 *    is poorer — you have to look a tag up — but every word of it is still true;
 * 2. only then **truncate**, with an ellipsis, so what is left is visibly
 *    incomplete rather than a shorter claim about a different trade.
 *
 * Nothing here posts anything — the caller fills the composer and the user presses
 * Send — so even a clipped message is read by a human before it goes anywhere.
 */
export interface TradeMessageContext {
  /** Card id → display name. An unknown id falls back to `card <n>`. */
  cardName: (cardId: number) => string | undefined
  /**
   * Base tag → the member name it answers to, from the same resolver the rest of
   * the page names bases with (`baseOptions` in `base-names.ts`). A tag no roster
   * we can see names falls back to the tag, because an empty name in the sentence
   * would be worse than an unfriendly one.
   */
  member?: (tag: string) => string | undefined
  /** Defaults to the chat's own limit. */
  maxLength?: number
}

export function tradeProposalMessage(
  trade: TradeSuggestion,
  { cardName, member, maxLength = MAX_CHAT_LENGTH }: TradeMessageContext,
): string {
  const named = (cardId: number) => cardName(cardId)?.trim() || `card ${cardId}`
  const cardA = named(trade.cardFromA)
  const cardB = named(trade.cardFromB)

  const build = (withNames: boolean) => {
    const side = (tag: string) => {
      const who = withNames ? member?.(tag)?.trim() : ''
      return who || tag
    }
    return `${side(trade.baseA)} gives ${cardA} <-> ${side(trade.baseB)} gives ${cardB}`
  }

  const full = build(true)
  if (full.length <= maxLength) return full

  const withTags = build(false)
  if (withTags.length <= maxLength) return withTags

  // The first base and what it gives are still in the prefix, and the ellipsis
  // says the rest is missing, so a truncated message is a poor one rather than a
  // misleading one.
  return `${withTags.slice(0, Math.max(0, maxLength - 1))}…`
}

export function groupTradesByPair(suggestions: TradeSuggestion[]): TradePair[] {
  const pairs = new Map<string, TradePair>()

  for (const suggestion of suggestions) {
    const key = `${suggestion.baseA} ${suggestion.baseB}`
    let pair = pairs.get(key)
    if (!pair) {
      pair = { baseA: suggestion.baseA, baseB: suggestion.baseB, trades: [] }
      pairs.set(key, pair)
    }
    pair.trades.push(suggestion)
  }

  return [...pairs.values()]
}
