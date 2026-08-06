import type { ProgressSnapshot } from '@coc/shared'

/**
 * Rendering help for a snapshot's two notes fields — nothing more.
 *
 * `autoNote` is computed and stored by the server (`computeAutoNote`,
 * `server/src/progress/store.ts`) by diffing against the prior week. It is
 * **not recomputed here**: this module only decides how to lay the two
 * strings out for a reader, the same distinction `card-standings.ts` draws
 * between "carries the stamp through" and "formats a date" — the value
 * itself is somebody else's to own.
 */

/** What one row's notes area shows, joined for display. */
export interface NotesDisplay {
  /** Whether there was anything to show at all. */
  hasContent: boolean
  /** The auto-generated line, or `null` when there is none. */
  autoNote: string | null
  /** The hand-typed note, or `null` when there is none. */
  notes: string | null
  /**
   * Both joined into one string for a single-line context (a table cell, a
   * board summary): `autoNote` then `notes`, separated by an em dash so the
   * machine-written and hand-written halves stay visually distinct rather
   * than running together as one sentence. Either half alone is printed
   * as-is; neither present is `''`, not a placeholder word — the caller
   * decides what an empty notes cell says, the same way `lastUpdatedCell`
   * leaves the empty-vs-never distinction visible rather than papering over
   * it with a string.
   */
  combined: string
}

const JOINER = ' — '

/** Presence, trimmed: a whitespace-only note reads the same as no note. */
function present(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * `autoNote` and `notes`, ready for one line.
 *
 * Takes the two fields directly rather than a whole `ProgressSnapshot`, so a
 * caller assembling a summary from partial data (a diff preview, a form still
 * being edited) is not made to fabricate the rest of the row.
 */
export function combineNotes(
  autoNote: string | null,
  notes: string | null,
): NotesDisplay {
  const auto = present(autoNote)
  const manual = present(notes)

  const combined = auto && manual ? `${auto}${JOINER}${manual}` : (auto ?? manual ?? '')

  return {
    hasContent: auto !== null || manual !== null,
    autoNote: auto,
    notes: manual,
    combined,
  }
}

/** {@link combineNotes}, reading straight off a snapshot. */
export function combineSnapshotNotes(
  snapshot: Pick<ProgressSnapshot, 'autoNote' | 'notes'>,
): NotesDisplay {
  return combineNotes(snapshot.autoNote, snapshot.notes)
}
