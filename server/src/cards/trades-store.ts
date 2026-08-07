import type { DatabaseSync } from 'node:sqlite'
import {
  MAX_CARD_COUNT,
  MIN_TRADEABLE_COUNT,
  normalizeTag,
  type BaseInventory,
  type CardCategory,
  type TradeRecord,
  type TradeStatus,
} from '@coc/shared'
import { asText, asTextOrNull } from '../row.ts'
import type { CardInventoryStore } from './store.ts'

/**
 * The Trade Tracker's storage — the only code that touches `trades`, and the only
 * code that moves cards between two bases.
 *
 * It lives beside the inventory store rather than in a directory of its own
 * because **completing a trade is one transaction over two tables**: the status
 * change and the four count changes it authorizes have to land together or not at
 * all. A half-applied trade — cards moved, status still pending; or status
 * complete, cards where they were — is the worst outcome available, because the
 * only record of what should have happened is the row that now disagrees with the
 * counts.
 *
 * Two rules are enforced here rather than only at proposal time, and this is the
 * heart of the feature:
 *
 * 1. **Counts are re-read at completion.** The proposal is not trusted. Between
 *    proposing and completing, somebody re-enters a base's counts — that is the
 *    normal way this data changes — and the swap may no longer be honorable.
 * 2. **A base never gives away its last copy** (`MIN_TRADEABLE_COUNT`). If the
 *    giver is down to one, completing would destroy a card its owner still needs,
 *    so the trade is refused with what changed, and nothing is written.
 *
 * What is deliberately *not* re-checked is whether the receiver still lacks the
 * card. See `complete`.
 *
 * 3. **Undoing a trade re-reads the counts too, in the opposite direction**, and
 *    for a different reason than `MIN_TRADEABLE_COUNT`: an undo is not a voluntary
 *    trade, so it may bring a base to zero of a card, but it still has to find the
 *    card it is being asked to give back and room on the other side to receive it.
 *    See `undo`.
 */

/** A proposal, already oriented and validated by the route. */
export interface TradeProposal {
  baseA: string
  baseB: string
  cardFromA: number
  cardFromB: number
  category: CardCategory
}

/**
 * A guarded status change, shared by `complete`/`decline` and `undo`: it succeeds,
 * or refuses leaving nothing written, or loses a state-conflict `R` says which way.
 *
 * `R` is the literal reason for that state conflict — `'alreadyResolved'` for
 * `complete`/`decline`, whose guard is "must still be pending", and `'notComplete'`
 * for `undo`, whose guard is "must still be complete". One shared shape rather than
 * two near-identical ones, since the only thing that differs is that one word.
 */
type TransitionResult<R extends string> =
  | { ok: true; trade: TradeRecord; bases: BaseInventory[] }
  /** No such trade this season — or it vanished between the read and the write. */
  | { ok: false; reason: 'notFound' }
  /** Someone else changed its status first; `trade` is its real current state. */
  | { ok: false; reason: R; trade: TradeRecord }
  /** The current counts can no longer honor it; `message` says what changed. */
  | { ok: false; reason: 'countsChanged'; trade: TradeRecord; message: string }

/** How completing or declining ended. `ok: false` always means nothing was written. */
export type TradeResolution = TransitionResult<'alreadyResolved'>

/** How an undo ended. `ok: false` always means nothing was written. */
export type TradeUndoResolution = TransitionResult<'notComplete'>

export interface TradeStore {
  /**
   * Every trade this season, **pending first**, newest first within each group.
   * Unfiltered by user, like every other card read: a trade is between two people
   * and visible to the whole clan, which is what stops two people acting on it
   * twice.
   */
  list(season: string): TradeRecord[]
  /** One trade, or `undefined`. A trade from another season reads as absent. */
  find(season: string, id: number): TradeRecord | undefined
  /**
   * The pending trade for exactly this swap, if there is one. The route uses it to
   * answer 409 with the existing row rather than letting the unique index throw.
   */
  findPendingSwap(season: string, swap: Omit<TradeProposal, 'category'>): TradeRecord | undefined
  /** Records a proposal as `pending`. Throws on a duplicate pending swap. */
  propose(season: string, proposal: TradeProposal, userId: number): TradeRecord
  /**
   * Marks a trade `declined` and moves nothing. The counts are not even read:
   * declining is a statement about an agreement, not about the cards.
   */
  decline(season: string, id: number, userId: number): TradeResolution
  /**
   * Marks a trade `complete` **and moves the cards**, in one transaction.
   *
   * Base A loses one of `cardFromA` and gains one of `cardFromB`; base B the
   * mirror. Four count changes, one status change, two edit stamps, one commit.
   *
   * **This writes two bases the resolver may not own.** That is not a hole in the
   * owner rule, it is what a mutual agreement means: the *trade record* is the
   * authorization for both writes, and `mayResolveTrade` is what decides the
   * record may be resolved at all. A per-base check here would make every real
   * trade impossible, since no single account owns both sides.
   *
   * Refusals, all leaving the database untouched:
   *
   * - `alreadyResolved` — the status change is a guarded UPDATE, so two
   *   simultaneous completions cannot both apply their cards.
   * - `countsChanged` — a giver no longer holds `MIN_TRADEABLE_COUNT`, or a
   *   receiver is already at `MAX_CARD_COUNT` and cannot take another.
   *
   * The **receiver already holding the card is not a refusal.** The suggester only
   * ever offers a card you do not hold, so the premise of the suggestion has gone
   * — but the premise of the *agreement* has not: each side still hands over one
   * card and receives one, nothing is destroyed, and the receiver's count simply
   * goes to two, which makes that card tradeable onward. Refusing would break a
   * swap two people had agreed to, for a reason they may well know about, and
   * leave them no way to re-propose it (the suggester would never offer it again).
   * The invariant worth protecting is the giver's floor, not the receiver's
   * novelty, so the ceiling is the only thing checked on the receiving side.
   */
  complete(season: string, id: number, userId: number): TradeResolution

  /**
   * Reverses a `complete` trade **and moves the cards back**, in one transaction.
   * Marks it `undone` without touching `resolved_by_user_id` / `resolved_at` — that
   * pair stays the record of who completed it and when; undoing is a third, later
   * event, not a rewrite of the second (see migration v14).
   *
   * The legs are `complete`'s, reversed: base A loses one of `cardFromB` and gains
   * one of `cardFromA`; base B the mirror. Re-validated against the counts as they
   * are *now*, the same "re-read at the moment of the write" rule `complete` itself
   * follows — the trade may have been re-traded since, and the check has to look at
   * what is actually there.
   *
   * `MIN_TRADEABLE_COUNT` does **not** apply here. It exists to stop a *voluntary*
   * trade from destroying a base's last copy; an undo is a correction, not a trade,
   * and is allowed to bring a count to zero — which is the correct sparse-storage
   * representation, not a special case.
   *
   * Refusals, all leaving the database untouched:
   *
   * - `notComplete` — the trade is not currently `complete` (still pending, already
   *   declined, or already undone once). The status change is a guarded UPDATE, so
   *   two simultaneous undos cannot both apply their reversal.
   * - `countsChanged` — a base being asked to give back a card no longer holds one
   *   (it may have been traded away again since completion), or a base receiving a
   *   card back is already at `MAX_CARD_COUNT`.
   */
  undo(season: string, id: number, userId: number): TradeUndoResolution
}

function asInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function asIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return asInt(value)
}

/* Display names are joined on read rather than copied onto the row, so a rename
   cannot leave an old trade credited to a stale name — the same reason the
   inventory joins its attribution. */
const TRADE_SELECT = `
  SELECT t.id, t.season, t.base_a, t.base_b, t.card_from_a, t.card_from_b, t.category,
         t.status, t.proposed_by_user_id, t.proposed_at, t.resolved_by_user_id, t.resolved_at,
         t.undone_by_user_id, t.undone_at,
         p.display_name AS proposed_by, r.display_name AS resolved_by, u.display_name AS undone_by
    FROM trades t
    LEFT JOIN users p ON p.id = t.proposed_by_user_id
    LEFT JOIN users r ON r.id = t.resolved_by_user_id
    LEFT JOIN users u ON u.id = t.undone_by_user_id
`

function toTrade(row: Record<string, unknown>): TradeRecord {
  return {
    id: asInt(row['id']),
    season: asText(row['season']),
    baseA: asText(row['base_a']),
    baseB: asText(row['base_b']),
    cardFromA: asInt(row['card_from_a']),
    cardFromB: asInt(row['card_from_b']),
    // The route is the only writer and validates against CARD_CATEGORIES, so this
    // is a cast rather than a parse. A hand-inserted row is the only way past it.
    category: asText(row['category']) as CardCategory,
    status: asText(row['status']) as TradeRecord['status'],
    proposedByUserId: asIntOrNull(row['proposed_by_user_id']),
    proposedBy: asTextOrNull(row['proposed_by']),
    proposedAt: asText(row['proposed_at']),
    resolvedByUserId: asIntOrNull(row['resolved_by_user_id']),
    resolvedBy: asTextOrNull(row['resolved_by']),
    resolvedAt: asTextOrNull(row['resolved_at']),
    undoneByUserId: asIntOrNull(row['undone_by_user_id']),
    undoneBy: asTextOrNull(row['undone_by']),
    undoneAt: asTextOrNull(row['undone_at']),
  }
}

/** One leg of a completion: who gives up what, and who takes it. */
interface Leg {
  from: string
  to: string
  cardId: number
}

export function createTradeStore(db: DatabaseSync, cards: CardInventoryStore): TradeStore {
  const statements = {
    list: db.prepare(
      `${TRADE_SELECT} WHERE t.season = ?
        -- Pending first: those are the ones anybody can still act on. Newest
        -- first within each group, with the id as a deterministic tiebreak for
        -- two rows written in the same millisecond.
        ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.proposed_at DESC, t.id DESC`,
    ),
    find: db.prepare(`${TRADE_SELECT} WHERE t.season = ? AND t.id = ?`),
    findPending: db.prepare(
      `${TRADE_SELECT} WHERE t.season = ? AND t.base_a = ? AND t.base_b = ?
         AND t.card_from_a = ? AND t.card_from_b = ? AND t.status = 'pending'`,
    ),
    insert: db.prepare(
      `INSERT INTO trades
         (season, base_a, base_b, card_from_a, card_from_b, category, status,
          proposed_by_user_id, proposed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ),
    /* The guarded status change. `AND status = 'pending'` is what makes resolving
       atomic: a second resolver's UPDATE reports zero changes and its whole
       transaction rolls back, rather than both of them moving the same cards. */
    resolve: db.prepare(
      `UPDATE trades SET status = ?, resolved_by_user_id = ?, resolved_at = ?
        WHERE season = ? AND id = ? AND status = 'pending'`,
    ),
    /* The guarded status change for undo. `resolved_by_user_id` / `resolved_at`
       are not touched — they stay the record of who completed the trade, and this
       is a separate, later event with its own columns. `AND status = 'complete'`
       is what makes two simultaneous undos safe, the same way `AND status =
       'pending'` protects `resolve` above. */
    undo: db.prepare(
      `UPDATE trades SET status = 'undone', undone_by_user_id = ?, undone_at = ?
        WHERE season = ? AND id = ? AND status = 'complete'`,
    ),
    countOf: db.prepare(
      'SELECT count FROM card_inventory WHERE season = ? AND player_tag = ? AND card_id = ?',
    ),
    deleteCount: db.prepare(
      'DELETE FROM card_inventory WHERE season = ? AND player_tag = ? AND card_id = ?',
    ),
    upsertCount: db.prepare(
      `INSERT INTO card_inventory
         (season, player_tag, card_id, count, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(season, player_tag, card_id) DO UPDATE SET
         count = excluded.count,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    ),
    /* A completion really does edit both bases' counts, so it moves their edit
       stamps too — otherwise "when was this base last checked" would answer with
       a time before cards left it. Same statement shape as `saveBase`'s. */
    upsertStamp: db.prepare(
      `INSERT INTO card_base_updates (season, player_tag, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(season, player_tag) DO UPDATE SET
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    ),
  }

  function find(season: string, id: number): TradeRecord | undefined {
    const row = statements.find.get(season, id)
    return row ? toTrade(row) : undefined
  }

  function countOf(season: string, tag: string, cardId: number): number {
    return asInt(statements.countOf.get(season, tag, cardId)?.['count'])
  }

  function setCount(
    season: string,
    tag: string,
    cardId: number,
    count: number,
    now: string,
    userId: number,
  ): void {
    // Storage stays sparse — a base holding none of a card has no row, exactly as
    // `saveBase` leaves it — so the floor of zero is a delete, not a stored 0.
    if (count <= 0) {
      statements.deleteCount.run(season, tag, cardId)
      return
    }
    statements.upsertCount.run(season, tag, cardId, count, now, userId)
  }

  /**
   * Why the current counts cannot honor this trade, or `undefined` if they can.
   *
   * The message names the base, the card and the number found now, because "the
   * counts changed" on its own leaves someone staring at a button that does
   * nothing: the useful sentence is which side moved and to what.
   */
  function whyNotHonorable(season: string, trade: TradeRecord): string | undefined {
    const legs: Leg[] = [
      { from: trade.baseA, to: trade.baseB, cardId: trade.cardFromA },
      { from: trade.baseB, to: trade.baseA, cardId: trade.cardFromB },
    ]

    for (const leg of legs) {
      const held = countOf(season, leg.from, leg.cardId)
      if (held < MIN_TRADEABLE_COUNT) {
        return (
          `${leg.from} now holds ${held} ${held === 1 ? 'copy' : 'copies'} of card ${leg.cardId}, ` +
          `not the ${MIN_TRADEABLE_COUNT} a base needs before it can give one away. ` +
          'Its counts have changed since this trade was proposed, so completing it would ' +
          'take away a card that base still needs. Nothing was moved.'
        )
      }

      const receiving = countOf(season, leg.to, leg.cardId)
      if (receiving >= MAX_CARD_COUNT) {
        return (
          `${leg.to} already holds the maximum ${MAX_CARD_COUNT} of card ${leg.cardId}, ` +
          'so it cannot take another. Nothing was moved.'
        )
      }
    }

    return undefined
  }

  /**
   * Why the current counts cannot honor giving these two cards back, or `undefined`
   * if they can. `complete`'s legs, reversed: a base that received a card during
   * completion is the one asked to give it back now.
   *
   * `MIN_TRADEABLE_COUNT` does not appear here — see `undo`'s doc comment for why:
   * an undo is a correction, not a trade, and is allowed to bring a base to zero.
   * What it still cannot do is give back a card the base does not hold at all, or
   * hand one to a base that has no room left for it.
   */
  function whyNotUndoable(season: string, trade: TradeRecord): string | undefined {
    const legs: Leg[] = [
      { from: trade.baseB, to: trade.baseA, cardId: trade.cardFromA },
      { from: trade.baseA, to: trade.baseB, cardId: trade.cardFromB },
    ]

    for (const leg of legs) {
      const held = countOf(season, leg.from, leg.cardId)
      if (held < 1) {
        return (
          `${leg.from} now holds ${held} ${held === 1 ? 'copy' : 'copies'} of card ${leg.cardId}, ` +
          'so it has none to give back — it must have been traded away again since this ' +
          'trade completed. Nothing was moved.'
        )
      }

      const receiving = countOf(season, leg.to, leg.cardId)
      if (receiving >= MAX_CARD_COUNT) {
        return (
          `${leg.to} already holds the maximum ${MAX_CARD_COUNT} of card ${leg.cardId}, ` +
          'so it cannot take another. Nothing was moved.'
        )
      }
    }

    return undefined
  }

  /**
   * The shape every guarded status change shares: read the trade, guard the change
   * against a required current status, optionally move the cards, commit or roll
   * the whole thing back. `complete`, `decline` and `undo` are three callers of
   * this with different guards, different columns and, for `complete` and `undo`,
   * different card movement — the transaction shape underneath is identical.
   *
   * `apply` runs **inside** the transaction, after the guarded UPDATE has proved
   * this caller is the one changing it, and may still refuse — which rolls back the
   * status change with it, so a refusal always leaves the database exactly as it
   * found it.
   *
   * `runGuardedUpdate` is the caller's own `UPDATE ... WHERE status = <required>`,
   * already bound to its own columns; this function only reads its `changes` count
   * to tell a successful change from a race lost to somebody else's write.
   */
  function transition<R extends string>(
    season: string,
    id: number,
    requiredStatus: TradeStatus,
    conflictReason: R,
    runGuardedUpdate: (now: string) => number | bigint,
    apply?: (trade: TradeRecord, now: string) => string | undefined,
  ): TransitionResult<R> {
    const existing = find(season, id)
    if (!existing) return { ok: false, reason: 'notFound' }
    if (existing.status !== requiredStatus) {
      return { ok: false, reason: conflictReason, trade: existing }
    }

    const now = new Date().toISOString()

    db.exec('BEGIN')
    try {
      const changed = runGuardedUpdate(now)
      if (Number(changed) !== 1) {
        // Somebody changed its status between the read above and this write.
        db.exec('ROLLBACK')
        const current = find(season, id)
        return current
          ? { ok: false, reason: conflictReason, trade: current }
          : { ok: false, reason: 'notFound' }
      }

      const problem = apply?.(existing, now)
      if (problem) {
        db.exec('ROLLBACK')
        return { ok: false, reason: 'countsChanged', trade: existing, message: problem }
      }

      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      throw cause
    }

    const resolved = find(season, id)
    // Unreachable: the row was just updated inside a committed transaction.
    if (!resolved) return { ok: false, reason: 'notFound' }

    return {
      ok: true,
      trade: resolved,
      bases: [
        cards.getInventory(season, resolved.baseA),
        cards.getInventory(season, resolved.baseB),
      ],
    }
  }

  return {
    list(season) {
      return statements.list.all(season).map(toTrade)
    },

    find,

    findPendingSwap(season, swap) {
      const row = statements.findPending.get(
        season,
        normalizeTag(swap.baseA),
        normalizeTag(swap.baseB),
        swap.cardFromA,
        swap.cardFromB,
      )
      return row ? toTrade(row) : undefined
    },

    propose(season, proposal, userId) {
      const baseA = normalizeTag(proposal.baseA)
      const baseB = normalizeTag(proposal.baseB)
      const now = new Date().toISOString()

      const inserted = statements.insert.run(
        season,
        baseA,
        baseB,
        proposal.cardFromA,
        proposal.cardFromB,
        proposal.category,
        userId,
        now,
      )

      const trade = find(season, Number(inserted.lastInsertRowid))
      if (!trade) throw new Error('the trade just inserted could not be read back')
      return trade
    },

    decline(season, id, userId) {
      return transition(season, id, 'pending', 'alreadyResolved', (now) =>
        statements.resolve.run('declined', userId, now, season, id).changes,
      )
    },

    complete(season, id, userId) {
      return transition(
        season,
        id,
        'pending',
        'alreadyResolved',
        (now) => statements.resolve.run('complete', userId, now, season, id).changes,
        (trade, now) => {
          // Re-validated here, inside the transaction, against the counts as they
          // are *now* — never against the proposal, which may be days old.
          const problem = whyNotHonorable(season, trade)
          if (problem) return problem

          const legs: Leg[] = [
            { from: trade.baseA, to: trade.baseB, cardId: trade.cardFromA },
            { from: trade.baseB, to: trade.baseA, cardId: trade.cardFromB },
          ]

          for (const leg of legs) {
            const giving = countOf(season, leg.from, leg.cardId)
            const taking = countOf(season, leg.to, leg.cardId)
            setCount(season, leg.from, leg.cardId, giving - 1, now, userId)
            setCount(season, leg.to, leg.cardId, taking + 1, now, userId)
          }

          for (const tag of [trade.baseA, trade.baseB]) {
            statements.upsertStamp.run(season, tag, now, userId)
          }

          return undefined
        },
      )
    },

    undo(season, id, userId) {
      return transition(
        season,
        id,
        'complete',
        'notComplete',
        (now) => statements.undo.run(userId, now, season, id).changes,
        (trade, now) => {
          // Re-validated here, inside the transaction, against the counts as they
          // are *now* — the same "never trust the read that happened before the
          // write" rule `complete` follows above.
          const problem = whyNotUndoable(season, trade)
          if (problem) return problem

          // `complete`'s legs, reversed: A gives back what it received (cardFromB)
          // and gets back what it gave (cardFromA); B the mirror.
          const legs: Leg[] = [
            { from: trade.baseB, to: trade.baseA, cardId: trade.cardFromA },
            { from: trade.baseA, to: trade.baseB, cardId: trade.cardFromB },
          ]

          for (const leg of legs) {
            const giving = countOf(season, leg.from, leg.cardId)
            const taking = countOf(season, leg.to, leg.cardId)
            setCount(season, leg.from, leg.cardId, giving - 1, now, userId)
            setCount(season, leg.to, leg.cardId, taking + 1, now, userId)
          }

          // Undo edits both bases' counts too, so their edit stamps move with it —
          // same reasoning as `complete`'s.
          for (const tag of [trade.baseA, trade.baseB]) {
            statements.upsertStamp.run(season, tag, now, userId)
          }

          return undefined
        },
      )
    },
  }
}
