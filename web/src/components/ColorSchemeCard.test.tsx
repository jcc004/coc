import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { colorSchemeKey, fitAccent, fitBanner } from '../color-scheme.ts'
import { installTestCleanup, sessionUser } from '../test-support.ts'
import { ColorSchemeCard } from './ColorSchemeCard.tsx'

/**
 * The rules are tested in `color-scheme.test.ts`; what is left for the component is
 * the part a pure test cannot see — that a choice reaches storage *and* the root
 * element, that a refused color reaches neither but does reach the screen, and that
 * Reset takes the variables back off.
 */

installTestCleanup()

const USER = sessionUser({ id: 7 })
const KEY = colorSchemeKey(7)

const stored = () => localStorage.getItem(KEY)
const rootValue = (name: string) => document.documentElement.style.getPropertyValue(name)

function card() {
  render(<ColorSchemeCard user={USER} />)
  return userEvent.setup()
}

describe('choosing a color', () => {
  it('writes the choice to this account and paints the root element', async () => {
    const user = card()

    await user.click(screen.getByRole('button', { name: 'Accent: Teal' }))

    assert.equal(stored(), JSON.stringify({ accent: '#12867f', chrome: null, banner: null }))
    const light = fitAccent('#12867f')
    assert.equal(light.status, 'fitted')
    if (light.status !== 'fitted') return
    assert.equal(rootValue('--user-accent-light'), light.light.roles.accent)
    assert.equal(rootValue('--user-accent-dark'), light.dark.roles.accent)
    // Neither plate nor banner was chosen, so the shipped gold is left to the
    // stylesheet — and `--banner` falls back through it, so the topbar is unmoved too.
    assert.equal(rootValue('--user-gold-light'), '')
    assert.equal(rootValue('--user-banner-light'), '')
  })

  it('marks the chosen swatch as pressed, so the selection is not only a ring', async () => {
    const user = card()
    const teal = screen.getByRole('button', { name: 'Accent: Teal' })

    assert.equal(teal.getAttribute('aria-pressed'), 'false')
    await user.click(teal)
    assert.equal(teal.getAttribute('aria-pressed'), 'true')
  })

  it('keeps the three roles independent', async () => {
    const user = card()

    await user.click(screen.getByRole('button', { name: 'Accent: Violet' }))
    await user.click(screen.getByRole('button', { name: 'Plate: Jade' }))

    assert.equal(stored(), JSON.stringify({ accent: '#7a4fd0', chrome: '#7fc9a8', banner: null }))
    assert.notEqual(rootValue('--user-gold-light'), '')
  })

  it('paints the banner without touching the plate, and the plate without the banner', async () => {
    // The reason the banner is a role of its own: choosing one must leave the panel
    // edges, the committing buttons and the card badge exactly where they were.
    const user = card()

    await user.click(screen.getByRole('button', { name: 'Banner: Sky' }))

    const fit = fitBanner('#a9cbe8')
    assert.equal(fit.status, 'fitted')
    if (fit.status !== 'fitted') return
    assert.equal(rootValue('--user-banner-light'), fit.light.roles.banner)
    assert.equal(rootValue('--user-banner-deep-dark'), fit.dark.roles.bannerDeep)
    assert.equal(rootValue('--user-gold-light'), '', 'the plate did not move')

    await user.click(screen.getByRole('button', { name: 'Plate: Copper' }))
    assert.equal(rootValue('--user-banner-light'), fit.light.roles.banner, 'the banner held')
    assert.equal(stored(), JSON.stringify({ accent: null, chrome: '#e08a4c', banner: '#a9cbe8' }))
  })

  it('writes no ink variable for the banner, because the ink is not a choice', async () => {
    const user = card()
    await user.click(screen.getByRole('button', { name: 'Banner: Lilac' }))
    assert.equal(rootValue('--user-on-banner-light'), '')
  })

  it('says which shade each theme was given, for all three roles', () => {
    card()
    // The other theme's shade is the one thing the live preview cannot show you, so
    // every role prints both of theirs.
    assert.equal(screen.getAllByText(/Light #/).length, 3)
    assert.equal(screen.getAllByText(/Dark #/).length, 3)
    // The light accent for the shipped blue is the deepened one, not #1f6cb0.
    assert.ok(screen.getByText(/Light #1c62a0/))
  })

  it('starts the banner block on the gold the topbar already wears', () => {
    card()
    assert.equal(
      screen.getByRole('button', { name: 'Banner: Gold' }).getAttribute('aria-pressed'),
      'false',
      'nothing is chosen yet, so nothing is pressed',
    )
    assert.ok(screen.getByText('The bar across the top. Left alone, it follows the plate.'))
  })
})

describe('a color the app cannot lend out', () => {
  it('says why, and does not store it', () => {
    card()

    fireEvent.change(screen.getByLabelText('Accent: choose any color'), {
      target: { value: '#00ff00' },
    })

    const message = screen.getByText(/Not available/)
    assert.match(message.textContent ?? '', /maxed/)
    assert.equal(stored(), null, 'nothing was written')
    assert.equal(rootValue('--user-accent-light'), '')
  })

  it('offers the nearest color that works, and applies it when pressed', async () => {
    const user = card()

    fireEvent.change(screen.getByLabelText('Accent: choose any color'), {
      target: { value: '#00ff00' },
    })
    await user.click(screen.getByRole('button', { name: /Use #/ }))

    assert.ok(stored(), 'the suggestion was stored')
    assert.equal(screen.queryByText(/Not available/), null)
  })
})

describe('reset', () => {
  it('is offered only once there is something to undo', async () => {
    const user = card()
    const reset = screen.getByRole('button', { name: /Reset/ })

    assert.equal((reset as HTMLButtonElement).disabled, true)
    await user.click(screen.getByRole('button', { name: 'Accent: Crimson' }))
    assert.equal((reset as HTMLButtonElement).disabled, false)
  })

  it('is offered when the banner alone is what was changed', async () => {
    const user = card()
    const reset = screen.getByRole('button', { name: /Reset/ })

    await user.click(screen.getByRole('button', { name: 'Banner: Sage' }))
    assert.equal((reset as HTMLButtonElement).disabled, false)
  })

  it('takes every variable back off the root element', async () => {
    const user = card()

    await user.click(screen.getByRole('button', { name: 'Accent: Crimson' }))
    await user.click(screen.getByRole('button', { name: 'Plate: Copper' }))
    await user.click(screen.getByRole('button', { name: 'Banner: Clay' }))
    await user.click(screen.getByRole('button', { name: /Reset/ }))

    // Not just the ones the last scheme wrote: a leftover variable would be a color
    // nobody can change again.
    for (const name of [
      '--user-accent-light',
      '--user-track-dark',
      '--user-gold-deep-light',
      '--user-banner-light',
      '--user-banner-edge-dark',
    ]) {
      assert.equal(rootValue(name), '', name)
    }
    assert.equal(stored(), JSON.stringify({ accent: null, chrome: null, banner: null }))
  })
})
