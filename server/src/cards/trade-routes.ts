import type { Hono } from 'hono'
import {
  CARD_CATEGORIES,
  CARD_ID_MAX,
  CARD_ID_MIN,
  CARD_SEASON,
  MIN_TRADEABLE_COUNT,
  normalizeTag,
  type CardCategory,
} from '@coc/shared'
import { currentUser, type AuthContext, type AuthEnv } from '../auth/middleware.ts'
import { errorBody } from '../http.ts'
import { ownershipOf, type BaseOwnerLookup } from './routes.ts'
import {
  mayProposeTrade,
  mayResolveTrade,
  mayUndoTrade,
  orientTrade,
  type TradeSides,
} from './trade-access.ts'
import type { TradeProposal, TradeStore } from './trades-store.ts'

/**
 * `/api/cards/trades/*` — the Trade Tracker.
 *
 * Authentication is not re-checked here: `/api/*` is deny-by-default in
 * `createApp` and none of these paths is on the public list, so every route is
 * reachable only with a session and `currentUser(c)` cannot be null.
 *
 * The authorization, in one place so it can be read at a glance:
 *
 * | route | who |
 * | --- | --- |
 * | `GET /api/cards/trades` | every signed-in user |
 * | `POST /api/cards/trades` | an admin, or the owner of **either** base |
 * | `POST /api/cards/trades/:id/complete` | an admin, or the owner of either base |
 * | `POST /api/cards/trades/:id/decline` | an admin, or the owner of either base |
 * | `POST /api/cards/trades/:id/undo` | **an admin only** — no party exception |
 *
 * The three decisions are `mayProposeTrade` / `mayResolveTrade` / `mayUndoTrade` in
 * `trade-access.ts` — pure functions with their own tests — so these handlers
 * decide nothing on their own, exactly as the inventory write defers to
 * `mayWriteBaseCounts`.
 *
 * Note the **inversion** against the inventory route: there, ownership is checked
 * before the body is even parsed, because whether you may write a base has nothing
 * to do with your payload. Here the body *names the two bases*, so it has to be
 * parsed and validated before there is anything to authorize against. A malformed
 * proposal is therefore a 400, not a 403.
 *
 * The season is **not** taken from the request. It is `CARD_SEASON`, one constant
 * in `shared/`, the same rule the inventory routes follow, and it is echoed in
 * every response.
 */

async function readJson(c: AuthContext): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function isCategory(value: unknown): value is CardCategory {
  return typeof value === 'string' && (CARD_CATEGORIES as readonly string[]).includes(value)
}

/**
 * The whole proposal, or the first thing wrong with it.
 *
 * `normalizeTag` is allowed to throw: `InvalidTagError` falls through to the app's
 * error handler, which already answers 400 with the tag rule as a hint, and that
 * is a better message than anything restated here.
 *
 * Orientation happens **after** validation, so the stored row is canonical (the
 * smaller tag as `baseA`, its card with it) however the client sent it. That is
 * what makes one agreement one row rather than two mirror images.
 */
function parseProposal(raw: Record<string, unknown>): { proposal: TradeProposal } | { problem: string } {
  const cardOf = (key: string): number | string => {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `${key} must be a whole number, got ${JSON.stringify(value)}.`
    }
    if (value < CARD_ID_MIN || value > CARD_ID_MAX) {
      return `${key} ${value} is outside ${CARD_ID_MIN}–${CARD_ID_MAX}.`
    }
    return value
  }

  if (typeof raw['baseA'] !== 'string' || typeof raw['baseB'] !== 'string') {
    return { problem: 'A trade needs baseA and baseB, the two base tags swapping.' }
  }

  const cardFromA = cardOf('cardFromA')
  if (typeof cardFromA === 'string') return { problem: cardFromA }
  const cardFromB = cardOf('cardFromB')
  if (typeof cardFromB === 'string') return { problem: cardFromB }

  if (!isCategory(raw['category'])) {
    return {
      problem: `category must be one of ${CARD_CATEGORIES.join(', ')}, got ${JSON.stringify(
        raw['category'],
      )}.`,
    }
  }

  const baseA = normalizeTag(raw['baseA'])
  const baseB = normalizeTag(raw['baseB'])
  if (baseA === baseB) {
    return { problem: `${baseA} cannot trade with itself — a trade is between two bases.` }
  }
  if (cardFromA === cardFromB) {
    return {
      problem: `Both sides are giving card ${cardFromA}, which would move nothing. A swap trades two different cards.`,
    }
  }

  return {
    proposal: orientTrade({ baseA, baseB, cardFromA, cardFromB, category: raw['category'] }),
  }
}

/** Both sides of a stored or proposed trade, as the owner column reports them. */
function sidesOf(owners: BaseOwnerLookup, baseA: string, baseB: string): TradeSides {
  return { baseA: ownershipOf(owners, baseA), baseB: ownershipOf(owners, baseB) }
}

/** The `:id` path segment as a positive integer, or `undefined` if it is not one. */
function tradeId(raw: string | undefined): number | undefined {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function mountTradeRoutes(
  app: Hono<AuthEnv>,
  trades: TradeStore,
  owners: BaseOwnerLookup,
): void {
  /**
   * Readable by every authenticated user, like the rest of the shared card data.
   * A trade is between two people and everybody can see it, which is what stops
   * the same swap being agreed twice in two conversations.
   */
  app.get('/api/cards/trades', (c) =>
    c.json({ season: CARD_SEASON, trades: trades.list(CARD_SEASON) }),
  )

  /**
   * Propose a swap. An admin, or the owner of either base — one side meaning it is
   * enough to record it, but a member cannot invent trades between two other
   * people's bases.
   *
   * The counts are deliberately **not** re-validated here. They are hand-entered
   * and routinely lag the game, so someone who has just seen the cards knows more
   * than the table does, and refusing the proposal would only push the
   * disagreement into a conversation nobody can see. Completion is where the
   * invariant is enforced, against the counts as they are at that moment.
   */
  app.post('/api/cards/trades', async (c) => {
    const parsed = parseProposal(await readJson(c))
    if ('problem' in parsed) {
      return c.json(
        errorBody(400, 'badRequest', parsed.problem, 'Nothing was proposed.'),
        400,
      )
    }

    const { proposal } = parsed
    const decision = mayProposeTrade(
      currentUser(c),
      sidesOf(owners, proposal.baseA, proposal.baseB),
    )
    if (!decision.allowed) {
      return c.json(
        errorBody(
          403,
          'forbidden',
          decision.message,
          'A trade is proposed by one of the two sides, or by an admin. Nothing was proposed.',
        ),
        403,
      )
    }

    // The same swap proposed twice is one agreement, so the second attempt is
    // answered with the first row rather than a second pending copy of it. The
    // partial unique index in migration v7 is what makes that a guarantee.
    const existing = trades.findPendingSwap(CARD_SEASON, proposal)
    if (existing) {
      return c.json(
        {
          ...errorBody(
            409,
            'alreadyProposed',
            `That swap is already proposed and pending as trade ${existing.id}.`,
            'Complete or decline the existing trade instead.',
          ),
          trade: existing,
        },
        409,
      )
    }

    return c.json(
      { season: CARD_SEASON, trade: trades.propose(CARD_SEASON, proposal, currentUser(c).id) },
      201,
    )
  })

  /**
   * Complete and decline, which share everything but the verb.
   *
   * `resolve` is the store call; the two differ only in whether the cards move.
   * Both refuse a trade that is already resolved rather than re-applying it, and
   * both answer with the trade in its new state **and both bases' current counts**,
   * so a client can refresh two bases from one response.
   */
  const resolveRoute = (
    path: string,
    act: (id: number, userId: number) => ReturnType<TradeStore['complete']>,
  ) =>
    app.post(path, (c) => {
      const id = tradeId(c.req.param('id'))
      if (id === undefined) {
        return c.json(errorBody(400, 'badRequest', 'A trade id is a positive whole number.'), 400)
      }

      const trade = trades.find(CARD_SEASON, id)
      if (!trade) {
        return c.json(errorBody(404, 'notFound', `No trade ${id} in season ${CARD_SEASON}.`), 404)
      }

      const decision = mayResolveTrade(
        currentUser(c),
        trade,
        sidesOf(owners, trade.baseA, trade.baseB),
      )
      if (!decision.allowed) {
        // Already-resolved is a state conflict, not a permission problem, so it
        // gets 409 — a client must not treat it as "sign in as somebody else".
        const status = decision.refusal === 'alreadyResolved' ? 409 : 403
        return c.json(
          {
            ...errorBody(
              status,
              status === 409 ? 'alreadyResolved' : 'forbidden',
              decision.message,
              'Nothing was changed.',
            ),
            trade,
          },
          status,
        )
      }

      const result = act(id, currentUser(c).id)
      if (!result.ok) {
        if (result.reason === 'notFound') {
          return c.json(errorBody(404, 'notFound', `No trade ${id} in season ${CARD_SEASON}.`), 404)
        }
        if (result.reason === 'alreadyResolved') {
          return c.json(
            {
              ...errorBody(
                409,
                'alreadyResolved',
                `Trade ${id} was marked ${result.trade.status} by ${
                  result.trade.resolvedBy ?? 'another member'
                } first. Nothing was changed.`,
              ),
              trade: result.trade,
            },
            409,
          )
        }

        return c.json(
          {
            ...errorBody(
              409,
              'countsChanged',
              result.message,
              `A base must hold at least ${MIN_TRADEABLE_COUNT} of a card before it can give one away.`,
            ),
            trade: result.trade,
          },
          409,
        )
      }

      return c.json({ season: CARD_SEASON, trade: result.trade, bases: result.bases })
    })

  resolveRoute('/api/cards/trades/:id/complete', (id, userId) =>
    trades.complete(CARD_SEASON, id, userId),
  )
  resolveRoute('/api/cards/trades/:id/decline', (id, userId) =>
    trades.decline(CARD_SEASON, id, userId),
  )

  /**
   * Undo a completed trade. **Admin only, no party exception** — `mayUndoTrade`
   * says why: this reopens a record that already closed rather than making the
   * first decision about an open one, so it does not get `resolveRoute`'s
   * party-or-admin shape. The refusal reasons differ too (`notAdmin`/`notComplete`
   * rather than `forbidden`/`alreadyResolved`), which is the other reason this is
   * its own route rather than a third call to `resolveRoute`.
   *
   * Same 409-for-state-conflict / 403-for-not-permitted split as `resolveRoute`:
   * `notComplete` means somebody else already changed what this trade is, which a
   * client must not treat as "sign in as somebody else".
   */
  app.post('/api/cards/trades/:id/undo', (c) => {
    const id = tradeId(c.req.param('id'))
    if (id === undefined) {
      return c.json(errorBody(400, 'badRequest', 'A trade id is a positive whole number.'), 400)
    }

    const trade = trades.find(CARD_SEASON, id)
    if (!trade) {
      return c.json(errorBody(404, 'notFound', `No trade ${id} in season ${CARD_SEASON}.`), 404)
    }

    const decision = mayUndoTrade(currentUser(c), trade)
    if (!decision.allowed) {
      const status = decision.refusal === 'notComplete' ? 409 : 403
      return c.json(
        {
          ...errorBody(
            status,
            status === 409 ? 'notComplete' : 'forbidden',
            decision.message,
            'Nothing was changed.',
          ),
          trade,
        },
        status,
      )
    }

    const result = trades.undo(CARD_SEASON, id, currentUser(c).id)
    if (!result.ok) {
      if (result.reason === 'notFound') {
        return c.json(errorBody(404, 'notFound', `No trade ${id} in season ${CARD_SEASON}.`), 404)
      }
      if (result.reason === 'notComplete') {
        return c.json(
          {
            ...errorBody(
              409,
              'notComplete',
              `Trade ${id} is ${result.trade.status}, not complete, so there is nothing to undo.`,
              'Nothing was changed.',
            ),
            trade: result.trade,
          },
          409,
        )
      }

      return c.json(
        {
          ...errorBody(
            409,
            'countsChanged',
            result.message,
            'A base must hold the card it is being asked to give back, with room on the other side to receive its own back.',
          ),
          trade: result.trade,
        },
        409,
      )
    }

    return c.json({ season: CARD_SEASON, trade: result.trade, bases: result.bases })
  })
}
