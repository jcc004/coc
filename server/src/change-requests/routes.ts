import type { Hono } from 'hono'
import {
  CHANGE_REQUEST_BODY_MAX,
  CHANGE_REQUEST_RESOLUTION_TYPES,
  CHANGE_REQUEST_SUBJECT_MAX,
  type ChangeRequestResolutionType,
} from '@coc/shared'
import { currentUser, type AuthEnv } from '../auth/middleware.ts'
import { errorBody, readJson } from '../http.ts'
import {
  mayAmendChangeRequest,
  mayCancelChangeRequest,
  mayHideChangeRequest,
  mayResolveChangeRequest,
  maySubmitChangeRequest,
  type ChangeRequestDecision,
} from './access.ts'
import type { ChangeRequestResolutionInput, ChangeRequestStore } from './store.ts'

/**
 * `/api/change-requests/*` and `/api/admin/change-requests/*` — "Propose a
 * change".
 *
 * Authentication is not re-checked here: `/api/*` is deny-by-default in
 * `createApp` and neither prefix is on the public list, so `currentUser(c)`
 * cannot be null in any handler. The `/api/admin/*` routes below get
 * `requireAdmin` for free from the path-scoped middleware already installed in
 * `createApp` — the same way `/api/admin/users` and
 * `/api/admin/progress/reference/:category` do — rather than this file
 * re-declaring an admin gate of its own. `mayResolveChangeRequest` is still
 * called inside the admin resolve handler; it is redundant with that
 * middleware today, but it is the one place the *rule* "resolving is
 * admin-only" is stated and tested, and the handler reading it rather than
 * relying solely on where it happens to be mounted is what stops the two
 * silently drifting if the route ever moves.
 *
 * | route | who |
 * | --- | --- |
 * | `GET /api/change-requests` | every signed-in user — their own requests |
 * | `POST /api/change-requests` | every signed-in user |
 * | `POST /api/change-requests/:id/amend` | the request's own author, while open |
 * | `POST /api/change-requests/:id/cancel` | the request's own author, any time |
 * | `POST /api/change-requests/:id/hide` | the request's own author, any time |
 * | `GET /api/change-requests/unseen-resolved-count` | every signed-in user — one integer, their own half of the account-menu badge |
 * | `POST /api/change-requests/mark-viewed` | every signed-in user — clears that half |
 * | `GET /api/admin/change-requests` | an admin — every request, every account |
 * | `GET /api/admin/change-requests/pending-count` | an admin — one integer, the other half of the badge |
 * | `POST /api/admin/change-requests/:id/resolve` | an admin |
 *
 * The five decisions are `may*ChangeRequest` in `access.ts` — pure functions
 * with their own tests — so these handlers decide nothing beyond parsing.
 */

/** The `:id` path segment as a positive integer, or `undefined` if it is not one. */
function requestId(raw: string | undefined): number | undefined {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 403 for "not you", 409 for "this request is closed" — the same split
 * `trade-routes.ts` makes between `forbidden` and a state conflict: a client
 * must not treat "the request closed under you" as "sign in as somebody else".
 *
 * The two branches are written out rather than computed into a shared `number`,
 * so each keeps its literal `403`/`409` type all the way to `c.json` without an
 * assertion — `as const` narrows a value already known correct, unlike casting
 * a widened `number` back down, which is why this is not the "unchecked cast"
 * this repo's invariants rule out.
 */
function refusalResponse(decision: ChangeRequestDecision & { allowed: false }, hint: string) {
  if (decision.refusal === 'closed') {
    return { status: 409 as const, body: errorBody(409, decision.refusal, decision.message, hint) }
  }
  return { status: 403 as const, body: errorBody(403, decision.refusal, decision.message, hint) }
}

/**
 * The subject and body, or the first thing wrong with them. Both are trimmed
 * before either the length floor or the ceiling is checked, so surrounding
 * whitespace cannot itself trip the "must not be blank" rule or count toward
 * the cap.
 */
function parseSubmission(
  raw: Record<string, unknown>,
): { subject: string; body: string } | { problem: string } {
  const subject = typeof raw['subject'] === 'string' ? raw['subject'].trim() : ''
  const body = typeof raw['body'] === 'string' ? raw['body'].trim() : ''

  if (!subject) return { problem: 'A subject is required.' }
  if (subject.length > CHANGE_REQUEST_SUBJECT_MAX) {
    return {
      problem: `Subject must be ${CHANGE_REQUEST_SUBJECT_MAX} characters or fewer (got ${subject.length}).`,
    }
  }
  if (!body) return { problem: 'A description is required.' }
  if (body.length > CHANGE_REQUEST_BODY_MAX) {
    return {
      problem: `Description must be ${CHANGE_REQUEST_BODY_MAX} characters or fewer (got ${body.length}).`,
    }
  }
  return { subject, body }
}

function parseAmendmentBody(raw: Record<string, unknown>): { body: string } | { problem: string } {
  const body = typeof raw['body'] === 'string' ? raw['body'].trim() : ''
  if (!body) return { problem: 'An amendment cannot be blank.' }
  if (body.length > CHANGE_REQUEST_BODY_MAX) {
    return {
      problem: `An amendment must be ${CHANGE_REQUEST_BODY_MAX} characters or fewer (got ${body.length}).`,
    }
  }
  return { body }
}

function isResolutionType(value: unknown): value is ChangeRequestResolutionType {
  return (
    typeof value === 'string' &&
    (CHANGE_REQUEST_RESOLUTION_TYPES as readonly string[]).includes(value)
  )
}

/**
 * The resolution, or the first thing wrong with it. `commitHash`/`commitSubject`
 * are required exactly when `type` is `'commit'` and ignored otherwise — the
 * `CHECK`s in migration v15 enforce that they cannot be *stored* outside that
 * case, and this is where they are required *inside* it, the same split
 * `parseProposal` in `trade-routes.ts` draws between a `CHECK` and a route.
 */
function parseResolution(
  raw: Record<string, unknown>,
): { resolution: ChangeRequestResolutionInput } | { problem: string } {
  if (!isResolutionType(raw['type'])) {
    return {
      problem: `type must be one of ${CHANGE_REQUEST_RESOLUTION_TYPES.join(', ')}, got ${JSON.stringify(
        raw['type'],
      )}.`,
    }
  }

  const rawNote = typeof raw['note'] === 'string' ? raw['note'].trim() : ''
  if (rawNote.length > CHANGE_REQUEST_BODY_MAX) {
    return {
      problem: `A resolution note must be ${CHANGE_REQUEST_BODY_MAX} characters or fewer (got ${rawNote.length}).`,
    }
  }
  const note = rawNote === '' ? null : rawNote

  let commitHash: string | null = null
  let commitSubject: string | null = null
  if (raw['type'] === 'commit') {
    const hash = typeof raw['commitHash'] === 'string' ? raw['commitHash'].trim() : ''
    const subject = typeof raw['commitSubject'] === 'string' ? raw['commitSubject'].trim() : ''
    if (!hash || !subject) {
      return {
        problem: 'Tying a resolution to a commit needs both commitHash and commitSubject.',
      }
    }
    commitHash = hash
    commitSubject = subject
  }

  return { resolution: { type: raw['type'], note, commitHash, commitSubject } }
}

export function mountChangeRequestRoutes(app: Hono<AuthEnv>, store: ChangeRequestStore): void {
  app.get('/api/change-requests', (c) => {
    return c.json({ requests: store.listMine(currentUser(c).id) })
  })

  app.post('/api/change-requests', async (c) => {
    const decision = maySubmitChangeRequest(currentUser(c))
    if (!decision.allowed) {
      const { status, body } = refusalResponse(decision, 'Nothing was submitted.')
      return c.json(body, status)
    }

    const parsed = parseSubmission(await readJson(c))
    if ('problem' in parsed) {
      return c.json(errorBody(400, 'badRequest', parsed.problem, 'Nothing was submitted.'), 400)
    }

    const request = store.submit(parsed, currentUser(c).id)
    return c.json({ request }, 201)
  })

  app.post('/api/change-requests/:id/amend', async (c) => {
    const id = requestId(c.req.param('id'))
    if (id === undefined) {
      return c.json(errorBody(400, 'badRequest', 'A request id is a positive whole number.'), 400)
    }

    const existing = store.find(id)
    if (!existing) return c.json(errorBody(404, 'notFound', `No request ${id}.`), 404)

    const decision = mayAmendChangeRequest(currentUser(c), existing)
    if (!decision.allowed) {
      const { status, body } = refusalResponse(decision, 'Nothing was added.')
      return c.json(body, status)
    }

    const parsed = parseAmendmentBody(await readJson(c))
    if ('problem' in parsed) {
      return c.json(errorBody(400, 'badRequest', parsed.problem, 'Nothing was added.'), 400)
    }

    const request = store.amend(id, parsed.body, currentUser(c).id)
    return c.json({ request })
  })

  app.post('/api/change-requests/:id/cancel', (c) => {
    const id = requestId(c.req.param('id'))
    if (id === undefined) {
      return c.json(errorBody(400, 'badRequest', 'A request id is a positive whole number.'), 400)
    }

    const existing = store.find(id)
    if (!existing) return c.json(errorBody(404, 'notFound', `No request ${id}.`), 404)

    const decision = mayCancelChangeRequest(currentUser(c), existing)
    if (!decision.allowed) {
      const { status, body } = refusalResponse(decision, 'Nothing was changed.')
      return c.json(body, status)
    }

    const request = store.cancel(id, currentUser(c).id)
    return c.json({ request })
  })

  app.post('/api/change-requests/:id/hide', async (c) => {
    const id = requestId(c.req.param('id'))
    if (id === undefined) {
      return c.json(errorBody(400, 'badRequest', 'A request id is a positive whole number.'), 400)
    }

    const existing = store.find(id)
    if (!existing) return c.json(errorBody(404, 'notFound', `No request ${id}.`), 404)

    const decision = mayHideChangeRequest(currentUser(c), existing)
    if (!decision.allowed) {
      const { status, body } = refusalResponse(decision, 'Nothing was changed.')
      return c.json(body, status)
    }

    const raw = await readJson(c)
    if (typeof raw['hidden'] !== 'boolean') {
      return c.json(errorBody(400, 'badRequest', 'hidden must be true or false.'), 400)
    }

    const request = store.setHidden(id, raw['hidden'])
    return c.json({ request })
  })

  // Literal segments, ahead of nothing that could mistake them for an `:id` —
  // both are `GET`/`POST` on paths no other route in this file uses.
  app.get('/api/change-requests/unseen-resolved-count', (c) => {
    return c.json({ count: store.countUnseenResolved(currentUser(c).id) })
  })

  app.post('/api/change-requests/mark-viewed', (c) => {
    store.markViewed(currentUser(c).id)
    return c.json({ ok: true })
  })

  // Admin-only via the `/api/admin/*` middleware installed in `createApp`.
  app.get('/api/admin/change-requests', (c) => {
    return c.json({ requests: store.listAll() })
  })

  // No `GET /api/admin/change-requests/:id` exists for this literal segment to
  // be mistaken for, so its position among the other admin routes is free.
  app.get('/api/admin/change-requests/pending-count', (c) => {
    return c.json({ count: store.countOpen() })
  })

  app.post('/api/admin/change-requests/:id/resolve', async (c) => {
    const decision = mayResolveChangeRequest(currentUser(c))
    if (!decision.allowed) {
      const { status, body } = refusalResponse(decision, 'Nothing was resolved.')
      return c.json(body, status)
    }

    const id = requestId(c.req.param('id'))
    if (id === undefined) {
      return c.json(errorBody(400, 'badRequest', 'A request id is a positive whole number.'), 400)
    }

    const existing = store.find(id)
    if (!existing) return c.json(errorBody(404, 'notFound', `No request ${id}.`), 404)

    const parsed = parseResolution(await readJson(c))
    if ('problem' in parsed) {
      return c.json(errorBody(400, 'badRequest', parsed.problem, 'Nothing was resolved.'), 400)
    }

    const request = store.resolve(id, parsed.resolution, currentUser(c).id)
    return c.json({ request })
  })
}
