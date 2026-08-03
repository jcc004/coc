import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createWorkQueue } from './work-queue.ts'

/**
 * Password hashing: scrypt, per-user random salt, constant-time comparison.
 *
 * Cost: N = 2^15, r = 8, p = 1, 64-byte key.
 *
 * Why those numbers. scrypt's memory cost is 128 · N · r, so N = 2^15 with r = 8
 * is 32 MiB and one hash — measured ~40 ms on a dev laptop, so budget 100 ms on a
 * small shared VPS. OWASP's floor for
 * scrypt is N = 2^17 (128 MiB); that is deliberately not used here because a
 * login would then allocate 128 MiB on the same box that serves the app, and
 * with ≤10 accounts, no open signup, and a 12-character minimum, 2^15 already
 * puts offline guessing far out of reach for the threat this actually faces
 * (someone who has stolen the SQLite file). Raise N if the host gets bigger —
 * see the migration note below, old hashes keep verifying.
 *
 * `maxmem` has to be passed explicitly: Node's default is 32 MiB, which is
 * *exactly* this configuration's requirement, and it rejects rather than rounds.
 *
 * **Everything here is asynchronous, and that is an availability property rather
 * than a style preference.** `scryptSync` holds the single event loop for the
 * whole ~40 ms, so ~25 unauthenticated login attempts per second saturate the
 * process and nothing else — health checks, other users, the SPA's own API calls —
 * gets served. The callback form runs the derivation on a libuv threadpool thread,
 * so the loop stays free to answer. The encoded format and the comparison are
 * untouched, so every hash written by the synchronous version still verifies.
 */
interface ScryptCost {
  N: number
  r: number
  p: number
}

const COST: ScryptCost = { N: 32768, r: 8, p: 1 }
const KEY_LENGTH = 64
const MAXMEM = 64 * 1024 * 1024
const SALT_BYTES = 16

/**
 * How many derivations may be in flight at once.
 *
 * The arithmetic: one derivation at N = 2^15, r = 8 costs 128 · N · r = 32 MiB,
 * held for its whole ~40 ms. Async scrypt on its own removes the event-loop stall
 * but not the memory — 100 concurrent logins would ask for 100 × 32 MiB = 3.2 GiB
 * and the process would be OOM-killed instead of merely slow, which is a worse
 * failure than the one being fixed. Four slots is 128 MiB of peak transient
 * allocation, which the 1 GiB VPS this runs on can absorb alongside Node's own
 * heap, and it is also the point past which more parallelism buys nothing: libuv's
 * default threadpool is four threads, so a fifth concurrent derivation would queue
 * inside libuv anyway — where it would be holding its 32 MiB while waiting, rather
 * than waiting first and allocating second.
 *
 * The cost of the cap is latency under a flood: the fifth simultaneous login waits
 * ~40 ms for a slot. That is the right trade — a queued login is a slow login, an
 * unbounded one is an outage.
 */
const CONCURRENCY = 4

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const derivations = createWorkQueue(CONCURRENCY)

export interface PasswordRecord {
  /** `scrypt$N$r$p$<hex>` — see `verifyPassword`. */
  hash: string
  salt: string
}

/**
 * The cost parameters are stored *in* the hash string rather than assumed, so
 * raising N later leaves every existing hash verifiable instead of locking
 * everyone out of an account they still know the password to.
 */
function encode(params: ScryptCost, derived: Buffer): string {
  return `scrypt$${params.N}$${params.r}$${params.p}$${derived.toString('hex')}`
}

function decode(hash: string): { N: number; r: number; p: number; key: Buffer } | undefined {
  const parts = hash.split('$')
  if (parts.length !== 5 || parts[0] !== 'scrypt') return undefined

  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  const hex = parts[4]
  if (!hex || !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined

  return { N, r, p, key: Buffer.from(hex, 'hex') }
}

function derive(
  password: string,
  salt: Buffer,
  params: ScryptCost,
  keyLength: number,
): Promise<Buffer> {
  return derivations.run(() =>
    scryptAsync(password, salt, keyLength, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: MAXMEM,
    }),
  )
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await derive(password, salt, COST, KEY_LENGTH)
  return { hash: encode(COST, derived), salt: salt.toString('hex') }
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const stored = decode(record.hash)
  if (!stored || stored.key.length === 0) return false

  const candidate = await derive(
    password,
    Buffer.from(record.salt, 'hex'),
    { N: stored.N, r: stored.r, p: stored.p },
    stored.key.length,
  )

  // Lengths match by construction, but timingSafeEqual throws if they ever don't.
  return candidate.length === stored.key.length && timingSafeEqual(candidate, stored.key)
}

/**
 * A real record for a password nobody knows. A login for an unknown email
 * verifies against this, so the unknown-user and wrong-password paths do the
 * same scrypt work and cannot be told apart by how long they take.
 *
 * Started at import time and never awaited here, which is deliberate on both
 * counts. Awaiting it at module scope would make importing `passwords.ts` cost
 * 40 ms for every caller, including the ones that only ever hash; deriving it
 * lazily on the first miss would make that one miss cost *two* derivations while a
 * hit cost one, which is the timing oracle this decoy exists to close, merely
 * narrowed to the first attempt after a restart. Kicking it off unawaited costs
 * nothing on the loop and is resolved long before a request arrives.
 */
const DECOY: Promise<PasswordRecord> = hashPassword(randomBytes(32).toString('hex'))

export async function burnPasswordWork(password: string): Promise<void> {
  await verifyPassword(password, await DECOY)
}
