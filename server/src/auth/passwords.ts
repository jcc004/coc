import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

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

function derive(password: string, salt: Buffer, params: ScryptCost, keyLength: number): Buffer {
  return scryptSync(password, salt, keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAXMEM,
  })
}

export function hashPassword(password: string): PasswordRecord {
  const salt = randomBytes(SALT_BYTES)
  return { hash: encode(COST, derive(password, salt, COST, KEY_LENGTH)), salt: salt.toString('hex') }
}

export function verifyPassword(password: string, record: PasswordRecord): boolean {
  const stored = decode(record.hash)
  if (!stored || stored.key.length === 0) return false

  const candidate = derive(
    password,
    Buffer.from(record.salt, 'hex'),
    { N: stored.N, r: stored.r, p: stored.p },
    stored.key.length,
  )

  // Lengths match by construction, but timingSafeEqual throws if they ever don't.
  return candidate.length === stored.key.length && timingSafeEqual(candidate, stored.key)
}

/**
 * A real record for a password nobody knows. A login for an unknown username
 * verifies against this, so the unknown-user and wrong-password paths do the
 * same scrypt work and cannot be told apart by how long they take.
 */
const DECOY = hashPassword(randomBytes(32).toString('hex'))

export function burnPasswordWork(password: string): void {
  verifyPassword(password, DECOY)
}
