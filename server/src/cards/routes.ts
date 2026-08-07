import type { Hono } from 'hono'
import {
  CARD_ID_MAX,
  CARD_ID_MIN,
  CARD_SEASON,
  MAX_CARD_COUNT,
  normalizeTag,
  type CardCount,
  type OwnerRecord,
} from '@coc/shared'
import { currentUser, type AuthEnv } from '../auth/middleware.ts'
import { errorBody, readJson } from '../http.ts'
import type { CardInventoryStore } from './store.ts'
import { mayWriteBaseCounts, writeForbiddenBody, type BaseOwnership } from './write-access.ts'

/**
 * `/api/cards/*` — reading and writing the shared card inventory.
 *
 * Authentication is not re-checked here: `/api/*` is deny-by-default in
 * `createApp` and none of these paths is on the public list, so every route is
 * reachable only with a session and `currentUser(c)` cannot be null.
 *
 * **Reads are open to every member** — one canonical set of counts everybody can
 * see is the reason this data is on the server at all. **Writes belong to the base's
 * owner**, and the rule is `mayWriteBaseCounts`, one pure function in
 * `write-access.ts`, so this handler decides nothing on its own.
 *
 * The season is **not** taken from the request. It is `CARD_SEASON`, one
 * constant in `shared/`, so a client cannot write into a season nobody is
 * looking at — and there is no UI that would want to. It is echoed in every
 * response so the page can say which event it is showing.
 */

/**
 * The whole submitted list, or the first thing wrong with it.
 *
 * All-or-nothing on purpose: a partially applied save would leave a base holding
 * a mixture of what the user typed and what was there before, with nothing on
 * screen saying which cards took. Rejecting the request keeps the stored state
 * the one the user last saw.
 *
 * There is deliberately **no explicit length cap** on `value`, unlike the bulk
 * endpoints in `shared-data/routes.ts`. The two rules below already bound the loop:
 * ids must fall in 1–60 and no id may repeat, so by the pigeonhole principle the
 * 61st entry is guaranteed to be a duplicate or out of range and returns. A
 * hundred-thousand-entry array therefore costs sixty-one iterations, not a hundred
 * thousand, and adding a `counts.length` check would only restate a bound the
 * validation already enforces.
 */
function parseCounts(value: unknown): { counts: CardCount[] } | { problem: string } {
  if (!Array.isArray(value)) {
    return { problem: 'Send counts as an array of { cardId, count }.' }
  }

  const counts: CardCount[] = []
  const seen = new Set<number>()

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return { problem: 'Every entry must be an object with cardId and count.' }
    }

    const { cardId, count } = entry as Record<string, unknown>

    if (typeof cardId !== 'number' || !Number.isInteger(cardId)) {
      return { problem: `cardId must be a whole number, got ${JSON.stringify(cardId)}.` }
    }
    if (cardId < CARD_ID_MIN || cardId > CARD_ID_MAX) {
      return { problem: `cardId ${cardId} is outside ${CARD_ID_MIN}–${CARD_ID_MAX}.` }
    }
    // A repeated id means the client disagrees with itself about one card, and
    // silently letting the last one win would store a number nobody chose.
    if (seen.has(cardId)) return { problem: `cardId ${cardId} appears more than once.` }
    seen.add(cardId)

    if (typeof count !== 'number' || !Number.isInteger(count)) {
      return { problem: `count for card ${cardId} must be a whole number.` }
    }
    if (count < 0 || count > MAX_CARD_COUNT) {
      return { problem: `count ${count} for card ${cardId} is outside 0–${MAX_CARD_COUNT}.` }
    }

    // A zero is legal input and means "delete the row", so it is carried through
    // to the store rather than filtered out here.
    counts.push({ cardId, count })
  }

  return { counts }
}

/**
 * Just enough of the shared-data store to answer "who owns this base". Narrow on
 * purpose: the card routes have no business reaching for anything else there, and
 * a test can hand over one function.
 */
export interface BaseOwnerLookup {
  getOwner(tag: string): OwnerRecord | undefined
}

/**
 * Flattens what the store knows into what the rule needs, absent row included.
 *
 * Exported because the trade routes need exactly the same flattening for both
 * sides of a swap, and two copies of it would be two chances for one of them to
 * start treating an unlinked label as an owner.
 */
export function ownershipOf(owners: BaseOwnerLookup, tag: string): BaseOwnership {
  const canonical = normalizeTag(tag)
  const record = owners.getOwner(canonical)
  return {
    tag: canonical,
    ownerUserId: record?.ownerUserId ?? null,
    ownerLabel: record?.owner ?? null,
  }
}

export function mountCardRoutes(
  app: Hono<AuthEnv>,
  store: CardInventoryStore,
  owners: BaseOwnerLookup,
): void {
  app.get('/api/cards/inventory', (c) =>
    c.json({ season: CARD_SEASON, bases: store.listInventory(CARD_SEASON) }),
  )

  app.get('/api/cards/inventory/:tag', (c) =>
    c.json({ season: CARD_SEASON, base: store.getInventory(CARD_SEASON, c.req.param('tag')) }),
  )

  /**
   * One base, one request, and only if this caller owns it. Last-write-wins among
   * those entitled to write: the body replaces everything stored for that base this
   * season, and the response carries the new `updatedAt` and `updatedBy`.
   *
   * Ownership is checked before the body is even parsed — whether a caller may
   * write a base has nothing to do with whether their payload is well formed, and
   * a 403 that depended on the body would be a strange thing to reason about.
   *
   * It is checked **again** right before the write, too. `readJson` below is a
   * real event-loop yield, and ownership can change underneath an in-flight
   * request — an admin reassigning this base via the synchronous
   * `PUT /api/owners/:tag`, which has no such window. Without the second check, a
   * caller's now-stale authorization from before the yield would still land.
   */
  app.put('/api/cards/inventory/:tag', async (c) => {
    const decision = mayWriteBaseCounts(currentUser(c), ownershipOf(owners, c.req.param('tag')))
    if (!decision.allowed) {
      return c.json(writeForbiddenBody(decision, 'Card counts'), 403)
    }

    const parsed = parseCounts((await readJson(c))['counts'])
    if ('problem' in parsed) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          parsed.problem,
          `Card ids run ${CARD_ID_MIN}–${CARD_ID_MAX} and counts 0–${MAX_CARD_COUNT}. Nothing was written.`,
        ),
        400,
      )
    }

    const stillAllowed = mayWriteBaseCounts(currentUser(c), ownershipOf(owners, c.req.param('tag')))
    if (!stillAllowed.allowed) {
      return c.json(writeForbiddenBody(stillAllowed, 'Card counts'), 403)
    }

    const base = store.saveBase(CARD_SEASON, c.req.param('tag'), parsed.counts, currentUser(c).id)
    return c.json({ season: CARD_SEASON, base })
  })
}
