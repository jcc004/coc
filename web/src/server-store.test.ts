import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError } from './api.ts'
import { createServerStore } from './server-store.ts'

/**
 * `mutate`'s failure branch, the one behind the trade tracker's "click Complete
 * twice" bug (2026-08-08): a rejected write used to leave the snapshot's `entries`
 * exactly as they were before the write, so a caller gated on the stale copy (the
 * trade tracker's resolve button, checking `status === 'pending'`) kept offering
 * an action the server had already rejected. These pin the fix — a failed write
 * refreshes the same as a successful one — directly against the store, without
 * needing a whole component around it.
 */

describe('mutate refreshes on a rejected write, not only a successful one', () => {
  it('reloads after the write throws, so a stale entry does not survive the failure', async () => {
    const entriesAfterConflict = [{ id: 1, status: 'complete' }]
    let loadCalls = 0
    const store = createServerStore<{ id: number; status: string }>(async () => {
      loadCalls += 1
      return entriesAfterConflict
    })

    // Seed the snapshot with the stale, pre-conflict state a caller would be
    // holding — the same shape the trade tracker's row reads from.
    await store.load()
    loadCalls = 0

    const conflict = new ApiError(409, 'alreadyResolved', 'Already marked complete by someone else.')
    await assert.rejects(
      () => store.mutate(() => Promise.reject(conflict)),
      (thrown: unknown) => thrown === conflict,
    )

    assert.equal(loadCalls, 1, 'a failed write must trigger exactly one refresh')
    assert.deepEqual(store.peek(), entriesAfterConflict)
  })

  it('still rethrows the original write error even when the follow-up refresh also fails', async () => {
    let loadAttempts = 0
    const store = createServerStore<{ id: number }>(async () => {
      loadAttempts += 1
      if (loadAttempts === 1) return [{ id: 1 }] // the seeding load
      throw new ApiError(0, 'network', 'Could not reach the server.')
    })
    await store.load()

    const writeFailure = new ApiError(409, 'alreadyResolved', 'Already resolved.')
    await assert.rejects(
      () => store.mutate(() => Promise.reject(writeFailure)),
      /* The write's own error, not the refresh's — a caller reporting "why did my
         click fail" must hear about the conflict, not an unrelated refresh hiccup
         that happened while it was cleaning up. */
      (thrown: unknown) => thrown === writeFailure,
    )
  })

  it('still refreshes after a successful write, unchanged from before this fix', async () => {
    let loadCalls = 0
    const entries = [{ id: 1 }]
    const store = createServerStore<{ id: number }>(async () => {
      loadCalls += 1
      return entries
    })

    const result = await store.mutate(async () => 'ok')

    assert.equal(result, 'ok')
    assert.equal(loadCalls, 1)
    assert.deepEqual(store.peek(), entries)
  })
})

/**
 * `mutate`'s post-write refresh used to be a plain `load()`, which hands back
 * whatever request is already in flight rather than starting a fresh one. A
 * poll's GET issued just before a save completes stays in flight through the
 * save, so that reused request was reading the server *before* the write — and
 * its answer, arriving after the write's own refresh, would silently overwrite
 * the just-saved data with the stale pre-write snapshot. These pin the fix: a
 * refresh triggered by `mutate` always issues its own request, and a response
 * from an older, superseded request is dropped rather than committed —
 * regardless of which one's network round trip happens to finish first.
 */
/** Flushes pending microtasks — `await write()` inside `mutate` needs at least
 *  one tick before its `startLoad()` call actually runs. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('mutate never lets a stale in-flight response win the race', () => {
  it('keeps the post-write data even when an earlier poll resolves after it', async () => {
    type Row = { id: number; count: number }
    const responses: { resolve: (rows: Row[]) => void }[] = []
    const store = createServerStore<Row>(
      () => new Promise<Row[]>((resolve) => responses.push({ resolve })),
    )

    // A poll's GET starts first, and is still in flight when the write below
    // completes — exactly the window the bug lived in.
    const pollPromise = store.load()
    assert.equal(responses.length, 1)

    const mutatePromise = store.mutate(async () => 'saved')
    await flush()
    // `mutate`'s own refresh must be a second, independent request rather than
    // the poll's — the whole point of the fix.
    assert.equal(responses.length, 2, 'the write must trigger its own fresh load')

    // The write's own refresh resolves first, carrying the post-write count...
    responses[1]?.resolve([{ id: 1, count: 5 }])
    await mutatePromise

    // ...and only then does the stale poll — issued before the write — resolve,
    // carrying the pre-write count it originally read.
    responses[0]?.resolve([{ id: 1, count: 1 }])
    await pollPromise

    assert.deepEqual(
      store.peek(),
      [{ id: 1, count: 5 }],
      'the late-arriving pre-write response must not overwrite the saved data',
    )
  })
})
