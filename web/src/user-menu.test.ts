import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionUser } from '@coc/shared'
import type { Theme } from './hooks.ts'
import {
  menuButtonLabel,
  nextTheme,
  THEME_CYCLE,
  themeLabel,
  userMenuItems,
} from './user-menu.ts'

const member: Pick<SessionUser, 'role'> = { role: 'user' }
const admin: Pick<SessionUser, 'role'> = { role: 'admin' }

const ids = (user: Pick<SessionUser, 'role'>) => userMenuItems(user).map((item) => item.id)

describe('userMenuItems', () => {
  it('gives a member help, what is new, their own password, propose a change and Sign out, and nothing else', () => {
    assert.deepEqual(ids(member), ['help', 'whatsNew', 'account', 'changeRequests', 'signOut'])
  })

  it('adds the admin panel for an admin', () => {
    assert.deepEqual(ids(admin), [
      'help',
      'whatsNew',
      'account',
      'changeRequests',
      'admin',
      'signOut',
    ])
  })

  it('offers help to a member as well as an admin, unlike the admin panel', () => {
    // The one entry with no version that is not theirs: a help page withheld from
    // members would be withheld from exactly the people most likely to need it.
    for (const user of [member, admin]) {
      assert.ok(
        userMenuItems(user).some((item) => item.id === 'help'),
        'help should be on every menu',
      )
    }
  })

  it('puts help first, where somebody who is stuck will look', () => {
    for (const user of [member, admin]) {
      assert.equal(userMenuItems(user)[0]?.id, 'help')
    }
  })

  it('points help at the whole page, not into a section', () => {
    // The `?` marks beside the panels are the deep links. Arriving from the menu,
    // nobody has said which part they want, and landing mid-page would look broken.
    assert.deepEqual(
      userMenuItems(member).find((item) => item.id === 'help')?.route,
      { view: 'help', section: null },
    )
  })

  it('offers what is new to everybody too, and keeps it beside help', () => {
    // The other page that is about the app rather than about the account. Adjacent to
    // help, not down beside Sign out, which is where actions live.
    for (const user of [member, admin]) {
      const order = ids(user)
      assert.equal(order.indexOf('whatsNew'), order.indexOf('help') + 1, `for ${user.role}`)
    }
  })

  it('points what is new at its own page', () => {
    assert.deepEqual(
      userMenuItems(member).find((item) => item.id === 'whatsNew')?.route,
      { view: 'whats-new', commit: null },
    )
  })

  it('omits the admin entry for a member rather than including it disabled', () => {
    // A grayed-out "Admin panel" tells a member their account is lacking; an absent
    // one says the feature is not theirs. The route is also refused on the page and
    // every /api/admin/* call is gated on the server — this is only the door.
    assert.equal(
      userMenuItems(member).some((item) => item.id === 'admin'),
      false,
    )
  })

  it('puts Sign out last, so it is not between two navigation items', () => {
    for (const user of [member, admin]) {
      const items = userMenuItems(user)
      assert.equal(items[items.length - 1]?.id, 'signOut')
    }
  })

  it('gives Sign out no route, and every other item one', () => {
    for (const item of userMenuItems(admin)) {
      if (item.id === 'signOut') assert.equal(item.route, null)
      else assert.notEqual(item.route, null, `${item.id} should navigate somewhere`)
    }
  })

  it('points its links at their own separate pages', () => {
    const items = userMenuItems(admin)
    assert.deepEqual(
      items.find((i) => i.id === 'account')?.route,
      { view: 'account' },
    )
    assert.deepEqual(
      items.find((i) => i.id === 'changeRequests')?.route,
      { view: 'change-requests' },
    )
    assert.deepEqual(items.find((i) => i.id === 'admin')?.route, { view: 'admin' })
  })

  it('labels and hints every item, so none is a bare word', () => {
    for (const item of userMenuItems(admin)) {
      assert.ok(item.label.length > 0, `${item.id} needs a label`)
      assert.ok(item.hint.length > 0, `${item.id} needs a hint`)
    }
  })

  it('does not mutate a shared array between calls', () => {
    const first = userMenuItems(admin)
    first.length = 0
    assert.equal(userMenuItems(admin).length, 6)
  })
})

describe('nextTheme', () => {
  it('cycles system → light → dark → system', () => {
    assert.equal(nextTheme('system'), 'light')
    assert.equal(nextTheme('light'), 'dark')
    assert.equal(nextTheme('dark'), 'system')
  })

  it('reaches all three states from any start, so none is stranded', () => {
    // `system` in particular: without it in the cycle, anybody whose OS switches at
    // dusk could not get back to following it without clearing storage.
    for (const start of THEME_CYCLE) {
      const seen = new Set<Theme>()
      let theme = start
      for (let step = 0; step < THEME_CYCLE.length; step += 1) {
        seen.add(theme)
        theme = nextTheme(theme)
      }
      assert.deepEqual([...seen].sort(), [...THEME_CYCLE].sort(), `starting from ${start}`)
      assert.equal(theme, start, 'the cycle returns to where it began')
    }
  })

  it('lands on system for a value it does not recognize', () => {
    // Storage is a string somebody could have edited, or a value an older build wrote.
    assert.equal(nextTheme('sepia' as Theme), 'system')
  })
})

describe('themeLabel', () => {
  it('names all three, each with its own glyph', () => {
    const labels = THEME_CYCLE.map(themeLabel)
    assert.equal(new Set(labels).size, THEME_CYCLE.length, 'no two themes read the same')
    for (const label of labels) assert.ok(/[A-Za-z]/.test(label), `"${label}" needs a word`)
  })
})

describe('menuButtonLabel', () => {
  it('names who is signed in, because a silhouette cannot', () => {
    const label = menuButtonLabel({ displayName: 'Anna', role: 'user' })
    assert.match(label, /Anna/)
    assert.match(label, /member/)
  })

  it('says admin for an admin', () => {
    assert.match(menuButtonLabel({ displayName: 'Bert', role: 'admin' }), /admin/)
  })

  it('says it is a menu, so the control is not mistaken for a link', () => {
    assert.match(menuButtonLabel({ displayName: 'Anna', role: 'user' }), /menu/i)
  })
})
