import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { TtlCache } from './cache.ts'
import { createCocClient } from './coc-client.ts'

const port = Number(process.env.PORT ?? 8787)
const ttlSeconds = Number(process.env.CACHE_TTL_SECONDS ?? 60)

let coc
try {
  coc = createCocClient({ token: process.env.COC_API_TOKEN ?? '' })
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}\n`)
  process.exit(1)
}

const cache = new TtlCache(ttlSeconds * 1000)
setInterval(() => cache.prune(), 60_000).unref()

serve({ fetch: createApp({ coc, cache }).fetch, port }, ({ port: bound }) => {
  console.log(`→ API listening on http://localhost:${bound} (cache TTL ${ttlSeconds}s)`)
})
