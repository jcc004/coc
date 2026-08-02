import type { Hono } from 'hono'
import { MAX_CHAT_LENGTH } from '@coc/shared'
import { currentUser, type AuthEnv } from '../auth/middleware.ts'
import { errorBody } from '../http.ts'
import { CHAT_COOLDOWN_MS, type ChatStore } from './store.ts'

/**
 * `/api/chat`. Authentication is not re-checked here: `/api/*` is
 * deny-by-default in `createApp`, and chat is not on the public list.
 */

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function mountChatRoutes(app: Hono<AuthEnv>, chat: ChatStore): void {
  app.get('/api/chat', (c) => {
    // `after` is a cursor, so 0 is meaningful ("everything") and cannot go
    // through positiveInt.
    const raw = c.req.query('after')
    const parsed = raw === undefined ? Number.NaN : Number(raw)
    const after = Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined

    return c.json({ messages: chat.list(after, positiveInt(c.req.query('limit'))) })
  })

  app.post('/api/chat', async (c) => {
    const user = currentUser(c)

    let parsed: unknown
    try {
      parsed = await c.req.json()
    } catch {
      parsed = {}
    }
    const raw = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}

    /*
     * Text only. There is no attachment field to omit — the body is the whole
     * message — and it is stored verbatim: React escapes it on render, so
     * sanitising here would corrupt legitimate text like "<3" for no gain.
     */
    const body = (typeof raw['body'] === 'string' ? raw['body'] : '').trim()

    if (!body) {
      return c.json(errorBody(400, 'badRequest', 'A message cannot be empty.'), 400)
    }
    if (body.length > MAX_CHAT_LENGTH) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          `A message cannot be longer than ${MAX_CHAT_LENGTH} characters.`,
          `That one was ${body.length}.`,
        ),
        400,
      )
    }

    // Cheap flood guard. Derived from the stored rows rather than in-memory
    // state, so a restart cannot be used to reset it.
    const since = chat.msSinceLastMessage(user.id)
    if (since !== undefined && since < CHAT_COOLDOWN_MS) {
      c.header('Retry-After', '1')
      return c.json(errorBody(429, 'tooFast', 'Slow down a moment before posting again.'), 429)
    }

    return c.json({ message: chat.post(user.id, body) }, 201)
  })
}
