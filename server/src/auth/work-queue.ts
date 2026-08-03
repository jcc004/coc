/**
 * A promise queue that lets at most `limit` jobs run at once.
 *
 * It exists for one caller — scrypt (see `passwords.ts`) — and is a separate file
 * because the *policy* (how much memory a login may allocate) and the *mechanism*
 * (how work is deferred) are different decisions that change for different
 * reasons. The cap lives with the cost parameters it is derived from; this file
 * only knows how to make jobs wait.
 *
 * Why not a dependency: `p-limit` is a few lines of logic behind a package, and
 * this server takes no runtime dependency it can write itself in a screenful.
 *
 * Why not a semaphore over `Atomics`: there is one thread and one event loop, so
 * an array of resolvers is not merely sufficient, it is the whole problem.
 *
 * Fairness is FIFO, and that matters more than it looks. Under a login flood this
 * queue is what stands between the box and 100 concurrent 32 MiB allocations, so a
 * caller that arrived first must not be starved by a later arrival — otherwise the
 * flood no longer stalls the event loop but still starves the real user, which is
 * the same outcome by another route.
 */
export interface WorkQueue {
  /** Runs `job` once a slot is free, and releases the slot however it settles. */
  run<T>(job: () => Promise<T>): Promise<T>
  /** Jobs waiting for a slot. For tests and diagnostics, never for control flow. */
  readonly pending: number
}

export function createWorkQueue(limit: number): WorkQueue {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Work queue limit must be a positive integer, got ${limit}`)
  }

  let active = 0
  const waiting: (() => void)[] = []

  /**
   * The slot is **handed over** to the next waiter rather than freed and re-taken.
   *
   * Freeing it first would open a window between `active -= 1` and the woken job
   * actually resuming, in which a newly arrived caller sees a spare slot and takes
   * it — leaving the queue running `limit + 1` derivations at once, which is
   * precisely the allocation the cap exists to bound. Keeping `active` at the cap
   * while anyone is queued also makes FIFO automatic: a new arrival always finds
   * the queue full and joins the back of it.
   */
  function release(): void {
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }

  return {
    async run<T>(job: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiting.push(resolve))
      } else {
        active += 1
      }

      try {
        return await job()
      } finally {
        // `finally`, so a throwing job cannot leak a slot and wedge the queue
        // shut — a leaked slot is a permanent capacity loss, not a slow request.
        release()
      }
    },

    get pending() {
      return waiting.length
    },
  }
}
