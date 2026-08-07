import { useState } from 'react'

/**
 * The wall-level editor's row shape and state, shared by every place this app
 * lets a person hand-type wall counts: `ManualCaptureForm`'s current-week
 * entry and the past-week correction form beside it on `PlayerProgressPanel.tsx`.
 * Both used to carry their own copy of this — `wallsToRows`/`rowsToWalls` were
 * private to `ManualCaptureForm` before the past-week form needed the exact
 * same row-editing logic, which is what moved it here rather than duplicating
 * a second copy of validation/parsing that has to stay in sync with the first.
 *
 * Kept a plain-text `WallRow` (level and count as strings, not numbers) for
 * the same reason the original did: an input mid-typed — `'1'` on the way to
 * `'17'`, or empty while a row is still being filled in — has to be a valid
 * row shape too, which a `number` field can't represent without losing what
 * the person actually typed.
 */

/** One row of the sparse `walls` map, mid-edit — a level and a count, both as text. */
export interface WallRow {
  key: string
  level: string
  count: string
}

/** `walls`, as editable rows — one per level, sorted ascending. An empty/`null` map still needs one blank starter row. */
export function wallsToRows(walls: Record<string, number> | null): WallRow[] {
  const entries = Object.entries(walls ?? {})
  if (entries.length === 0) return [{ key: crypto.randomUUID(), level: '', count: '' }]
  return entries
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, count]) => ({ key: crypto.randomUUID(), level, count: String(count) }))
}

/**
 * Rows to the sparse wire shape. A row with no level, or one that is not a whole
 * non-negative number, is dropped rather than sent — the same "whole request or
 * nothing coherent" stance `parseManualCapture` takes server-side, applied to one
 * row instead of the whole payload so an editor mid-typed-row does not block the
 * levels already finished.
 */
export function rowsToWalls(rows: WallRow[]): Record<string, number> {
  const walls: Record<string, number> = {}
  for (const row of rows) {
    const level = row.level.trim()
    const count = Number(row.count)
    if (!/^\d+$/.test(level) || !Number.isFinite(count) || count < 0) continue
    walls[level] = Math.max(0, Math.trunc(count))
  }
  return walls
}

/**
 * What a `WallRow[]` editor needs to mutate itself — add, remove, or edit one row.
 * Every method is `this: void` — none of them close over anything but `setRows`,
 * so a caller can hand `controller.updateRow` straight to a prop (as
 * `PlayerProgressPanel.tsx`'s `WallsField` callers do) without `@typescript-eslint/
 * unbound-method` treating the detached reference as a hazard it would be for a
 * real method.
 */
export interface WallRowsController {
  rows: WallRow[]
  updateRow(this: void, key: string, patch: Partial<Pick<WallRow, 'level' | 'count'>>): void
  addRow(this: void): void
  removeRow(this: void, key: string): void
}

/**
 * `WallRow[]` state plus its three mutators, seeded once from `initialWalls` —
 * the hook form of what `ManualCaptureForm` used to keep as three separate
 * `useState`/inline-function pieces. Seeded lazily (`useState(() => …)`) so
 * re-renders don't re-parse `initialWalls` on every keystroke; a caller that
 * needs to reseed on a *different* week's walls (the past-week form, when the
 * chosen week changes) does it by remounting with a new `key`, the same
 * pattern `ManualCaptureForm` never needed because it only ever edits one week.
 */
export function useWallRows(initialWalls: Record<string, number> | null): WallRowsController {
  const [rows, setRows] = useState<WallRow[]>(() => wallsToRows(initialWalls))

  function updateRow(key: string, patch: Partial<Pick<WallRow, 'level' | 'count'>>): void {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }
  function addRow(): void {
    setRows((current) => [...current, { key: crypto.randomUUID(), level: '', count: '' }])
  }
  function removeRow(key: string): void {
    setRows((current) => current.filter((entry) => entry.key !== key))
  }

  return { rows, updateRow, addRow, removeRow }
}
