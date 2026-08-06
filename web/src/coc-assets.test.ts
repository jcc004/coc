import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { labelIcon, leagueIcon } from './coc-assets.ts'

/*
 * `coc-assets.ts` is entirely machine-written by scripts/fetch-coc-assets.mjs —
 * unlike cards.generated.ts/wiki-art.generated.ts, the hand-written half here
 * (these two functions) lives in the same file as the vendored id sets rather
 * than a separate one, which is exactly why it had no adjacent test: nothing
 * pointed at it as the place logic, as opposed to data, lives. The ids below are
 * from the earliest leagues and labels this app has ever tracked, so a
 * regeneration dropping them would be a real regression, not routine churn.
 */

describe('leagueIcon', () => {
  it('serves the local badge for a vendored league id', () => {
    assert.equal(leagueIcon(29000000, 'https://cdn.example/league.png'), '/coc/leagues/29000000.png')
  })

  it('falls back to the remote URL for an id nothing has vendored', () => {
    const remote = 'https://cdn.example/league.png'
    assert.equal(leagueIcon(1, remote), remote)
  })
})

describe('labelIcon', () => {
  it('serves the local badge for a vendored label id', () => {
    assert.equal(labelIcon(56000000, 'https://cdn.example/label.png'), '/coc/labels/56000000.png')
  })

  it('falls back to the remote URL for an id nothing has vendored', () => {
    const remote = 'https://cdn.example/label.png'
    assert.equal(labelIcon(1, remote), remote)
  })
})
