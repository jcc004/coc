import type { UserRole } from '@coc/shared'

/**
 * The one answer to "may this user change this base's card counts".
 *
 * It is a pure function, in its own file, with its own tests, because it is the
 * only interesting authorisation decision in the app and the temptation is to
 * spell it out inline in the handler. Spread across handlers it would drift: one
 * place would forget the admin case, another would treat an unowned base as fair
 * game, and nobody could state the rule without reading three files. Here it can
 * be read in one screen and tested without a database, a session or an HTTP call.
 *
 * The rules, in the order they apply:
 *
 * 1. A disabled account writes nothing — not even an admin's. Sessions are already
 *    revoked on disable, so this is defence in depth rather than the enforcement.
 * 2. The owning account writes its own base. That is the point of the change.
 * 3. An **admin** writes any base. Not a loophole, a deliberate decision: an admin
 *    can reassign ownership to themselves at will, so refusing them the direct
 *    write would stop nothing and would remove their only way to fix a mistake
 *    somebody else made.
 * 4. Anyone else is refused, and the refusal names the owner — "belongs to Jared"
 *    is actionable, "forbidden" is a wall.
 * 5. A base **nobody's account owns** is writable by admins only. That covers two
 *    shapes: no assignment at all, and an assignment carrying only a legacy text
 *    label that has never been matched to an account. In both, nobody has a claim
 *    to it, and the text label is a note about a person rather than a permission
 *    granted to a session.
 */

export interface BaseWriter {
  id: number
  role: UserRole
  /**
   * True for an account an admin has switched off. Optional because a session
   * user is never disabled in practice — `resolveSession` drops the session the
   * moment the account is — so the ordinary caller has nothing to pass.
   */
  disabled?: boolean
}

/** A base's ownership as the store reports it, flattened to what the rule needs. */
export interface BaseOwnership {
  /** Canonical `#TAG`, used to name the base in a refusal. */
  tag: string
  /** The owning account, or `null` when no account owns this base. */
  ownerUserId: number | null
  /**
   * What to call the owner: the account's display name, or the unresolved legacy
   * text. `null` when there is no assignment at all.
   */
  ownerLabel: string | null
}

export type BaseWriteRefusal = 'accountDisabled' | 'notOwner' | 'ownerNotLinked' | 'unowned'

export type BaseWriteDecision =
  | { allowed: true }
  | { allowed: false; refusal: BaseWriteRefusal; message: string }

const ALLOWED: BaseWriteDecision = { allowed: true }

export function mayWriteBaseCounts(writer: BaseWriter, base: BaseOwnership): BaseWriteDecision {
  if (writer.disabled) {
    return {
      allowed: false,
      refusal: 'accountDisabled',
      message: 'Your account has been disabled, so it cannot change any card counts.',
    }
  }

  if (base.ownerUserId !== null && base.ownerUserId === writer.id) return ALLOWED

  const isAdmin = writer.role === 'admin'
  if (isAdmin) return ALLOWED

  if (base.ownerUserId !== null) {
    return {
      allowed: false,
      refusal: 'notOwner',
      message: `${base.tag} belongs to ${base.ownerLabel ?? 'another member'}. Only ${
        base.ownerLabel ?? 'its owner'
      } or an admin can change its card counts.`,
    }
  }

  if (base.ownerLabel !== null) {
    return {
      allowed: false,
      refusal: 'ownerNotLinked',
      message: `${base.tag} is recorded as ${base.ownerLabel}'s, but that name is not linked to an account, so nobody holds the base yet. An admin can assign it.`,
    }
  }

  return {
    allowed: false,
    refusal: 'unowned',
    message: `${base.tag} has no owner, so only an admin can change its card counts. Ask an admin to assign it to you.`,
  }
}
