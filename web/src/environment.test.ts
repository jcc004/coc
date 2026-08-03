import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PRODUCTION_HOST, siteEnvironment } from './environment.ts'

describe('siteEnvironment', () => {
  it('calls the canonical host production, unmarked', () => {
    assert.deepEqual(siteEnvironment(PRODUCTION_HOST), { kind: 'production', label: null })
  })

  it('marks everything else, whatever it is', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '::1',
      '192.168.1.20',
      '146.190.196.236',
      'coc.local',
      'some-tunnel.trycloudflare.com',
      '',
    ]) {
      const env = siteEnvironment(host)
      assert.equal(env.kind, 'development', `${JSON.stringify(host)} should be marked`)
      // Title case, matching the app name beside it: measured, both render in the
      // same font, and all-caps was what read as a second typeface.
      assert.equal(env.label, 'Dev Server')
    }
  })

  it('does not treat a subdomain as production', () => {
    // A suffix match would quietly call a staging box the live site. There is no
    // staging host today, which is exactly when this is cheap to get right.
    assert.equal(siteEnvironment('staging.coc.jcciv.com').kind, 'development')
    assert.equal(siteEnvironment('dev.coc.jcciv.com').kind, 'development')
  })

  it('does not treat a lookalike domain as production', () => {
    assert.equal(siteEnvironment('coc.jcciv.com.evil.test').kind, 'development')
    assert.equal(siteEnvironment('notcoc.jcciv.com').kind, 'development')
  })

  it('folds case, since DNS is case-insensitive', () => {
    assert.equal(siteEnvironment('COC.JCCIV.COM').kind, 'production')
    assert.equal(siteEnvironment('Coc.JcCiv.Com').kind, 'production')
  })

  it('tolerates a fully qualified trailing dot', () => {
    // A resolver may hand the name over this way; it is the same host.
    assert.equal(siteEnvironment(`${PRODUCTION_HOST}.`).kind, 'production')
  })

  it('tolerates surrounding whitespace rather than mis-marking the live site', () => {
    assert.equal(siteEnvironment(`  ${PRODUCTION_HOST}  `).kind, 'production')
  })

  it('fails toward marking, never toward silence', () => {
    // The asymmetry that matters: a false "DEV SERVER" is irritating, a missing one
    // is how somebody edits the wrong install's data.
    for (const host of ['', '   ', 'undefined', 'null']) {
      assert.equal(siteEnvironment(host).kind, 'development', `${JSON.stringify(host)}`)
    }
  })
})
