import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CocApiError, createCocClient } from './coc-client.ts'

/**
 * A stub `fetch` that answers from a queue of canned responses, one call at a time,
 * and records every URL it was actually asked for — so a test can prove a retry
 * happened (queue length vs. calls seen) without a real network call or a real
 * backoff delay.
 */
function stubFetch(responses: Array<Response | Error>) {
  const calls: string[] = []
  const queue = [...responses]
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url)
    const next = queue.shift()
    if (next === undefined) throw new Error('stubFetch: ran out of canned responses')
    if (next instanceof Error) throw next
    return next
  }) as typeof fetch
  return { fetchImpl, calls }
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

/** Records every delay it was asked to wait, but never actually waits. */
function noopSleep() {
  const delays: number[] = []
  return { sleep: async (ms: number) => void delays.push(ms), delays }
}

describe('createCocClient retries', () => {
  it('does not retry a clean success', async () => {
    const { fetchImpl, calls } = stubFetch([jsonResponse(200, { tag: '#ABC' })])
    const { sleep } = noopSleep()
    const client = createCocClient({ token: 't', fetchImpl, sleep })

    const player = await client.getPlayer('#ABC')
    assert.deepEqual(player, { tag: '#ABC' })
    assert.equal(calls.length, 1)
  })

  it('retries a 503 and succeeds on the second attempt', async () => {
    const { fetchImpl, calls } = stubFetch([
      jsonResponse(503, { reason: 'inMaintenance', message: 'Service is in maintenance.' }),
      jsonResponse(200, { tag: '#ABC' }),
    ])
    const { sleep, delays } = noopSleep()
    const client = createCocClient({ token: 't', fetchImpl, sleep })

    const player = await client.getPlayer('#ABC')
    assert.deepEqual(player, { tag: '#ABC' })
    assert.equal(calls.length, 2, 'the failed attempt and the retry')
    assert.equal(delays.length, 1)
  })

  it('gives up after maxRetries and throws the last error', async () => {
    const { fetchImpl, calls } = stubFetch([
      jsonResponse(502, { reason: 'badGateway', message: 'Bad gateway' }),
      jsonResponse(502, { reason: 'badGateway', message: 'Bad gateway' }),
      jsonResponse(502, { reason: 'badGateway', message: 'Bad gateway' }),
    ])
    const { sleep, delays } = noopSleep()
    const client = createCocClient({ token: 't', fetchImpl, sleep, maxRetries: 2 })

    await assert.rejects(
      () => client.getPlayer('#ABC'),
      (err: unknown) => err instanceof CocApiError && err.status === 502,
    )
    // maxRetries: 2 means 3 attempts total — the first plus two retries.
    assert.equal(calls.length, 3)
    assert.equal(delays.length, 2)
  })

  it('does not retry a 404 — retrying cannot fix a real answer', async () => {
    const { fetchImpl, calls } = stubFetch([
      jsonResponse(404, { reason: 'notFound', message: 'No player found.' }),
    ])
    const { sleep } = noopSleep()
    const client = createCocClient({ token: 't', fetchImpl, sleep })

    await assert.rejects(
      () => client.getPlayer('#ABC'),
      (err: unknown) => err instanceof CocApiError && err.status === 404,
    )
    assert.equal(calls.length, 1, 'a 404 must not be retried')
  })

  it('does not retry a 403 IP-binding failure', async () => {
    const { fetchImpl, calls } = stubFetch([
      jsonResponse(403, { reason: 'accessDenied', message: 'Invalid IP' }),
    ])
    const { sleep } = noopSleep()
    const client = createCocClient({ token: 't', fetchImpl, sleep })

    await assert.rejects(() => client.getPlayer('#ABC'))
    assert.equal(calls.length, 1)
  })

  it('retries a network failure the same as a 5xx', async () => {
    const { fetchImpl, calls } = stubFetch([
      new TypeError('fetch failed'),
      jsonResponse(200, { tag: '#ABC' }),
    ])
    const { sleep } = noopSleep()
    const client = createCocClient({ token: 't', fetchImpl, sleep })

    const player = await client.getPlayer('#ABC')
    assert.deepEqual(player, { tag: '#ABC' })
    assert.equal(calls.length, 2)
  })

  it('honors Retry-After on a 429, capped, over the guessed backoff', async () => {
    const { fetchImpl } = stubFetch([
      jsonResponse(429, { reason: 'throttled', message: 'Too many requests' }, { 'retry-after': '9999' }),
      jsonResponse(200, { tag: '#ABC' }),
    ])
    const { sleep, delays } = noopSleep()
    const client = createCocClient({ token: 't', fetchImpl, sleep })

    await client.getPlayer('#ABC')
    assert.equal(delays.length, 1)
    // 9999s is way past the cap — the client must not wait anywhere near that long.
    assert.ok(delays[0]! <= 3000, `expected a capped delay, got ${delays[0]}ms`)
  })

  it('backs off with an increasing delay when upstream gives no Retry-After', async () => {
    const { fetchImpl } = stubFetch([
      jsonResponse(500, { reason: 'internalError', message: 'oops' }),
      jsonResponse(500, { reason: 'internalError', message: 'oops' }),
      jsonResponse(200, { tag: '#ABC' }),
    ])
    const { sleep, delays } = noopSleep()
    const client = createCocClient({ token: 't', fetchImpl, sleep, maxRetries: 2 })

    await client.getPlayer('#ABC')
    assert.equal(delays.length, 2)
    assert.ok(delays[1]! > delays[0]!, 'the second wait must be longer than the first')
  })
})
