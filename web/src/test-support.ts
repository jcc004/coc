import { afterEach, mock } from 'node:test'
import { cleanup } from '@testing-library/react'
import type { AdminUser, SessionUser } from '@coc/shared'
import { api } from './api.ts'
import { resetCardInventory } from './card-inventory.ts'
import { resetOwners } from './owners.ts'
import { resetProgress, resetProgressReference } from './progress.ts'
import { resetSavedClans } from './saved-clans.ts'
import { resetTrades } from './trades.ts'

/**
 * The scaffolding the component tests share: account fixtures, a stubbed `api`, and
 * the teardown that makes one test's world invisible to the next.
 *
 * A module rather than a copy in each test file because the teardown is the part that
 * bites: the shared lists live in **module-level** stores (`owners.ts`,
 * `card-inventory.ts`, …), so a roster rendered in one test still holds its owners
 * when the next one mounts, and the second test passes or fails on the first one's
 * fixtures. Five `reset*` calls in one place is the difference between that being
 * handled and being remembered.
 */

/** A signed-in member. Overrides last, so a test names only what it cares about. */
export function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 1,
    guid: '00000000-0000-4000-8000-000000000001',
    displayName: 'Rae',
    email: 'rae@example.com',
    role: 'user',
    createdAt: '2026-07-01T09:00:00.000Z',
    mustChangePassword: false,
    ...overrides,
  }
}

/** The same account as `GET /api/admin/users` describes it. */
export function adminAccount(overrides: Partial<AdminUser> = {}): AdminUser {
  return { ...sessionUser(overrides), disabledAt: null, ...overrides }
}

export type ApiStubs = { [K in keyof typeof api]?: (typeof api)[K] }

/**
 * Replaces the named `api` methods, and makes `fetch` itself throw.
 *
 * The fence matters more than the stubs. A component test mounts a subtree, and a
 * subtree fetches — so the failure mode without it is not "the test hits the network",
 * it is "the test passes on a request nobody noticed and then fails in CI where
 * nothing answers". Anything unstubbed now names itself.
 *
 * Methods a test wants to *assert on* should be stubbed with `mock.method` directly,
 * which hands back the recorded calls; this is for the background.
 */
export function stubApi(stubs: ApiStubs): void {
  for (const name of Object.keys(stubs) as (keyof typeof api)[]) {
    const implementation = stubs[name]
    // The cast is the price of iterating a union of method names: TypeScript pairs
    // `name` and `implementation` independently and cannot see they came from the
    // same key. Narrowing per method would mean thirty branches for nothing.
    if (implementation) mock.method(api, name, implementation as never)
  }

  mock.method(globalThis, 'fetch', (input: unknown) => {
    throw new Error(`Unstubbed request in a test: ${String(input)}`)
  })
}

/**
 * Registers the teardown every component test needs. Called once at the top of a
 * test file rather than hidden in an imported side effect, so the file says what it
 * relies on.
 *
 * `cleanup()` is Testing Library's, and it is not automatic here: the auto-cleanup it
 * ships is wired to a global `afterEach` that only jest and vitest provide. Without
 * it every render stays in `document.body` and `getByText` starts matching a previous
 * test's markup.
 */
export function installTestCleanup(): void {
  afterEach(() => {
    cleanup()
    mock.restoreAll()
    resetOwners()
    resetSavedClans()
    resetCardInventory()
    resetTrades()
    resetProgress()
    resetProgressReference()
    localStorage.clear()
  })
}
