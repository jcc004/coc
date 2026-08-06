import type { Hono } from 'hono'
import type { OwnerRecord } from '@coc/shared'
import { currentUser, type AuthContext, type AuthEnv } from '../auth/middleware.ts'
import { errorBody } from '../http.ts'
import type { BaseOrderStore } from './store.ts'

/**
 * `/api/base-order` — the first server-persisted per-user preference in this
 * app. Everything else a user can set (color scheme, last-viewed base, row
 * limits) is `localStorage`-only; this one was asked to follow the account
 * across devices instead, so it lives here.
 *
 * Authentication is not re-checked here: `/api/*` is deny-by-default in
 * `createApp` and this path is not on the public list, so `currentUser(c)`
 * cannot be null by the time either handler runs.
 *
 * There is no `:userId` in either path and no way to pass one in the body —
 * unlike ownership elsewhere in this app, an order is never someone else's to
 * read or write, so there is no admin-on-behalf-of case to gate the way
 * `mayWriteBaseCounts` gates card counts. The caller's own session is the only
 * identity either route ever consults.
 */

async function readJson(c: AuthContext): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

/**
 * Just enough of the shared-data store to answer "which bases does this caller
 * own" — narrower than `SharedDataStore` on purpose, the same reasoning
 * `BaseOwnerLookup` in `cards/routes.ts` and `ProgressOwnerLookup` in
 * `progress/routes.ts` give: a test can hand over one function instead of a
 * whole store.
 */
export interface BaseOrderOwnerLookup {
  listOwners(): OwnerRecord[]
}

/**
 * The submitted tag list, or the first thing wrong with it.
 *
 * All-or-nothing, the same stance every other write in this app takes: a
 * partial reorder would leave the saved sequence holding a mixture of what the
 * caller meant and what was rejected, with nothing on screen saying which tags
 * took.
 *
 * Deliberately **not** required to be complete — a caller reordering the two
 * bases they care about does not have to also name every other base they own.
 * A tag missing from the list is a client-side concern (append at the end when
 * read back), not something this validation rejects or fills in, because the
 * server has no opinion on where an unlisted tag belongs.
 *
 * `ownedTags` is every tag `normalizeTag`-canonical the caller owns, per
 * `listOwners()` — a submitted tag is checked against it verbatim rather than
 * re-normalized, because a tag that does not already match the canonical form
 * cannot be something the caller owns either.
 */
function parseTagOrder(
  body: unknown,
  ownedTags: ReadonlySet<string>,
): { tags: string[] } | { problem: string } {
  if (!Array.isArray(body)) {
    return { problem: 'Send tags as a JSON array of strings.' }
  }

  const tags: string[] = []
  const seen = new Set<string>()

  for (const [index, tag] of body.entries()) {
    if (typeof tag !== 'string') {
      return { problem: `tags[${index}] must be a string, got ${JSON.stringify(tag)}.` }
    }
    if (seen.has(tag)) {
      return { problem: `tags[${index}] (${tag}) is a duplicate.` }
    }
    if (!ownedTags.has(tag)) {
      return { problem: `${tag} is not one of your bases.` }
    }

    seen.add(tag)
    tags.push(tag)
  }

  return { tags }
}

export function mountBaseOrderRoutes(
  app: Hono<AuthEnv>,
  store: BaseOrderStore,
  owners: BaseOrderOwnerLookup,
): void {
  app.get('/api/base-order', (c) => {
    return c.json({ tags: store.getOrder(currentUser(c).id) })
  })

  app.put('/api/base-order', async (c) => {
    const user = currentUser(c)
    const ownedTags = new Set(
      owners.listOwners().filter((owner) => owner.ownerUserId === user.id).map((owner) => owner.tag),
    )

    const parsed = parseTagOrder(await readJson(c), ownedTags)
    if ('problem' in parsed) {
      return c.json(errorBody(400, 'badRequest', parsed.problem, 'Nothing was saved.'), 400)
    }

    store.setOrder(user.id, parsed.tags)
    return c.json({ tags: parsed.tags })
  })
}
