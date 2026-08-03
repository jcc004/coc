import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AdminUser, OwnerRecord } from '@coc/shared'
import {
  foldOwnerName,
  legacyOwnerCount,
  ownerCellFor,
  ownerOptions,
  parseOwnerChoice,
  suggestOwnerAccount,
} from './owner-picker.ts'

/*
 * The cases here are the live install's, not invented ones: 50 assignments, 18
 * pointing at an account and 32 still free text, including `lisa_sweatt` against an
 * account displayed as `lisa sweatt`. That near miss is the whole reason the fold
 * is not just `toLowerCase().trim()`, which is what the server's backfill used.
 */

const account = (id: number, displayName: string, disabledAt: string | null = null): AdminUser => ({
  id,
  guid: `guid-${id}`,
  displayName,
  email: `${id}@example.com`,
  role: 'user',
  createdAt: '2026-07-01T00:00:00.000Z',
  mustChangePassword: false,
  disabledAt,
})

const linked = (tag: string, owner: string, ownerUserId: number): OwnerRecord => ({
  tag,
  owner,
  ownerUserId,
})

const legacy = (tag: string, owner: string): OwnerRecord => ({ tag, owner, ownerUserId: null })

/*
 * The claim these pin down, because it was asked directly and because the bulk
 * control used to break it: **every name a picker offers belongs to an account on
 * this server.** Legacy free text is displayable and filterable but never
 * selectable, since assigning one would create a base whose owner names a person and
 * grants nobody anything — not even the right to edit that base's card counts.
 */
describe('ownerOptions offers accounts and nothing else', () => {
  const accounts = [account(1, 'Anna'), account(2, 'Bert'), account(3, 'Carl')]

  it('offers exactly the accounts it is given', () => {
    assert.deepEqual(
      ownerOptions(accounts).map((option) => option.label),
      ['Anna', 'Bert', 'Carl'],
    )
  })

  it('offers nothing at all when there are no accounts', () => {
    // A member never fetches the account list, so this is the non-admin case too:
    // an empty list, never a fallback to free text.
    assert.deepEqual(ownerOptions([]), [])
  })

  it('never invents an option from a legacy label', () => {
    // The label 'Turtle' exists in the data and matches no account. It must not
    // appear among the options however the cell renders it.
    const cell = ownerCellFor(legacy('#A', 'Turtle'), accounts)
    assert.equal(cell.kind, 'legacy')
    assert.equal(
      ownerOptions(accounts).some((option) => option.label === 'Turtle'),
      false,
    )
  })

  it('carries a userId on every option, so a choice is an account and not a name', () => {
    // This is what makes the write `PUT /api/owners/:tag {userId}` rather than text.
    for (const option of ownerOptions(accounts)) {
      assert.equal(typeof option.userId, 'number')
      assert.ok(option.userId > 0, `${option.label} needs a real account id`)
    }
  })

  it('leaves out a disabled account, which could not sign in to use the base', () => {
    const withDisabled = [...accounts, account(4, 'Dana', '2026-08-01T00:00:00.000Z')]
    assert.equal(
      ownerOptions(withDisabled).some((option) => option.label === 'Dana'),
      false,
    )
  })

  it('keeps a disabled account when it is the row’s current owner', () => {
    // Otherwise the list could not represent what the cell already shows, and the
    // row would silently redraw as somebody else.
    const withDisabled = [...accounts, account(4, 'Dana', '2026-08-01T00:00:00.000Z')]
    const options = ownerOptions(withDisabled, { userId: 4, label: 'Dana' })
    assert.equal(options.some((option) => option.userId === 4), true)
  })

  it('represents a current owner whose account has since been deleted', () => {
    const options = ownerOptions(accounts, { userId: 99, label: 'Gone' })
    assert.deepEqual(
      options.find((option) => option.userId === 99),
      { userId: 99, label: 'Gone' },
    )
  })
})

describe('foldOwnerName', () => {
  it('folds case, spacing and punctuation to one form', () => {
    for (const written of ['lisa sweatt', 'Lisa Sweatt', 'lisa_sweatt', 'Lisa-Sweatt', '  LISA   sweatt  ']) {
      assert.equal(foldOwnerName(written), 'lisa sweatt', `for ${JSON.stringify(written)}`)
    }
  })

  it('keeps digits, which clan names are full of', () => {
    assert.equal(foldOwnerName('Sam_2'), 'sam 2')
  })

  it('keeps letters outside ASCII, because a display name is a name', () => {
    assert.equal(foldOwnerName('Ünal'), 'ünal')
  })

  it('folds a label of nothing but punctuation to empty', () => {
    assert.equal(foldOwnerName('  --  '), '')
    assert.equal(foldOwnerName(''), '')
  })
})

describe('ownerOptions', () => {
  it('offers the enabled accounts in display order', () => {
    const options = ownerOptions([account(3, 'Sam'), account(1, 'casey'), account(2, 'Jared')])
    assert.deepEqual(
      options.map((option) => option.label),
      ['casey', 'Jared', 'Sam'],
    )
  })

  it('leaves disabled accounts out — a base pointed at one grants nobody the write', () => {
    const options = ownerOptions([account(1, 'Jared'), account(2, 'Gone', '2026-07-20T00:00:00Z')])
    assert.deepEqual(
      options.map((option) => option.userId),
      [1],
    )
  })

  it('keeps a disabled account when it is the row this cell is showing', () => {
    // Otherwise the select has no option for its own value and silently redraws
    // the row as somebody else.
    const accounts = [account(1, 'Jared'), account(2, 'Gone', '2026-07-20T00:00:00Z')]
    const options = ownerOptions(accounts, { userId: 2, label: 'Gone' })
    assert.deepEqual(
      options.map((option) => option.userId),
      [2, 1],
      'Gone sorts before Jared; what matters is that it is offered at all',
    )
  })

  it('keeps a current owner no account answers for', () => {
    // The owning account was deleted; the assignment survives it by design.
    const options = ownerOptions([account(1, 'Jared')], { userId: 9, label: 'Departed' })
    assert.deepEqual(options, [
      { userId: 9, label: 'Departed' },
      { userId: 1, label: 'Jared' },
    ])
  })

  it('does not duplicate the current owner when it is already offered', () => {
    const options = ownerOptions([account(1, 'Jared')], { userId: 1, label: 'Jared' })
    assert.deepEqual(options, [{ userId: 1, label: 'Jared' }])
  })

  it('orders ties by id, so the list does not reshuffle between fetches', () => {
    const options = ownerOptions([account(4, 'sam'), account(2, 'Sam')])
    assert.deepEqual(
      options.map((option) => option.userId),
      [2, 4],
    )
  })

  it('answers with nothing for a caller that has no account list', () => {
    // A non-admin never fetches one, and must not crash the cell.
    assert.deepEqual(ownerOptions([]), [])
  })
})

describe('suggestOwnerAccount', () => {
  it('catches the near miss the server backfill left behind', () => {
    const accounts = [account(1, 'lisa sweatt'), account(2, 'Jared')]
    assert.deepEqual(suggestOwnerAccount('lisa_sweatt', accounts), { userId: 1, label: 'lisa sweatt' })
  })

  it('suggests nothing when no account is close', () => {
    assert.equal(suggestOwnerAccount('Turtle', [account(1, 'Jared')]), null)
  })

  it('refuses to guess between two accounts that fold the same', () => {
    // A coin toss would hand a base, and the right to write its counts, to the
    // wrong person.
    const accounts = [account(1, 'Sam'), account(2, 'sam.')]
    assert.equal(suggestOwnerAccount('sam', accounts), null)
  })

  it('suggests nothing for a label with nothing in it', () => {
    assert.equal(suggestOwnerAccount('  ', [account(1, 'Jared')]), null)
  })

  it('matches a disabled account too, since the point is naming the person', () => {
    const accounts = [account(2, 'lisa sweatt', '2026-07-20T00:00:00Z')]
    assert.deepEqual(suggestOwnerAccount('lisa_sweatt', accounts), { userId: 2, label: 'lisa sweatt' })
  })
})

describe('ownerCellFor', () => {
  const accounts = [account(1, 'lisa sweatt'), account(7, 'Jared')]

  it('reads an unassigned base as unassigned', () => {
    assert.deepEqual(ownerCellFor(undefined, accounts), { kind: 'unassigned' })
  })

  it('reads a blank stored label as unassigned rather than as a label', () => {
    assert.deepEqual(ownerCellFor({ tag: '#A', owner: '   ' }, accounts), { kind: 'unassigned' })
  })

  it('reads a linked row as the account it points at', () => {
    assert.deepEqual(ownerCellFor(linked('#A', 'Jared', 7), accounts), {
      kind: 'account',
      userId: 7,
      label: 'Jared',
    })
  })

  it('reads an unlinked row as legacy, and carries the likely account', () => {
    assert.deepEqual(ownerCellFor(legacy('#A', 'lisa_sweatt'), accounts), {
      kind: 'legacy',
      label: 'lisa_sweatt',
      suggestion: { userId: 1, label: 'lisa sweatt' },
    })
  })

  it('reads a legacy row with no candidate as legacy all the same', () => {
    assert.deepEqual(ownerCellFor(legacy('#A', 'Turtle'), accounts), {
      kind: 'legacy',
      label: 'Turtle',
      suggestion: null,
    })
  })

  it('still names the owner when the caller has no account list', () => {
    // A member sees who owns the base; only the suggestion needs the admin list.
    assert.deepEqual(ownerCellFor(linked('#A', 'Jared', 7), []), {
      kind: 'account',
      userId: 7,
      label: 'Jared',
    })
    assert.deepEqual(ownerCellFor(legacy('#A', 'lisa_sweatt'), []), {
      kind: 'legacy',
      label: 'lisa_sweatt',
      suggestion: null,
    })
  })

  it('treats a missing ownerUserId the same as an explicit null', () => {
    // Fixtures and older payloads omit the field entirely.
    assert.equal(ownerCellFor({ tag: '#A', owner: 'Turtle' }, accounts).kind, 'legacy')
  })
})

describe('legacyOwnerCount', () => {
  it('counts only the rows still carrying an unlinked label', () => {
    const records = [
      linked('#A', 'Jared', 7),
      legacy('#B', 'Turtle'),
      legacy('#C', 'lisa_sweatt'),
      { tag: '#D', owner: '' },
    ]
    assert.equal(legacyOwnerCount(records), 2)
  })

  it('is zero once the migration is done', () => {
    assert.equal(legacyOwnerCount([linked('#A', 'Jared', 7)]), 0)
    assert.equal(legacyOwnerCount([]), 0)
  })
})

describe('parseOwnerChoice', () => {
  it('reads the empty option as a clear, which has to stay possible', () => {
    assert.deepEqual(parseOwnerChoice(''), { kind: 'clear' })
  })

  it('reads an account id as an assignment', () => {
    assert.deepEqual(parseOwnerChoice('12'), { kind: 'assign', userId: 12 })
  })

  it('refuses anything it never offered rather than coercing it', () => {
    // `Number('0')`, `Number(' 3 ')` and `Number('legacy')` would each be a write
    // nobody asked for — 0 is an account id that cannot exist.
    for (const value of ['0', '-1', '1.5', ' 3', 'legacy', 'NaN']) {
      assert.equal(parseOwnerChoice(value), null, `for ${JSON.stringify(value)}`)
    }
  })
})
