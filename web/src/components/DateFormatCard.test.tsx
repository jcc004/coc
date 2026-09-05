import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { dateFormatKey, DEFAULT_DATE_FORMAT } from '../date-format.ts'
import { installTestCleanup, sessionUser } from '../test-support.ts'
import { DateFormatCard } from './DateFormatCard.tsx'

/**
 * The rules (every order × separator × hour-cycle combination) are
 * `date-format.test.ts`'s job. What is left for the component, mirroring
 * `ColorSchemeCard.test.tsx`: that a choice reaches storage, that the preview
 * updates to match, and that Reset takes it back to the default.
 */

installTestCleanup()

const USER = sessionUser({ id: 7 })
const KEY = dateFormatKey(7)

const stored = () => localStorage.getItem(KEY)

function card() {
  render(<DateFormatCard user={USER} />)
  return userEvent.setup()
}

describe('choosing a date/time format', () => {
  it('starts on the default, unstored', () => {
    card()
    assert.equal(stored(), null)
    assert.ok(screen.getByText('You are on the default format.'))
  })

  it('a preset writes the whole preference to this account and updates the preview', async () => {
    const user = card()

    await user.click(screen.getByRole('button', { name: /^ISO —/ }))

    assert.equal(stored(), JSON.stringify({ order: 'YMD', separator: '-', hourCycle: '24h' }))
    assert.ok(screen.getByText('2026-08-24, 17:42'))
  })

  it('marks the chosen preset as pressed', async () => {
    const user = card()
    const iso = screen.getByRole('button', { name: /^ISO —/ })

    assert.equal(iso.getAttribute('aria-pressed'), 'false')
    await user.click(iso)
    assert.equal(iso.getAttribute('aria-pressed'), 'true')
  })

  it('changing one field alone leaves the others as they were', async () => {
    const user = card()

    await user.selectOptions(screen.getByLabelText('Hour cycle'), '24h')
    assert.equal(
      stored(),
      JSON.stringify({ ...DEFAULT_DATE_FORMAT, hourCycle: '24h' }),
    )

    await user.selectOptions(screen.getByLabelText('Date order'), 'DMY')
    assert.equal(
      stored(),
      JSON.stringify({ ...DEFAULT_DATE_FORMAT, order: 'DMY', hourCycle: '24h' }),
    )
  })

  it('changing the separator updates the preview', async () => {
    const user = card()
    await user.selectOptions(screen.getByLabelText('Date separator'), '-')
    assert.ok(screen.getByText('08-24-2026, 5:42 PM'))
  })
})

describe('reset', () => {
  it('is offered only once there is something to undo', async () => {
    const user = card()
    const reset = screen.getByRole('button', { name: /Reset/ })

    assert.equal((reset as HTMLButtonElement).disabled, true)
    await user.click(screen.getByRole('button', { name: /^ISO —/ }))
    assert.equal((reset as HTMLButtonElement).disabled, false)
  })

  it('puts every field, and storage, back to the default', async () => {
    const user = card()

    await user.click(screen.getByRole('button', { name: /^ISO —/ }))
    await user.click(screen.getByRole('button', { name: /Reset/ }))

    assert.equal(stored(), JSON.stringify(DEFAULT_DATE_FORMAT))
    assert.ok(screen.getByText('You are on the default format.'))
    assert.equal(screen.getByLabelText<HTMLSelectElement>('Date order').value, DEFAULT_DATE_FORMAT.order)
  })
})
