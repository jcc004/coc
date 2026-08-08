import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TradeRecord } from '@coc/shared'
import type { StandingBase } from './card-standings.ts'
import { traderStandings } from './trader-standings.ts'

/* ---------- fixtures ----------
 *
 * Minimal `TradeRecord`s, following `trade-tracker.test.ts`'s `trade()` helper —
 * no real card ids are needed here since this ranking never touches card counts,
 * only `baseA` / `baseB` / `status`.
 */

function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 1,
    season: '2026-08',
    baseA: '#AAA',
    baseB: '#BBB',
    cardFromA: 3,
    cardFromB: 7,
    category: 'Elixir',
    status: 'complete',
    proposedByUserId: 1,
    proposedBy: 'Anna',
    proposedAt: '2026-08-02T10:00:00.000Z',
    resolvedByUserId: 1,
    resolvedBy: 'Anna',
    resolvedAt: '2026-08-02T11:00:00.000Z',
    undoneByUserId: null,
    undoneBy: null,
    undoneAt: null,
    ...over,
  }
}

function base(tag: string, label: string = tag): StandingBase {
  return { tag, label, owner: null, ownerUserId: null }
}

const row = (rows: ReturnType<typeof traderStandings>, tag: string) =>
  rows.find((r) => r.tag === tag)

describe('traderStandings', () => {
  it('counts a base on the baseA side of 3 complete trades and the baseB side of 2 more as 5', () => {
    const bases = [base('#AAA'), base('#BBB'), base('#CCC'), base('#DDD'), base('#EEE')]
    const trades = [
      trade({ id: 1, baseA: '#AAA', baseB: '#BBB' }),
      trade({ id: 2, baseA: '#AAA', baseB: '#CCC' }),
      trade({ id: 3, baseA: '#AAA', baseB: '#DDD' }),
      trade({ id: 4, baseA: '#EEE', baseB: '#AAA' }),
      trade({ id: 5, baseA: '#BBB', baseB: '#AAA' }),
    ]
    assert.equal(row(traderStandings(bases, trades), '#AAA')?.completedTrades, 5)
  })

  it('excludes pending and declined trades, which never actually completed', () => {
    const bases = [base('#AAA')]
    const trades = [
      trade({ id: 1, status: 'pending', resolvedAt: null, resolvedBy: null, resolvedByUserId: null }),
      trade({ id: 2, status: 'declined' }),
    ]
    assert.equal(row(traderStandings(bases, trades), '#AAA')?.completedTrades, 0)
  })

  it('still counts an undone trade — the base did complete it before an admin reversed it', () => {
    const bases = [base('#AAA')]
    const trades = [
      trade({ id: 1, status: 'complete' }),
      trade({
        id: 2,
        status: 'undone',
        undoneAt: '2026-08-03T00:00:00.000Z',
        undoneBy: 'Bert',
        undoneByUserId: 2,
      }),
    ]
    assert.equal(row(traderStandings(bases, trades), '#AAA')?.completedTrades, 2)
  })

  it('scores a known base with zero completed trades at 0 rather than omitting it', () => {
    const rows = traderStandings([base('#AAA'), base('#ZZZ')], [])
    assert.equal(rows.length, 2)
    assert.equal(row(rows, '#AAA')?.completedTrades, 0)
    assert.equal(row(rows, '#ZZZ')?.completedTrades, 0)
  })

  it('gives no row to a base tag that only appears in trades, not in the known list', () => {
    const bases = [base('#AAA')]
    const trades = [trade({ id: 1, baseA: '#AAA', baseB: '#UNTRACKED' })]
    const rows = traderStandings(bases, trades)
    assert.equal(rows.length, 1)
    // The known side still gets credit for the trade — only the untracked
    // partner is left off the board, not the trade itself.
    assert.equal(row(rows, '#AAA')?.completedTrades, 1)
  })

  it('breaks a tie on completedTrades by distinct partners, then name, then tag', () => {
    const bases = [base('#BBB', 'Bert'), base('#AAA', 'Anna'), base('#CCC', 'Carl')]
    const trades = [
      // Anna: 2 completed trades, both with the same partner -> 1 distinct partner.
      trade({ id: 1, baseA: '#AAA', baseB: '#DDD' }),
      trade({ id: 2, baseA: '#AAA', baseB: '#DDD' }),
      // Bert: 2 completed trades with two different partners -> 2 distinct partners.
      trade({ id: 3, baseA: '#BBB', baseB: '#DDD' }),
      trade({ id: 4, baseA: '#BBB', baseB: '#EEE' }),
      // Carl: nothing.
    ]
    const rows = traderStandings(bases, trades)
    assert.deepEqual(
      rows.map((r) => r.tag),
      ['#BBB', '#AAA', '#CCC'],
    )
    assert.equal(row(rows, '#BBB')?.distinctPartners, 2)
    assert.equal(row(rows, '#AAA')?.distinctPartners, 1)

    // Bert and Anna are tied on completedTrades (2 each) and must share a rank,
    // even though the partner tiebreak orders one above the other on the page.
    assert.equal(row(rows, '#BBB')?.rank, 1)
    assert.equal(row(rows, '#AAA')?.rank, 1)
    assert.equal(row(rows, '#CCC')?.rank, 3)
  })

  it('breaks a full tie (same count, same partners) on name, then tag', () => {
    const bases = [base('#ZZZ', 'Zoe'), base('#AAA', 'Anna')]
    const trades = [trade({ id: 1, baseA: '#AAA', baseB: '#ZZZ' })]
    const rows = traderStandings(bases, trades)
    assert.deepEqual(
      rows.map((r) => r.tag),
      ['#AAA', '#ZZZ'],
    )
    assert.equal(row(rows, '#AAA')?.rank, 1)
    assert.equal(row(rows, '#ZZZ')?.rank, 1)
  })
})
