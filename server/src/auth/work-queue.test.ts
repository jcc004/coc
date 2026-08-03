import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createWorkQueue } from './work-queue.ts'

/** A job that resolves only when the returned `release` is called. */
function gated(): { job: () => Promise<void>; release: () => void; started: () => boolean } {
  let start = false
  let finish = (): void => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })

  return {
    job: async () => {
      start = true
      await done
    },
    release: () => finish(),
    started: () => start,
  }
}

describe('the scrypt concurrency queue', () => {
  it('never runs more than the cap at once', async () => {
    let active = 0
    let peak = 0
    const queue = createWorkQueue(3)

    const jobs = Array.from({ length: 20 }, () =>
      queue.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        // One turn of the loop, which is enough for every other queued job to have
        // been given the chance to start if the cap were not holding them.
        await new Promise((resolve) => setImmediate(resolve))
        active -= 1
      }),
    )

    await Promise.all(jobs)
    assert.equal(peak, 3, 'the cap is what bounds the 32 MiB-per-derivation allocation')
    assert.equal(active, 0)
    assert.equal(queue.pending, 0)
  })

  it('does not oversubscribe when a slot is freed and a new caller arrives', async () => {
    /*
     * The subtle one. Freeing the slot before the woken job resumes leaves a window
     * in which a newly arrived caller sees space and takes it, so `limit + 1` run
     * together — which is exactly the allocation the cap exists to bound. The slot is
     * handed straight to the next waiter instead, and this is the test that says so.
     */
    let active = 0
    let peak = 0
    const queue = createWorkQueue(1)

    const track = async (release: Promise<void>) => {
      active += 1
      peak = Math.max(peak, active)
      await release
      active -= 1
    }

    const first = gated()
    const second = gated()

    const a = queue.run(() => track(Promise.resolve().then(first.job)))
    const b = queue.run(() => track(Promise.resolve().then(second.job)))

    first.release()
    await a
    // Arrives in the same turn the slot is being handed over to `b`.
    const c = queue.run(async () => {
      active += 1
      peak = Math.max(peak, active)
      active -= 1
    })

    second.release()
    await Promise.all([b, c])
    assert.equal(peak, 1)
  })

  it('serves waiters in the order they arrived', async () => {
    // FIFO is not cosmetic: under a flood, a queue that let late arrivals in first
    // would starve the real user, which is the outage by another route.
    const queue = createWorkQueue(1)
    const finished: number[] = []

    const jobs = Array.from({ length: 6 }, (_, index) =>
      queue.run(async () => {
        await new Promise((resolve) => setImmediate(resolve))
        finished.push(index)
      }),
    )

    await Promise.all(jobs)
    assert.deepEqual(finished, [0, 1, 2, 3, 4, 5])
  })

  it('releases the slot when a job throws, so the queue cannot wedge shut', async () => {
    const queue = createWorkQueue(1)

    await assert.rejects(
      queue.run(async () => {
        throw new Error('scrypt said no')
      }),
      /scrypt said no/,
    )

    // A leaked slot is a permanent capacity loss rather than one slow request, so
    // the queue still working after a rejection is the property that matters.
    assert.equal(await queue.run(async () => 'still working'), 'still working')
    assert.equal(queue.pending, 0)
  })

  it('propagates a job’s value and its rejection unchanged', async () => {
    const queue = createWorkQueue(2)
    assert.equal(await queue.run(async () => 42), 42)
    await assert.rejects(queue.run(() => Promise.reject(new TypeError('bad params'))), TypeError)
  })

  it('refuses a cap that is not a positive integer', () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => createWorkQueue(limit), /positive integer/, `${limit} must be refused`)
    }
  })
})
