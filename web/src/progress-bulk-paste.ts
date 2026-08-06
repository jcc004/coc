/**
 * Parses the bulk-paste box in `ProgressReferenceCard` (`components/AdminView.tsx`)
 * — one row per line, `name, town hall, max level`. Pure and DB-free so it can be
 * tested without mounting the component, the same split `computeAutoNote` in
 * `server/src/progress/store.ts` draws for the same reason.
 *
 * Built for pasting straight out of a spreadsheet as much as for typing by hand:
 * a line is split on a tab if it has one, and on a comma otherwise, so a
 * tab-delimited paste and a hand-typed comma list both work without the admin
 * having to think about which.
 *
 * All-or-nothing, matching the server's own `parseReferenceRows` — a first-time
 * fill-in of ~50-150 rows is exactly the case where a silent partial import would
 * leave nobody able to say which lines actually landed.
 */

export interface BulkPasteRow {
  name: string
  thLevel: number
  maxLevel: number
}

export type BulkPasteResult = { rows: BulkPasteRow[] } | { problem: string }

export function parseBulkPasteRows(text: string): BulkPasteResult {
  const rows: BulkPasteRow[] = []

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line) continue // Blank lines are just spacing, not a row to fail on.

    const lineNumber = index + 1
    const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map((part) =>
      part.trim(),
    )
    if (parts.length !== 3) {
      return {
        problem:
          `Line ${lineNumber}: expected "name, town hall, max level" ` +
          `(3 fields), got ${parts.length}: ${JSON.stringify(line)}`,
      }
    }

    const [name, thText, maxText] = parts as [string, string, string]
    if (!name) {
      return { problem: `Line ${lineNumber}: name cannot be blank.` }
    }

    const thLevel = Number(thText)
    if (!Number.isInteger(thLevel) || thLevel <= 0) {
      return {
        problem:
          `Line ${lineNumber} (${name}): town hall level must be a positive whole number, ` +
          `got "${thText}".`,
      }
    }

    const maxLevel = Number(maxText)
    if (!Number.isInteger(maxLevel) || maxLevel <= 0) {
      return {
        problem:
          `Line ${lineNumber} (${name}): max level must be a positive whole number, ` +
          `got "${maxText}".`,
      }
    }

    rows.push({ name, thLevel, maxLevel })
  }

  if (rows.length === 0) {
    return { problem: 'Paste at least one line: "name, town hall, max level".' }
  }

  return { rows }
}
