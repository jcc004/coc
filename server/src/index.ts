import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { bootstrapAdmin } from './auth/bootstrap.ts'
import { cookieSecureFromEnv } from './auth/middleware.ts'
import { createAuthStore } from './auth/store.ts'
import { TtlCache } from './cache.ts'
import { createChatStore } from './chat/store.ts'
import { createCocClient } from './coc-client.ts'
import { databasePathFromEnv, openDatabase, SCHEMA_VERSION } from './db.ts'
import { createSharedDataStore } from './shared-data/store.ts'

const port = Number(process.env.PORT ?? 8787)
const ttlSeconds = Number(process.env.CACHE_TTL_SECONDS ?? 60)

let coc
try {
  coc = createCocClient({ token: process.env.COC_API_TOKEN ?? '' })
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}\n`)
  process.exit(1)
}

const databasePath = databasePathFromEnv(process.env)
const db = openDatabase(databasePath)
const auth = createAuthStore(db)
const chat = createChatStore(db)
const sharedData = createSharedDataStore(db)

const bootstrap = bootstrapAdmin(auth, process.env)
/*
 * `existing` is the quiet case. `created` and `emailBackfilled` both changed
 * something and say so. Everything else means **nobody can sign in**, which has to
 * be impossible to miss in a log — that is the whole point of the message.
 */
if (bootstrap.status === 'created' || bootstrap.status === 'emailBackfilled') {
  console.log(`→ ${bootstrap.message}`)
} else if (bootstrap.status !== 'existing') {
  console.error(`\n✗ ${bootstrap.message}\n`)
}

const cache = new TtlCache(ttlSeconds * 1000)
setInterval(() => cache.prune(), 60_000).unref()
// Expired sessions are rejected on sight; this just stops the table growing.
setInterval(() => auth.pruneSessions(), 60 * 60_000).unref()

const app = createApp({
  coc,
  cache,
  auth,
  chat,
  sharedData,
  cookieSecure: cookieSecureFromEnv(process.env),
})

serve({ fetch: app.fetch, port }, ({ port: bound }) => {
  console.log(
    `→ API listening on http://localhost:${bound} (cache TTL ${ttlSeconds}s, db ${databasePath} at schema v${SCHEMA_VERSION})`,
  )
})
