import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  clientIp,
  cookieSecureFromEnv,
  trustProxyFromEnv,
  type AuthContext,
  type AuthEnv,
} from './middleware.ts'

/*
 * `clientIp` on its own, because it is the rate limiter's bucket key and a caller
 * who can choose their own key has switched the brake off. The app-level proof that
 * this is what the limiter actually uses lives in `app.test.ts`; what is here is the
 * precedence, hop by hop.
 *
 * There is no socket address under `app.request()` — `getConnInfo` throws and
 * `clientIp` answers `''` — so every case below is about the headers, which is the
 * part an attacker controls.
 */
async function ipReportedFor(
  headers: Record<string, string>,
  trustProxy: boolean,
): Promise<string> {
  const app = new Hono<AuthEnv>()
  app.get('/ip', (c) => c.text(clientIp(c as AuthContext, trustProxy)))
  const response = await app.request('/ip', { headers })
  return response.text()
}

describe('clientIp behind a proxy that appends', () => {
  it('takes the last hop of X-Forwarded-For, not the first', async () => {
    /*
     * The bug this exists for. nginx sets the header from
     * `$proxy_add_x_forwarded_for`, which **appends** the real peer to whatever the
     * client sent, so the list arrives as `<client's value>, <real IP>`. Reading
     * `[0]` read the attacker's string; reading the last element reads nginx's.
     */
    const ip = await ipReportedFor({ 'x-forwarded-for': '10.0.0.1, 203.0.113.9' }, true)
    assert.equal(ip, '203.0.113.9')
  })

  it('ignores every value a client put in front of the real one', async () => {
    // Whatever the client stuffs in, however much of it, only the appended hop counts.
    const ip = await ipReportedFor(
      { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.7' },
      true,
    )
    assert.equal(ip, '198.51.100.7')
  })

  it('tolerates the whitespace a real header carries', async () => {
    assert.equal(await ipReportedFor({ 'x-forwarded-for': ' 10.0.0.1 ,  203.0.113.9 ' }, true), '203.0.113.9')
  })

  it('prefers X-Real-IP, which a client cannot get a value into through the proxy', async () => {
    // nginx *overwrites* X-Real-IP from $remote_addr rather than appending to it,
    // so it is the one header a client has no way of contributing to.
    const ip = await ipReportedFor(
      { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.1, 192.0.2.5' },
      true,
    )
    assert.equal(ip, '203.0.113.9')
  })

  it('falls back to the forwarded header when X-Real-IP is absent or blank', async () => {
    assert.equal(await ipReportedFor({ 'x-forwarded-for': '203.0.113.9' }, true), '203.0.113.9')
    assert.equal(
      await ipReportedFor({ 'x-real-ip': '   ', 'x-forwarded-for': '203.0.113.9' }, true),
      '203.0.113.9',
    )
  })

  it('answers empty rather than a placeholder when there is nothing to go on', async () => {
    // The limiter skips the IP bucket on `''`. A placeholder would file every
    // caller under one key, which is a lockout for the whole app.
    assert.equal(await ipReportedFor({}, true), '')
    assert.equal(await ipReportedFor({ 'x-forwarded-for': '  ,  ' }, true), '')
  })
})

describe('clientIp with no proxy in front of it', () => {
  it('ignores both headers entirely', async () => {
    /*
     * Without a proxy there is nobody overwriting these, so they are simply strings
     * the caller typed. `npm run dev` and a container someone exposed directly are
     * both in this state, and neither may take rate-limiting identity from a request
     * header. `''` here means the socket address is the only thing that can count.
     */
    assert.equal(await ipReportedFor({ 'x-real-ip': '203.0.113.9' }, false), '')
    assert.equal(await ipReportedFor({ 'x-forwarded-for': '10.0.0.1, 203.0.113.9' }, false), '')
  })
})

describe('the trust boundary is opt-in', () => {
  it('is off unless TRUST_PROXY is exactly "true"', () => {
    assert.equal(trustProxyFromEnv({}), false)
    assert.equal(trustProxyFromEnv({ TRUST_PROXY: '' }), false)
    assert.equal(trustProxyFromEnv({ TRUST_PROXY: 'false' }), false)
    // Not truthy-coerced: a stray value must not switch a security boundary on.
    assert.equal(trustProxyFromEnv({ TRUST_PROXY: '1' }), false)
    assert.equal(trustProxyFromEnv({ TRUST_PROXY: 'yes' }), false)
    assert.equal(trustProxyFromEnv({ TRUST_PROXY: 'TRUE' }), false)

    assert.equal(trustProxyFromEnv({ TRUST_PROXY: 'true' }), true)
  })

  it('is a separate decision from the Secure cookie flag', () => {
    // Both are "am I behind a proxy" questions and they are still not the same
    // question: HTTPS termination does not imply the forwarded headers are set.
    assert.equal(trustProxyFromEnv({ NODE_ENV: 'production' }), false)
    assert.equal(cookieSecureFromEnv({ NODE_ENV: 'production' }), true)
    assert.equal(cookieSecureFromEnv({ TRUST_PROXY: 'true' }), false)
  })
})
