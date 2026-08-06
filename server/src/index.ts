import { serve } from '@hono/node-server'
import { bindHostFromEnv, bindsEveryInterface, createApp } from './app.ts'
import { bootstrapAdmin } from './auth/bootstrap.ts'
import { cookieSecureFromEnv, trustProxyFromEnv } from './auth/middleware.ts'
import { createAuthStore } from './auth/store.ts'
import { createBaseOrderStore } from './base-order/store.ts'
import { TtlCache } from './cache.ts'
import { createCardInventoryStore } from './cards/store.ts'
import { createTradeStore } from './cards/trades-store.ts'
import { createCocClient } from './coc-client.ts'
import {
  databasePathFromEnv,
  openDatabase,
  SCHEMA_VERSION,
  summarizeOwnerAssignments,
} from './db.ts'
import { createProgressStore } from './progress/store.ts'
import { createSharedDataStore } from './shared-data/store.ts'

const port = Number(process.env.PORT ?? 8787)
const ttlSeconds = Number(process.env.CACHE_TTL_SECONDS ?? 60)

/** Loopback unless `HOST` says otherwise — see `bindHostFromEnv` for why. */
const host = bindHostFromEnv(process.env)
const trustProxy = trustProxyFromEnv(process.env)

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
const sharedData = createSharedDataStore(db)
const cards = createCardInventoryStore(db)
// Handed the inventory store because completing a trade moves cards: the status
// change and the four count changes are one transaction over both tables.
const trades = createTradeStore(db, cards)
const progress = createProgressStore(db)
const baseOrder = createBaseOrderStore(db)

// Awaited: `bootstrapAdmin` hashes a password and scrypt is async now, and the
// first admin has to exist before the first request. This file is an ES module, so
// top-level await is available and no wrapper function is needed for it.
const bootstrap = await bootstrapAdmin(auth, process.env)
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

/*
 * The owner column's state, every boot. On the boot that applies v6 these are the
 * backfill's numbers, and most of the existing assignments are expected not to
 * resolve — they are clan nicknames, not accounts. An unresolved row still shows
 * its label and simply owns nothing until an admin reassigns it, so this line is
 * the measure of how much of that work is outstanding rather than a warning.
 */
const owners = summarizeOwnerAssignments(db)
console.log(
  `→ owner assignments: ${owners.resolved} of ${owners.total} linked to an account, ` +
    `${owners.unresolved} still a text label (admin-writable only)`,
)

const cache = new TtlCache(ttlSeconds * 1000)
setInterval(() => cache.prune(), 60_000).unref()
// Expired sessions are rejected on sight; this just stops the table growing.
setInterval(() => auth.pruneSessions(), 60 * 60_000).unref()

const app = createApp({
  coc,
  cache,
  auth,
  sharedData,
  cards,
  trades,
  progress,
  baseOrder,
  cookieSecure: cookieSecureFromEnv(process.env),
  trustProxy,
})

serve({ fetch: app.fetch, port, hostname: host }, ({ address, port: bound }) => {
  /*
   * The bound address is logged rather than a hard-coded `localhost`, which is what
   * this line used to say whether or not it was true. A startup line naming an
   * interface the process is not on is how a wide bind goes unnoticed for months.
   */
  console.log(
    `→ API listening on http://${address}:${bound} (cache TTL ${ttlSeconds}s, ` +
      `db ${databasePath} at schema v${SCHEMA_VERSION}, ` +
      `${trustProxy ? 'trusting' : 'ignoring'} forwarded headers)`,
  )
  if (bindsEveryInterface(address)) {
    console.warn(
      `⚠ HOST=${process.env.HOST ?? ''} binds every interface, so :${bound} is reachable ` +
        'without going through nginx — no TLS, no HSTS, no body cap, no forwarded headers.',
    )
  }
})
