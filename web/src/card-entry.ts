import { MAX_CARD_COUNT, type OwnerRecord, type SessionUser } from '@coc/shared'
import { ApiError } from './api.ts'

/**
 * The rules behind the card grid's entry form: who may type in it, and when a blur
 * is worth a request.
 *
 * Both used to be inline in `BaseCardEditor` — or, in the write-access case, only on
 * the server. They are here because each has a *wrong* answer that costs something
 * real and neither is visible in a screenshot:
 *
 * - a save fired on every blur churns `updated_at`, and `updated_at` is what the
 *   panel's "last updated by" line reads. Tab across sixty fields and the base
 *   claims somebody checked it sixty times when they only scrolled past;
 * - a client that does not know the write rule lets a member type a count the
 *   server is going to refuse, which is a lie told at the moment of typing.
 *
 * `cardEntryAccess` mirrors `server/src/cards/write-access.ts`. The server is still
 * the enforcement — this is only so the UI stops offering what will be refused —
 * but the two must agree, so both are one pure function with its own tests.
 *
 * `cardCountStep` joined them when the count grew a `−` and a `+` beside it, for the
 * third version of the same reason: whether a stepper is *offered* and where a press
 * *lands* have to be one answer, and computed inline in the component they were two.
 */

/* ---------- who may write ---------- */

/** A base's ownership as `GET /api/owners` reports it, or nothing at all. */
export interface BaseOwner {
  /** The owning account, or `null` for a row that is only a text label. */
  ownerUserId: number | null
  /** What to call the owner: an account's display name, or the legacy text. */
  ownerLabel: string | null
}

export type CardEntryRefusal = 'notOwner' | 'ownerNotLinked' | 'unowned'

export type CardEntryAccess =
  | { writable: true }
  | { writable: false; refusal: CardEntryRefusal; message: string }

/** Flattens an owner record — present or absent — into what the rule needs. */
export function baseOwnerOf(record: OwnerRecord | undefined): BaseOwner {
  return {
    ownerUserId: record?.ownerUserId ?? null,
    ownerLabel: record?.owner ?? null,
  }
}

/**
 * May this session type counts into this base?
 *
 * The same three refusals the server draws, in the same order, and each names the
 * owner where there is one — "belongs to Jared" tells you who to ask, "forbidden"
 * tells you to give up. An unowned base, and a base carrying only an unlinked
 * legacy label, are both admin-only: a label is a note about a person, not a
 * permission granted to a session.
 */
export function cardEntryAccess(
  user: Pick<SessionUser, 'id' | 'role'>,
  base: BaseOwner,
  tag: string,
): CardEntryAccess {
  if (base.ownerUserId !== null && base.ownerUserId === user.id) return { writable: true }
  if (user.role === 'admin') return { writable: true }

  if (base.ownerUserId !== null) {
    const owner = base.ownerLabel ?? 'another member'
    return {
      writable: false,
      refusal: 'notOwner',
      message: `${tag} belongs to ${owner}. Only ${owner} or an admin can change its card counts.`,
    }
  }

  if (base.ownerLabel !== null) {
    return {
      writable: false,
      refusal: 'ownerNotLinked',
      message: `${tag} is recorded as ${base.ownerLabel}'s, but that name is not linked to an account, so nobody holds the base yet. An admin can assign it.`,
    }
  }

  return {
    writable: false,
    refusal: 'unowned',
    message: `${tag} has no owner, so only an admin can change its card counts. Ask an admin to assign it to you.`,
  }
}

/* ---------- stepping a count by one ---------- */

/**
 * Where a `−` or `+` press lands, or `null` when the bound leaves it nowhere to go.
 *
 * **One function, not a `step` and a `canStep`.** The button's disabled state and what
 * its press does are the same question, and asked twice they can disagree: a `+` still
 * offered at ten either clamps — a control that answers a press by doing nothing, which
 * is the dead end this grid already refuses to hand out sixty times — or it writes an
 * eleventh copy the server would reject. `null` is that decision, and the component
 * reads it for both.
 *
 * The count is clamped on the way **in** as well as out. Nothing should ever store a
 * count outside 0…{@link MAX_CARD_COUNT}, but if one arrived, `−` on an eleven has to
 * step back *into* range rather than confirming it, and `+` has to be unavailable
 * rather than making it worse.
 */
export function cardCountStep(count: number, by: 1 | -1): number | null {
  // A non-number is treated as no copies, the same reading `clampCardCount` gives an
  // unparseable box: it is the only value that cannot be wrong in the other direction.
  const whole = Number.isFinite(count) ? Math.trunc(count) : 0
  const from = Math.min(Math.max(whole, 0), MAX_CARD_COUNT)
  const next = from + by
  if (next < 0 || next > MAX_CARD_COUNT) return null
  return next
}

/* ---------- when a blur is worth a request ---------- */

export type CardCounts = ReadonlyMap<number, number>

/**
 * Whether two count maps hold different numbers.
 *
 * Zero and absent are the same holding, so a map with `{7: 0}` equals an empty one:
 * the draft deletes a card on its way to zero but a stale entry must not be read as
 * a change and trigger a write of nothing.
 */
export function countsDiffer(a: CardCounts, b: CardCounts): boolean {
  for (const [id, count] of a) if ((b.get(id) ?? 0) !== count) return true
  for (const [id, count] of b) if ((a.get(id) ?? 0) !== count) return true
  return false
}

export type SkipReason = 'sameCell' | 'unchanged' | 'notWritable' | 'busy'

export type BlurDecision = { save: true } | { save: false; reason: SkipReason }

/**
 * What to do when focus leaves a count control.
 *
 * `sameCell` is the one the stepper buttons added, and it is first because it is not a
 * departure at all. A cell is two controls — `−`, `+` — and pressing one moves focus
 * off the other, so a rule that saved on every blur would turn five presses of `+`
 * into five whole-base writes, each one moving `updated_at`. Focus landing on the
 * *other* stepper in the same cell is a user still working on one card; the commit
 * waits for them to leave it. Which is the same instinct as `unchanged`, one level
 * up: the question is never "did a stepper lose focus" but "is there now a number the
 * server has not been told about, and has the user finished saying it".
 *
 * `unchanged` is the case that matters most: it is compared against the **last value
 * the server accepted**, not against the value the field started the focus with,
 * so retyping the same number, or arrowing up and back down, is silent too.
 *
 * `busy` defers rather than dropping — the caller re-checks once the request it is
 * waiting on lands, because the edit that arrived mid-flight still has to be saved.
 */
export function blurDecision(input: {
  draft: CardCounts
  /** The counts the server is known to hold, from the last successful write or read. */
  saved: CardCounts
  writable: boolean
  saving: boolean
  /**
   * Whether focus went to the same card's other stepper — its own `−` or `+` —
   * rather than out of the cell entirely.
   */
  focusStaysInCell: boolean
}): BlurDecision {
  if (input.focusStaysInCell) return { save: false, reason: 'sameCell' }
  if (!input.writable) return { save: false, reason: 'notWritable' }
  if (!countsDiffer(input.draft, input.saved)) return { save: false, reason: 'unchanged' }
  if (input.saving) return { save: false, reason: 'busy' }
  return { save: true }
}

/* ---------- reporting a failure ---------- */

/**
 * A 403 is an expected outcome now, not a fault — so it is reported as the rule it
 * is ("this base is not yours") rather than as a breakage ("the write failed"),
 * which is the difference between telling somebody the answer and telling them to
 * try again. Everything else keeps the retry wording, because everything else might
 * work next time.
 */
export type SaveFailure = { kind: 'refused' | 'failed'; message: string }

export function classifySaveFailure(cause: unknown, tag: string): SaveFailure {
  if (cause instanceof ApiError && cause.status === 403) {
    return { kind: 'refused', message: cause.message }
  }
  if (cause instanceof Error && cause.message) {
    return { kind: 'failed', message: cause.message }
  }
  return { kind: 'failed', message: `Could not reach the server to save ${tag}.` }
}
