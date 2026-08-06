import type { Hono } from 'hono'
import type {
  HandEnteredReferenceCategory,
  ManualCapturePayload,
  OwnerRecord,
  WallReferenceRow,
} from '@coc/shared'
import { currentUser, type AuthContext, type AuthEnv } from '../auth/middleware.ts'
import { ownershipOf, type BaseOwnerLookup } from '../cards/routes.ts'
import { mayWriteBaseCounts } from '../cards/write-access.ts'
import { errorBody } from '../http.ts'
import type { ProgressStore } from './store.ts'

/**
 * `/api/progress/*` — reading and hand-entering weekly base progress.
 *
 * Authentication is not re-checked here: `/api/*` is deny-by-default in
 * `createApp` and none of these paths is on the public list, so every route is
 * reachable only with a session and `currentUser(c)` cannot be null.
 *
 * **Reads are open to every member** — one shared view of every base's progress
 * is the point, the same stance `cards/routes.ts` takes on inventory. **Writes
 * belong to the base's owner**, gated by the same `mayWriteBaseCounts` cards
 * uses: the user decided base-progress writes should follow the exact rule
 * card counts do, not a second copy of it.
 */

async function readJson(c: AuthContext): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * `buildingsLeft` is a digit string or one of the two literals a person types
 * when counting is not the point — `'LOTS'` for "too many to bother" and
 * `'DONE!'` for zero left. Anything else is rejected rather than coerced, the
 * same "whole request or nothing" stance `parseCounts` takes in `cards/routes.ts`.
 */
const BUILDINGS_LEFT_PATTERN = /^(\d+|LOTS|DONE!)$/

/**
 * The submitted manual capture, or the first thing wrong with it. All-or-nothing,
 * for the same reason `parseCounts` is: a partially applied save would leave the
 * week holding a mixture of what was typed and what was there before, with
 * nothing on screen saying which fields took.
 *
 * `wallReference` is this base's known TH's row from `wall_reference` — or
 * `null` when there is no bound to validate against, either because the base's
 * TH has never been auto-captured (`getLatestThLevel` returned `null`) or the
 * weekly wiki refresh has not covered that TH yet. Without a bound the walls
 * check falls back to the original shape check (non-negative whole numbers)
 * rather than guessing at a cap — a base that has never been seen by the
 * scheduled job is not thereby prevented from hand-entering anything.
 */
function parseManualCapture(
  body: Record<string, unknown>,
  wallReference: WallReferenceRow | null,
): { payload: ManualCapturePayload } | { problem: string } {
  const { walls, buildingsLeft, notes } = body
  const payload: ManualCapturePayload = {}

  if (walls !== undefined) {
    if (typeof walls !== 'object' || walls === null || Array.isArray(walls)) {
      return { problem: 'walls must be an object mapping wall levels to counts.' }
    }

    const parsedWalls: Record<string, number> = {}
    let total = 0
    for (const [level, count] of Object.entries(walls)) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
        return {
          problem:
            `walls['${level}'] must be a non-negative whole number, ` +
            `got ${JSON.stringify(count)}.`,
        }
      }

      if (wallReference) {
        if (!/^\d+$/.test(level) || Number(level) <= 0) {
          return { problem: `walls['${level}'] is not a valid wall level.` }
        }
        if (Number(level) > wallReference.maxWallLevel) {
          return {
            problem:
              `walls['${level}'] is above the max wall level ` +
              `(${wallReference.maxWallLevel}) for TH${wallReference.thLevel}.`,
          }
        }
      }

      parsedWalls[level] = count
      total += count
    }

    if (wallReference && total > wallReference.totalWallCount) {
      return {
        problem:
          `walls add up to ${total}, above the ${wallReference.totalWallCount} wall ` +
          `segments TH${wallReference.thLevel} has.`,
      }
    }

    payload.walls = parsedWalls
  }

  if (buildingsLeft !== undefined) {
    if (typeof buildingsLeft !== 'string' || !BUILDINGS_LEFT_PATTERN.test(buildingsLeft)) {
      return {
        problem:
          `buildingsLeft must be a digit string, 'LOTS', or 'DONE!', ` +
          `got ${JSON.stringify(buildingsLeft)}.`,
      }
    }
    payload.buildingsLeft = buildingsLeft
  }

  if (notes !== undefined) {
    if (typeof notes !== 'string') {
      return { problem: `notes must be a string, got ${JSON.stringify(notes)}.` }
    }
    payload.notes = notes
  }

  return { payload }
}

/** Like `readJson`, but for a route whose body is a JSON array rather than an object. */
async function readJsonArray(c: AuthContext): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

const HAND_ENTERED_CATEGORIES = new Set<HandEnteredReferenceCategory>(['pet', 'equipment'])

/** One row `PUT /api/admin/progress/reference/:category` accepts. */
interface ReferenceRowInput {
  name: string
  thLevel: number
  maxLevel: number
}

/**
 * The submitted batch of reference rows, or the first thing wrong with it.
 * All-or-nothing, the same stance `parseManualCapture` takes above: this is a
 * hand-typed batch of maybe a hundred rows, and a partial write would leave the
 * admin unable to tell which of them actually landed.
 */
function parseReferenceRows(body: unknown): { rows: ReferenceRowInput[] } | { problem: string } {
  if (!Array.isArray(body)) {
    return { problem: 'Expected a JSON array of { name, thLevel, maxLevel } rows.' }
  }

  const rows: ReferenceRowInput[] = []
  for (const [index, raw] of body.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return { problem: `Row ${index} must be an object, got ${JSON.stringify(raw)}.` }
    }
    const { name, thLevel, maxLevel } = raw as Record<string, unknown>

    if (typeof name !== 'string' || name.trim().length === 0) {
      return {
        problem: `Row ${index}: name must be a non-empty string, got ${JSON.stringify(name)}.`,
      }
    }
    if (typeof thLevel !== 'number' || !Number.isInteger(thLevel) || thLevel <= 0) {
      return {
        problem:
          `Row ${index} (${name}): thLevel must be a positive whole number, ` +
          `got ${JSON.stringify(thLevel)}.`,
      }
    }
    if (typeof maxLevel !== 'number' || !Number.isInteger(maxLevel) || maxLevel <= 0) {
      return {
        problem:
          `Row ${index} (${name}): maxLevel must be a positive whole number, ` +
          `got ${JSON.stringify(maxLevel)}.`,
      }
    }

    rows.push({ name: name.trim(), thLevel, maxLevel })
  }

  return { rows }
}

/**
 * Just enough of the shared-data store to answer "who owns this base" and
 * "which bases exist" — the two questions these routes actually ask. Narrower
 * than `SharedDataStore` on purpose, the same reasoning `BaseOwnerLookup` in
 * `cards/routes.ts` gives: a test can hand over two functions instead of a
 * whole store.
 */
export interface ProgressOwnerLookup extends BaseOwnerLookup {
  listOwners(): OwnerRecord[]
}

/**
 * The ISO date (`YYYY-MM-DD`, UTC) of the most recent Tuesday on or before
 * `now` — the week a capture taken "today" belongs to.
 *
 * `getUTCDay()` returns 0 for Sunday and 2 for Tuesday, so
 * `(day - 2 + 7) % 7` is how many days back the last Tuesday was: 0 on a
 * Tuesday itself, 6 on a Monday (the day right before the *next* Tuesday), 5
 * on a Sunday, and so on. Kept as its own exported function because the
 * scheduled auto-capture job needs the identical calculation, and the two
 * agreeing matters more than where the function lives.
 */
export function currentWeekStart(now: Date): string {
  const offsetDays = (now.getUTCDay() - 2 + 7) % 7
  const weekStart = new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000)
  return weekStart.toISOString().slice(0, 10)
}

export function mountProgressRoutes(
  app: Hono<AuthEnv>,
  store: ProgressStore,
  owners: ProgressOwnerLookup,
): void {
  /**
   * The two reference tables `percentToMax` and `wallProgress` need to turn a
   * captured level into a percent — refreshed weekly by a scheduled job, read by
   * every browser. Open the same way `/api/progress` is: it names no base, so
   * there is no ownership question to ask.
   *
   * Mounted **before** `/api/progress/:tag`: Hono matches routes in registration
   * order when a static and a dynamic segment overlap, so `reference` would
   * otherwise be swallowed as a (nonsense, but not rejected) player tag.
   */
  app.get('/api/progress/reference', (c) =>
    c.json({ maxLevels: store.getAllMaxLevelReference(), walls: store.getAllWallReference() }),
  )

  /**
   * The hand-entered half of `max_level_reference` — `pet` and `equipment`, the
   * two categories `refresh-reference.ts`'s wiki scrape cannot cover (see its
   * header for why). Mounted under `/api/admin/*`, so `createApp` already gates
   * it with `requireAdmin` before this handler ever runs — the same way every
   * other admin-only route in this app is scoped, rather than a second copy of
   * the check inline.
   *
   * `:category` is restricted to `HandEnteredReferenceCategory` rather than the
   * full `UnitCategory` on purpose: `hero`, `troop`, `spell` and the separate
   * `wall_reference` table are all refreshed weekly by the scheduled job, and
   * this route staying out of their way is what keeps a manual correction from
   * being silently overwritten by next Tuesday's run — or, the other direction,
   * from racing ahead of it and being overwritten itself.
   */
  app.put('/api/admin/progress/reference/:category', async (c) => {
    const category = c.req.param('category')
    if (!HAND_ENTERED_CATEGORIES.has(category as HandEnteredReferenceCategory)) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          `Unknown reference category "${category}". Only pet and equipment are hand-entered ` +
            'here — hero, troop, spell and wall are kept current by the weekly wiki refresh.',
        ),
        400,
      )
    }

    const parsed = parseReferenceRows(await readJsonArray(c))
    if ('problem' in parsed) {
      return c.json(errorBody(400, 'badRequest', parsed.problem, 'Nothing was written.'), 400)
    }

    store.upsertMaxLevelReference(
      parsed.rows.map((row) => ({ category: category as HandEnteredReferenceCategory, ...row })),
    )
    return c.json({ ok: true, written: parsed.rows.length })
  })

  app.get('/api/progress/:tag', (c) =>
    c.json({ history: store.getHistory(c.req.param('tag')) }),
  )

  /**
   * Every base with an owner assignment, **union**ed with every tag the scheduled
   * job has ever actually captured a row for (`getAllTrackedTags`) — not a live
   * roster call. Progress-tracking is meant to cover the whole clan, ownership
   * assignments included, but re-fetching a member list from the Clash of Clans API
   * on every load of a shared, frequently-hit board would be wasteful and
   * rate-limit-unfriendly; `capture-snapshot.ts` already does that fetch once,
   * clan-wide, on its own schedule. The cost is a bootstrap gap identical to one
   * that already exists today: a member appears here only once the job has run at
   * least once for them, the same way the whole board was empty before anyone ran
   * it by hand.
   */
  app.get('/api/progress', (c) => {
    const tags = [
      ...new Set([...owners.listOwners().map((owner) => owner.tag), ...store.getAllTrackedTags()]),
    ]
    return c.json({ bases: store.getLatestForClan(tags) })
  })

  /**
   * One base, one week, merged field by field into whatever that week already
   * holds — see `upsertSnapshot`. Ownership is checked before the body is even
   * parsed, exactly as `cards/routes.ts` does: whether a caller may write a base
   * has nothing to do with whether their payload is well formed.
   */
  app.put('/api/progress/:tag/manual', async (c) => {
    const decision = mayWriteBaseCounts(currentUser(c), ownershipOf(owners, c.req.param('tag')))
    if (!decision.allowed) {
      return c.json(
        errorBody(
          403,
          'forbidden',
          decision.message,
          'Base progress is entered by the member who owns the base. Nothing was written.',
        ),
        403,
      )
    }

    const tag = c.req.param('tag')
    const knownThLevel = store.getLatestThLevel(tag)
    const wallReference = knownThLevel === null ? null : store.getWallReference(knownThLevel)

    const parsed = parseManualCapture(await readJson(c), wallReference)
    if ('problem' in parsed) {
      return c.json(errorBody(400, 'badRequest', parsed.problem, 'Nothing was written.'), 400)
    }

    const weekStart = currentWeekStart(new Date())
    const snapshot = store.upsertSnapshot(
      tag,
      weekStart,
      { manual: parsed.payload },
      String(currentUser(c).id),
    )
    return c.json({ snapshot })
  })
}
