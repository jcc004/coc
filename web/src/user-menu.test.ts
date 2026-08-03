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
  it('gives a member their own password and Sign out, and nothing else', () => {
    assert.deepEqual(ids(member), ['account', 'signOut'])
  })

  it('adds the admin panel for an admin', () => {
    assert.deepEqual(ids(admin), ['account', 'admin', 'signOut'])
  })

  it('omits the admin entry for a member rather than including it disabled', () => {
    // A greyed-out "Admin panel" tells a member their account is lacking; an absent
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

  it('points its two links at the two separate pages', () => {
    const items = userMenuItems(admin)
    assert.deepEqual(
      items.find((i) => i.id === 'account')?.route,
      { view: 'account' },
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
    assert.equal(userMenuItems(admin).length, 3)
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

  it('lands on system for a value it does not recognise', () => {
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
