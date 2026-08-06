import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeTag, type AutoCapturePayload, type ManualCapturePayload } from '@coc/shared'
import { databasePathFromEnv, openDatabase } from '../db.ts'
import { currentWeekStart } from './capture-snapshot.ts'
import { createProgressStore, type ProgressStore } from './store.ts'

/**
 * ============================================================================
 * ONE-SHOT HISTORICAL BACKFILL — NOT PART OF THE RECURRING APP.
 * ============================================================================
 *
 * Imports the 42 hand-kept spreadsheets at
 * `~/Library/CloudStorage/Dropbox/info/Games/CoC/Clashy/Clashy_YYYY-MM-DD.xlsx`
 * (2025-09-03 through 2026-07-24) into `base_progress`, predating this app's
 * own weekly progress-tracking feature. Run once, by hand, with `tsx`. Nothing
 * here is wired into a route, a scheduled job, or `npm test`'s app-facing
 * suite — the only reason this file has an adjacent `.test.ts` is that its
 * *parsing* logic (the column map and the row parser) is worth pinning against
 * real header-row shapes before it touches production data, not because this
 * script itself is meant to run again.
 *
 * The spreadsheet layout is not stable across the 42 files or even between a
 * file's two sheets — column positions for walls shift, `Heroes` gains a `DD`
 * (Dragon Duke) column partway through, `Pets` gains an `R` (Greedy Raven)
 * column partway through, and the very earliest files have no `Buildings`
 * `Left` column at all. {@link buildColumnMap} reads each sheet's own row 5
 * fresh rather than assuming any fixed layout.
 *
 * Two passes, gated by `--write`:
 *   `tsx server/src/progress/backfill-history.ts`           — dry run, prints
 *     a coverage report, touches nothing.
 *   `tsx server/src/progress/backfill-history.ts --write`   — the real import,
 *     against `DATABASE_PATH` (or the server's default `./data/coc.db`).
 *
 * Both passes read the database (to detect a collision with a week someone
 * has already really captured) but only `--write` calls `upsertSnapshot`.
 *
 * Run from the repo root as:
 *   DATABASE_PATH=/absolute/path/to/server/data/coc.db \
 *     npx tsx server/src/progress/backfill-history.ts [--write]
 */

// ---------------------------------------------------------------------------
// Base identity: the spreadsheet's own nickname column (Playa) to the real
// player tag, confirmed against the live clan roster by hand. Not derived
// from anything in the workbook — there is no tag anywhere in these files,
// only the nicknames the user made up before this app (or `normalizeTag`)
// existed.
// ---------------------------------------------------------------------------
export const NICKNAME_TO_TAG: Record<string, string> = {
  nc: '#2PJP889PC',
  '00': '#90QVVYCG',
  iv: '#YPQV09QQ',
  __: '#JL0L20CG',
  '**': '#8V9PYY0CJ',
  '..': '#P0RG0L9YV',
  $$: '#9U0VVP8GP',
  '@@': '#9QJQLUJGC',
  oo: '#9LRVVCLLJ',
  '==': '#9QRU0P8UR',
  jcc4coc: '#PUUR0GL82',
  // Not a distinct base — an alias. In Clashy_2025-09-10/09-18/09-25.xlsx the
  // "00" nickname was typed in a way Excel stored as the bare number 0 (a
  // numeric cell, leading zeros dropped) rather than the shared-string text
  // "00". Confirmed by the surrounding row: same Town Hall and hero-level
  // trajectory as every other week's "00" row. Mapped to the same tag so
  // that week is not silently dropped as unmapped.
  '0': '#90QVVYCG',
}

/**
 * Mirrors `web/src/progress-grid.ts`'s `HERO_ABBREVIATIONS` and
 * `PET_ABBREVIATIONS`, inverted (abbreviation -> the app's canonical name).
 * Hardcoded here rather than imported: `web/` and `server/` are sibling
 * workspaces, neither depends on the other, and pulling a `web/` module into
 * a `server/` script for a one-shot run is more coupling than the run is
 * worth. If the app's own abbreviations ever change, this copy will not
 * follow — acceptable for a script meant to execute exactly once.
 */
const HERO_NAME_BY_ABBREVIATION: Record<string, string> = {
  BK: 'Barbarian King',
  AQ: 'Archer Queen',
  GW: 'Grand Warden',
  RC: 'Royal Champion',
  MP: 'Minion Prince',
  DD: 'Dragon Duke',
}

const PET_NAME_BY_ABBREVIATION: Record<string, string> = {
  L: 'L.A.S.S.I',
  O: 'Electro Owl',
  Y: 'Mighty Yak',
  U: 'Unicorn',
  F: 'Frosty',
  D: 'Diggy',
  PL: 'Poison Lizard',
  PH: 'Phoenix',
  SF: 'Spirit Fox',
  AJ: 'Angry Jelly',
  S: 'Sneezy',
  R: 'Greedy Raven',
}

// ---------------------------------------------------------------------------
// Minimal raw-XML reading — unzip + regex, the same approach used earlier in
// this project for `clash_stats.xlsx`. No spreadsheet library: this app has
// never taken one on and a one-shot script is not the reason to start.
// ---------------------------------------------------------------------------

function readZipEntry(zipPath: string, entryPath: string): string {
  try {
    return execFileSync('unzip', ['-p', zipPath, entryPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (cause) {
    throw new Error(`could not read "${entryPath}" from ${zipPath}: ${(cause as Error).message}`, {
      cause,
    })
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}

/** Every `<si>...</si>` entry, runs joined and entities decoded, in index order. */
export function parseSharedStrings(xml: string): string[] {
  const entries: string[] = []
  for (const siMatch of xml.matchAll(/<si>(.*?)<\/si>/gs)) {
    const body = siMatch[1] ?? ''
    const runs = [...body.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => m[1] ?? '')
    entries.push(decodeXmlEntities(runs.join('')))
  }
  return entries
}

/** `<sheet name="..." ... r:id="rIdN"/>` in workbook order, attribute order not assumed. */
export function parseWorkbookSheetOrder(xml: string): { name: string; rId: string }[] {
  const sheets: { name: string; rId: string }[] = []
  for (const tagMatch of xml.matchAll(/<sheet\s+[^>]*\/>/g)) {
    const tag = tagMatch[0]
    const name = /name="([^"]*)"/.exec(tag)?.[1]
    const rId = /r:id="([^"]*)"/.exec(tag)?.[1]
    if (name && rId) sheets.push({ name: decodeXmlEntities(name), rId })
  }
  return sheets
}

/** `rId -> worksheets/sheetN.xml`, from `xl/_rels/workbook.xml.rels`, worksheet relationships only. */
export function parseWorkbookRels(xml: string): Map<string, string> {
  const targets = new Map<string, string>()
  for (const tagMatch of xml.matchAll(/<Relationship\s+[^>]*\/>/g)) {
    const tag = tagMatch[0]
    if (!tag.includes('/worksheet"')) continue
    const id = /Id="([^"]*)"/.exec(tag)?.[1]
    const target = /Target="([^"]*)"/.exec(tag)?.[1]
    if (id && target) targets.set(id, target)
  }
  return targets
}

/** A-Z, AA-ZZ column letters to a 1-based index. */
export function columnLetterToIndex(letter: string): number {
  let index = 0
  for (const char of letter) index = index * 26 + (char.charCodeAt(0) - 64)
  return index
}

export type CellKind = 's' | 'str' | 'inlineStr' | undefined

/**
 * Narrows a raw `t="..."` attribute value to the three kinds this file treats
 * specially, rather than asserting the cast — an unrecognized `t` (`"n"` for
 * an explicit numeric type, `"b"` for boolean, `"e"` for a formula error) is
 * `undefined` here, which is exactly the fallback `resolveCellNumber` and
 * `resolveCellText` already give plain numeric cells.
 */
function toCellKind(text: string | undefined): CellKind {
  return text === 's' || text === 'str' || text === 'inlineStr' ? text : undefined
}

/** One `<c>` cell, column-resolved, value still raw (shared-string index or literal text). */
export interface RawCell {
  col: string
  colIndex: number
  type: CellKind
  raw: string | undefined
}

/** Every `<c>` in one `<row>`'s inner XML, in document order. */
export function extractRowCells(rowInnerXml: string): RawCell[] {
  const cells: RawCell[] = []
  const cellRegex = /<c\s+r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs
  for (const match of rowInnerXml.matchAll(cellRegex)) {
    const col = match[1]
    if (!col) continue
    const attrs = match[2] ?? ''
    const inner = match[3]
    const type = toCellKind(/\st="([a-zA-Z]+)"/.exec(attrs)?.[1])

    let raw: string | undefined
    if (inner !== undefined) {
      if (type === 'inlineStr') {
        const runs = [...inner.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => m[1] ?? '')
        raw = decodeXmlEntities(runs.join(''))
      } else {
        const v = /<v>(.*?)<\/v>/s.exec(inner)?.[1]
        raw = v !== undefined ? decodeXmlEntities(v) : undefined
      }
    }

    cells.push({ col, colIndex: columnLetterToIndex(col), type, raw })
  }
  return cells
}

/**
 * Every `<row r="N">...</row>`, keyed by row number. Rows Excel omitted
 * entirely are simply absent from the map. A self-closing `<row .../>`
 * (a genuinely empty row some sheets emit for spacing) is handled the same
 * way — it yields zero cells, which reads identically to "row absent" for
 * every caller here.
 */
export function extractSheetRows(sheetXml: string): Map<number, RawCell[]> {
  const rows = new Map<number, RawCell[]>()
  const rowRegex = /<row r="(\d+)"[^>]*?(?:\/>|>(.*?)<\/row>)/gs
  for (const match of sheetXml.matchAll(rowRegex)) {
    const rowNum = Number(match[1])
    rows.set(rowNum, extractRowCells(match[2] ?? ''))
  }
  return rows
}

/** A cell's text, resolving a shared-string index if that is what it holds. */
export function resolveCellText(
  cell: RawCell | undefined,
  sharedStrings: readonly string[],
): string | undefined {
  if (!cell || cell.raw === undefined) return undefined
  if (cell.type === 's') {
    const index = Number(cell.raw)
    return Number.isFinite(index) ? sharedStrings[index] : undefined
  }
  return cell.raw
}

/** A cell's value as a finite number, or `undefined` for blank/non-numeric. */
export function resolveCellNumber(cell: RawCell | undefined): number | undefined {
  if (!cell || cell.raw === undefined || cell.type === 's' || cell.type === 'inlineStr') {
    return undefined
  }
  const value = Number(cell.raw)
  return Number.isFinite(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Column mapping — built fresh per sheet from its own row 5, never a
// hardcoded index. Pure and tested against real header-row shapes in
// `backfill-history.test.ts`.
//
// Row 5's own text is the reliable signal: a hero abbreviation, a pet
// abbreviation, "Left", "Max", or a wall-level number are each unambiguous —
// the hero and pet abbreviation sets never overlap. Row 4's category headers
// are *not* reliably positioned, confirmed against Clashy_2025-09-10.xlsx
// (and three siblings from the same week): that file's row 4 has no merge
// and no continuation cells at all — "Heroes", "Buildings", "Walls" and
// "Pets" sit squeezed into four consecutive columns (C, D, E, F) regardless
// of how many columns each category's real data spans in row 5 and below.
// An earlier version of this file trusted row 4's column position and
// misattributed the Archer Queen, Minion Prince and Grand Warden columns to
// Buildings/Walls/Pets in exactly those four files. So classification below
// reads row 5 alone; row 4 is kept only as a best-effort sanity check.
// ---------------------------------------------------------------------------

export interface ColumnMap {
  playaCol: string | null
  thCol: string | null
  buildingsLeftCol: string | null
  /** hero name -> column letter */
  heroCols: Record<string, string>
  /** pet name -> column letter */
  petCols: Record<string, string>
  /** wall level (as a string key, matching `ManualCapturePayload.walls`) -> column letter */
  wallCols: Record<string, string>
  /** The rightmost column index any category above claimed — everything past it is Notes. */
  lastMappedColIndex: number
  /**
   * Columns with a real, row-5 label that is none of the above — a side
   * calculation table sharing this row (confirmed in
   * Clashy_2026-04-24.xlsx: "Walls", "Walls +" and "Heroes" columns holding a
   * weeks-to-upgrade estimate, not base data). These must never be swept
   * into Notes just because they sit past every recognized column — see
   * {@link parseDataRow}.
   */
  excludedCols: Set<string>
  /** Anything the map builder could not place: an unrecognized label, an unmappable Buildings/Left gap, etc. */
  warnings: string[]
}

/** Inverse of {@link columnLetterToIndex} — needed when the Buildings/Left gap column has no cell at all in row 5. */
export function indexToColumnLetter(index: number): string {
  let letters = ''
  let n = index
  while (n > 0) {
    const remainder = (n - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

export function buildColumnMap(
  row4: readonly RawCell[],
  row5: readonly RawCell[],
  sharedStrings: readonly string[],
): ColumnMap {
  const map: ColumnMap = {
    playaCol: 'A',
    thCol: 'B',
    buildingsLeftCol: null,
    heroCols: {},
    petCols: {},
    wallCols: {},
    lastMappedColIndex: columnLetterToIndex('B'),
    excludedCols: new Set(),
    warnings: [],
  }

  // Best-effort only — never gates anything below. Row 4 is unreliable (see
  // this section's header) but column A/B being anything other than
  // Playa/TH at all would be worth knowing about.
  const a4 = resolveCellText(
    row4.find((cell) => cell.col === 'A'),
    sharedStrings,
  )
  const b4 = resolveCellText(
    row4.find((cell) => cell.col === 'B'),
    sharedStrings,
  )
  if (a4 !== undefined && a4 !== 'Playa') {
    map.warnings.push(`row 4 column A reads "${a4}", not "Playa" — column A is still assumed to be Playa`)
  }
  if (b4 !== undefined && b4 !== 'TH') {
    map.warnings.push(`row 4 column B reads "${b4}", not "TH" — column B is still assumed to be TH`)
  }

  // The leftmost column that is part of the Walls region, including its
  // non-numeric "Max" marker — needed below to find Buildings/Left by
  // position when it has no label of its own.
  let wallRegionStart: number | null = null

  for (const cell of [...row5].sort((a, b) => a.colIndex - b.colIndex)) {
    if (cell.col === 'A' || cell.col === 'B') continue
    const label = resolveCellText(cell, sharedStrings)
    if (label === undefined) continue // blank sub-header — handled by the Buildings gap-fallback and Notes detection

    const heroName = HERO_NAME_BY_ABBREVIATION[label]
    if (heroName) {
      map.heroCols[heroName] = cell.col
      map.lastMappedColIndex = Math.max(map.lastMappedColIndex, cell.colIndex)
      continue
    }

    const petName = PET_NAME_BY_ABBREVIATION[label]
    if (petName) {
      map.petCols[petName] = cell.col
      map.lastMappedColIndex = Math.max(map.lastMappedColIndex, cell.colIndex)
      continue
    }

    if (label === 'Left') {
      map.buildingsLeftCol = cell.col
      map.lastMappedColIndex = Math.max(map.lastMappedColIndex, cell.colIndex)
      continue
    }

    if (label === 'Max') {
      wallRegionStart = wallRegionStart === null ? cell.colIndex : Math.min(wallRegionStart, cell.colIndex)
      map.lastMappedColIndex = Math.max(map.lastMappedColIndex, cell.colIndex)
      continue
    }

    const level = Number(label)
    if (Number.isInteger(level)) {
      map.wallCols[String(level)] = cell.col
      map.lastMappedColIndex = Math.max(map.lastMappedColIndex, cell.colIndex)
      wallRegionStart = wallRegionStart === null ? cell.colIndex : Math.min(wallRegionStart, cell.colIndex)
      continue
    }

    // A real label that is none of the above. "Notes" is expected and left
    // for the position-based pass in `parseDataRow`; anything else is a
    // column that must never be read as Notes data (see `excludedCols`'s doc).
    if (label !== 'Notes') {
      map.excludedCols.add(cell.col)
      map.warnings.push(`column ${cell.col} labeled "${label}" — not a recognized category, excluded`)
    }
  }

  // Buildings/Left fallback: the earliest files have no "Left" label at all
  // (and no data under that column). The single column strictly between the
  // last Heroes column and the first Walls-region column is Buildings by
  // position — the same gap in every file checked, regardless of era.
  if (map.buildingsLeftCol === null) {
    const heroIndexes = Object.values(map.heroCols).map(columnLetterToIndex)
    const maxHeroIndex = heroIndexes.length > 0 ? Math.max(...heroIndexes) : null
    if (maxHeroIndex !== null && wallRegionStart !== null) {
      const gapWidth = wallRegionStart - maxHeroIndex - 1
      if (gapWidth === 1) {
        const gapIndex = maxHeroIndex + 1
        map.buildingsLeftCol = indexToColumnLetter(gapIndex)
        map.lastMappedColIndex = Math.max(map.lastMappedColIndex, gapIndex)
      } else if (gapWidth > 1) {
        map.warnings.push(
          `Buildings/Left has no label and the gap between Heroes and Walls is ${gapWidth} columns wide, not 1 — left unmapped`,
        )
      }
    }
  }

  return map
}

// ---------------------------------------------------------------------------
// Row parsing — one data row to a structured record. `null` marks the
// boundary: the row's Playa cell is blank, which is where data stops
// (a reference table some sheets embed lower down starts right after) —
// except when it doesn't; see `scanDataRows` for the one file where a blank
// row is a genuine gap in the middle of real data, not the boundary.
// ---------------------------------------------------------------------------

export interface ParsedDataRow {
  playa: string
  thLevel: number | undefined
  heroes: { name: string; level: number }[]
  pets: { name: string; level: number }[]
  walls: Record<string, number>
  buildingsLeft: string | undefined
  notes: string | undefined
}

function cellByCol(cells: readonly RawCell[], col: string): RawCell | undefined {
  return cells.find((cell) => cell.col === col)
}

export function parseDataRow(
  rowCells: readonly RawCell[],
  columnMap: ColumnMap,
  sharedStrings: readonly string[],
): ParsedDataRow | null {
  const playaCell = columnMap.playaCol ? cellByCol(rowCells, columnMap.playaCol) : undefined
  const playa = resolveCellText(playaCell, sharedStrings)
  if (!playa || playa.trim() === '') return null

  const thLevel = columnMap.thCol
    ? resolveCellNumber(cellByCol(rowCells, columnMap.thCol))
    : undefined

  const heroes: { name: string; level: number }[] = []
  for (const [name, col] of Object.entries(columnMap.heroCols)) {
    const level = resolveCellNumber(cellByCol(rowCells, col))
    if (level !== undefined) heroes.push({ name, level })
  }

  const pets: { name: string; level: number }[] = []
  for (const [name, col] of Object.entries(columnMap.petCols)) {
    const level = resolveCellNumber(cellByCol(rowCells, col))
    if (level !== undefined) pets.push({ name, level })
  }

  const walls: Record<string, number> = {}
  for (const [level, col] of Object.entries(columnMap.wallCols)) {
    const count = resolveCellNumber(cellByCol(rowCells, col))
    if (count !== undefined) walls[level] = count
  }

  const buildingsLeftCell = columnMap.buildingsLeftCol
    ? cellByCol(rowCells, columnMap.buildingsLeftCol)
    : undefined
  const buildingsLeft = resolveCellText(buildingsLeftCell, sharedStrings)

  // Notes: whatever text lands past every mapped column, in column order,
  // concatenated — excluding any column `buildColumnMap` identified as a
  // labeled-but-unrecognized side table (`excludedCols`). No header is
  // assumed for the real notes columns: some files label them "Notes" in
  // row 5, most don't label them at all.
  const noteFragments = rowCells
    .filter(
      (cell) =>
        cell.colIndex > columnMap.lastMappedColIndex &&
        !columnMap.excludedCols.has(cell.col) &&
        cell.raw !== undefined,
    )
    .sort((a, b) => a.colIndex - b.colIndex)
    .map((cell) => resolveCellText(cell, sharedStrings))
    .filter((text): text is string => !!text && text.trim() !== '')
  const notes = noteFragments.length > 0 ? noteFragments.join('; ') : undefined

  return {
    playa,
    thLevel,
    heroes,
    pets,
    walls,
    buildingsLeft,
    notes,
  }
}

/**
 * Scans data rows from `startRow` until the real end of the table, tolerating
 * a blank-Playa row that is a mid-table gap (a week nobody typed one base's
 * row in) rather than stopping at it outright — confirmed necessary by
 * Clashy_2025-09-12.xlsx, where row 9 is entirely blank between two real
 * rows and six more real bases follow it below.
 *
 * A blank-Playa row is treated as a gap, not the boundary, exactly when the
 * very next row's Playa resolves to one of the known nicknames — anything
 * else (including a genuinely blank next row, or text that is not a tracked
 * base) is the real end of the table: the same "a reference table starts
 * right after" boundary the rest of this file relies on. Using the known
 * nickname list as the oracle here is not a guess — it is the one piece of
 * ground truth this whole import already depends on.
 */
export interface RowScanResult {
  rows: ParsedDataRow[]
  /** Row numbers skipped as a mid-table gap rather than treated as the boundary. */
  gapRows: number[]
}

export function scanDataRows(
  rows: ReadonlyMap<number, readonly RawCell[]>,
  startRow: number,
  columnMap: ColumnMap,
  sharedStrings: readonly string[],
  knownNicknames: ReadonlySet<string>,
  maxRows = 500,
): RowScanResult {
  const parsed: ParsedDataRow[] = []
  const gapRows: number[] = []
  let rowNum = startRow

  for (let scanned = 0; scanned < maxRows; scanned += 1) {
    const cells = rows.get(rowNum) ?? []
    const row = parseDataRow(cells, columnMap, sharedStrings)
    if (row) {
      parsed.push(row)
      rowNum += 1
      continue
    }

    const nextCells = rows.get(rowNum + 1) ?? []
    const nextPlaya = columnMap.playaCol
      ? resolveCellText(cellByCol(nextCells, columnMap.playaCol), sharedStrings)
      : undefined
    if (nextPlaya !== undefined && knownNicknames.has(nextPlaya)) {
      gapRows.push(rowNum)
      rowNum += 1
      continue
    }

    break
  }

  return { rows: parsed, gapRows }
}

// ---------------------------------------------------------------------------
// Orchestration — one workbook to a set of (tag, weekStart) upserts.
// ---------------------------------------------------------------------------

interface SheetData {
  sheetName: string
  rowsFound: number
  parsedRows: ParsedDataRow[]
  warnings: string[]
  gapRows: number[]
}

/** Reads one `.xlsx`'s every sheet, header rows and data rows, no interpretation of identity yet. */
function readWorkbook(path: string, knownNicknames: ReadonlySet<string>): SheetData[] {
  const sharedStrings = parseSharedStrings(readZipEntry(path, 'xl/sharedStrings.xml'))
  const workbookXml = readZipEntry(path, 'xl/workbook.xml')
  const relsXml = readZipEntry(path, 'xl/_rels/workbook.xml.rels')

  const sheetOrder = parseWorkbookSheetOrder(workbookXml)
  const targets = parseWorkbookRels(relsXml)

  const sheets: SheetData[] = []

  for (const { name, rId } of sheetOrder) {
    const target = targets.get(rId)
    if (!target) {
      sheets.push({
        sheetName: name,
        rowsFound: 0,
        parsedRows: [],
        warnings: [`no rels target for ${rId}`],
        gapRows: [],
      })
      continue
    }
    const entryPath = `xl/${target.replace(/^\/?xl\//, '')}`
    const sheetXml = readZipEntry(path, entryPath)
    const rows = extractSheetRows(sheetXml)

    const row4 = rows.get(4) ?? []
    const row5 = rows.get(5) ?? []
    const columnMap = buildColumnMap(row4, row5, sharedStrings)

    const { rows: parsedRows, gapRows } = scanDataRows(rows, 6, columnMap, sharedStrings, knownNicknames)

    sheets.push({
      sheetName: name,
      rowsFound: parsedRows.length,
      parsedRows,
      warnings: columnMap.warnings,
      gapRows,
    })
  }

  return sheets
}

const DATE_SHEET_NAME = /^\d{4}-\d{2}-\d{2}$/

/**
 * An order-independent signature of one sheet's parsed rows — sorted by
 * Playa and by unit name within each row, so two occurrences with the same
 * content but a different XML cell order still compare equal.
 */
function signatureOfRows(rows: readonly ParsedDataRow[]): string {
  const sortedRows = [...rows]
    .map((row) => ({
      playa: row.playa,
      thLevel: row.thLevel,
      heroes: [...row.heroes].sort((a, b) => a.name.localeCompare(b.name)),
      pets: [...row.pets].sort((a, b) => a.name.localeCompare(b.name)),
      walls: row.walls,
      buildingsLeft: row.buildingsLeft,
      notes: row.notes,
    }))
    .sort((a, b) => a.playa.localeCompare(b.playa))
  return JSON.stringify(sortedRows)
}

export interface DatedSheetOccurrence {
  file: string
  sheetName: string
  rows: readonly ParsedDataRow[]
}

/**
 * Some files name a sheet after a literal date rather than "Current" —
 * confirmed in Clashy_2025-10-09/10-21/10-30.xlsx, which each carry two
 * sheets named "2025-10-10" and "2025-10-03". Direct inspection of all
 * three files' raw XML shows the two names mean opposite things: the
 * "2025-10-03" sheet is byte-identical in every one of the three files — a
 * frozen, copy-forward snapshot whose tab name really is the week it
 * belongs to. The "2025-10-10" sheet's *data* changes in every file (real
 * hero-level and wall-count progression matching each file's own save
 * date) even though its tab name never does — a live-edited sheet whose
 * stale name must be ignored in favor of the filename, the same as every
 * undated sheet already is.
 *
 * The two are told apart by repetition, not by name: a dated sheet name
 * that recurs with byte-identical rows every time is "frozen" (its own
 * date is the real week); one that recurs with different rows each time is
 * "live" (the filename is the real week, same as always). A name seen only
 * once has nothing to compare against and defaults to "live" — the more
 * common shape, and the safe choice since a live sheet only ever loses the
 * (unlikely) case where a single-occurrence sheet's stale name happened to
 * be the intended week.
 */
export function classifyDatedSheets(
  occurrences: readonly DatedSheetOccurrence[],
): Map<string, 'frozen' | 'live'> {
  const signaturesByName = new Map<string, string[]>()
  for (const occurrence of occurrences) {
    if (!DATE_SHEET_NAME.test(occurrence.sheetName)) continue
    const signatures = signaturesByName.get(occurrence.sheetName) ?? []
    signatures.push(signatureOfRows(occurrence.rows))
    signaturesByName.set(occurrence.sheetName, signatures)
  }

  const classification = new Map<string, 'frozen' | 'live'>()
  for (const [sheetName, signatures] of signaturesByName) {
    const firstSignature = signatures[0]
    const allIdentical = firstSignature !== undefined && signatures.every((sig) => sig === firstSignature)
    classification.set(sheetName, allIdentical && signatures.length > 1 ? 'frozen' : 'live')
  }
  return classification
}

interface PlannedUpsert {
  file: string
  sheet: string
  tag: string
  weekStart: string
  auto: AutoCapturePayload
  manual: ManualCapturePayload
}

interface CoverageReport {
  filesProcessed: number
  sheetsProcessed: number
  perFile: { file: string; sheet: string; rowsFound: number }[]
  unmappedNicknames: { file: string; sheet: string; playa: string }[]
  rowsMissingTH: { file: string; sheet: string; playa: string }[]
  columnMapWarnings: { file: string; sheet: string; warning: string }[]
  /** Mid-table blank rows tolerated by `scanDataRows` rather than treated as the boundary — see its doc comment. */
  gapRows: { file: string; sheet: string; row: number }[]
  planned: PlannedUpsert[]
  tagsSeen: Set<string>
  weekStartRange: { min: string; max: string } | null
  collisions: { tag: string; weekStart: string; existingCapturedBy: string }[]
}

function toAutoCapturePayload(row: ParsedDataRow): AutoCapturePayload | null {
  if (row.thLevel === undefined) return null
  const payload: AutoCapturePayload = { thLevel: row.thLevel }
  if (row.heroes.length > 0) {
    payload.heroes = row.heroes.map(({ name, level }) => ({ name, level, maxLevel: level }))
  }
  if (row.pets.length > 0) {
    payload.pets = row.pets.map(({ name, level }) => ({ name, level, maxLevel: level }))
  }
  return payload
}

function toManualCapturePayload(row: ParsedDataRow): ManualCapturePayload {
  const payload: ManualCapturePayload = {}
  if (Object.keys(row.walls).length > 0) payload.walls = row.walls
  if (row.buildingsLeft !== undefined) payload.buildingsLeft = row.buildingsLeft
  if (row.notes !== undefined) payload.notes = row.notes
  return payload
}

/**
 * A row's captured_by, if it already has one that isn't this script's own
 * `'import'` marker — the collision this backfill must never write over. A
 * row that does not exist, or that was itself written by an earlier run of
 * this same script, is not a collision.
 */
function findNonImportCapturedBy(db: DatabaseSync, tag: string, weekStart: string): string | null {
  const row = db
    .prepare('SELECT captured_by FROM base_progress WHERE player_tag = ? AND week_start = ?')
    .get(tag, weekStart)
  const capturedBy = row?.['captured_by']
  if (typeof capturedBy !== 'string') return null
  return capturedBy === 'import' ? null : capturedBy
}

interface FileRead {
  file: string
  /** `null` when the filename itself did not parse — nothing else about this file is usable. */
  filenameWeekStart: string | null
  sheets: SheetData[]
}

function buildReport(files: string[], db: DatabaseSync): CoverageReport {
  const knownNicknames = new Set(Object.keys(NICKNAME_TO_TAG))

  const report: CoverageReport = {
    filesProcessed: 0,
    sheetsProcessed: 0,
    perFile: [],
    unmappedNicknames: [],
    rowsMissingTH: [],
    columnMapWarnings: [],
    gapRows: [],
    planned: [],
    tagsSeen: new Set(),
    weekStartRange: null,
    collisions: [],
  }

  // Phase 1: read every workbook once, in ascending filename order, and hold
  // everything in memory — needed before any weekStart can be assigned,
  // because a dated sheet name's "frozen or live" classification depends on
  // comparing its content across every file it appears in (see
  // `classifyDatedSheets`), not just the one file being looked at.
  const reads: FileRead[] = []
  for (const path of files) {
    const file = basename(path)
    const dateMatch = /Clashy_(\d{4}-\d{2}-\d{2})\.xlsx$/.exec(file)
    if (!dateMatch || !dateMatch[1]) {
      report.columnMapWarnings.push({
        file,
        sheet: '(n/a)',
        warning: 'filename does not match Clashy_YYYY-MM-DD.xlsx — skipped',
      })
      continue
    }
    report.filesProcessed += 1
    reads.push({
      file,
      filenameWeekStart: currentWeekStart(new Date(`${dateMatch[1]}T00:00:00Z`)),
      sheets: readWorkbook(path, knownNicknames),
    })
  }

  const datedSheetClassification = classifyDatedSheets(
    reads.flatMap((read) =>
      read.sheets.map((sheet) => ({ file: read.file, sheetName: sheet.sheetName, rows: sheet.parsedRows })),
    ),
  )
  // A "frozen" dated sheet is the same real week duplicated into every file
  // it appears in — imported once, from the first file it is seen in.
  const frozenSheetsAlreadyImported = new Set<string>()

  for (const read of reads) {
    for (const sheet of read.sheets) {
      report.sheetsProcessed += 1
      report.perFile.push({ file: read.file, sheet: sheet.sheetName, rowsFound: sheet.rowsFound })
      for (const warning of sheet.warnings) {
        report.columnMapWarnings.push({ file: read.file, sheet: sheet.sheetName, warning })
      }
      for (const row of sheet.gapRows) {
        report.gapRows.push({ file: read.file, sheet: sheet.sheetName, row })
      }

      const isFrozenDatedSheet = datedSheetClassification.get(sheet.sheetName) === 'frozen'
      if (isFrozenDatedSheet) {
        if (frozenSheetsAlreadyImported.has(sheet.sheetName)) {
          report.columnMapWarnings.push({
            file: read.file,
            sheet: sheet.sheetName,
            warning: `sheet "${sheet.sheetName}" is a frozen duplicate of a week already imported from an earlier file — skipped`,
          })
          continue
        }
        frozenSheetsAlreadyImported.add(sheet.sheetName)
      }

      // A frozen dated sheet's own name is the real week; every other
      // sheet — including a *live* dated sheet, whose name is stale — uses
      // the file it was actually saved under.
      const weekStart = isFrozenDatedSheet
        ? currentWeekStart(new Date(`${sheet.sheetName}T00:00:00Z`))
        : read.filenameWeekStart

      if (weekStart === null) continue // the filename itself did not parse; already warned about above

      for (const row of sheet.parsedRows) {
        const tag = NICKNAME_TO_TAG[row.playa]
        if (!tag) {
          report.unmappedNicknames.push({ file: read.file, sheet: sheet.sheetName, playa: row.playa })
          continue
        }
        const normalizedTag = normalizeTag(tag)

        const auto = toAutoCapturePayload(row)
        if (!auto) {
          report.rowsMissingTH.push({ file: read.file, sheet: sheet.sheetName, playa: row.playa })
          continue
        }

        report.tagsSeen.add(normalizedTag)
        if (!report.weekStartRange) {
          report.weekStartRange = { min: weekStart, max: weekStart }
        } else {
          if (weekStart < report.weekStartRange.min) report.weekStartRange.min = weekStart
          if (weekStart > report.weekStartRange.max) report.weekStartRange.max = weekStart
        }

        const manual = toManualCapturePayload(row)
        report.planned.push({ file: read.file, sheet: sheet.sheetName, tag: normalizedTag, weekStart, auto, manual })

        const collision = findNonImportCapturedBy(db, normalizedTag, weekStart)
        if (collision) {
          report.collisions.push({ tag: normalizedTag, weekStart, existingCapturedBy: collision })
        }
      }
    }
  }

  // A frozen dated sheet's weekStart can be chronologically *earlier* than
  // the file it was discovered in (Clashy_2025-10-09.xlsx's "2025-10-03"
  // sheet resolves to a week before that file's own filename date) — file
  // order is no longer the same as weekStart order once that happens. A
  // stable sort by weekStart restores it: `upsertSnapshot` diffs each tag
  // against whatever the *immediately prior* week already holds, so writing
  // a tag's weeks out of order would compute nonsense diffs (see this
  // file's header). Stability matters too — it keeps the two known
  // same-week collisions (Sept 10/12, Dec 02/08) in file order, which is
  // what makes the later file's data the one that wins the merge.
  report.planned.sort((a, b) => a.weekStart.localeCompare(b.weekStart))

  return report
}

function printReport(report: CoverageReport): void {
  console.log('\n=== Historical progress backfill — coverage report ===\n')
  console.log(`Files processed:   ${report.filesProcessed}`)
  console.log(`Sheets processed:  ${report.sheetsProcessed}`)
  console.log(`Tags seen:         ${report.tagsSeen.size} — ${[...report.tagsSeen].sort().join(', ')}`)
  console.log(
    `Date range:        ${report.weekStartRange?.min ?? '(none)'} .. ${report.weekStartRange?.max ?? '(none)'}`,
  )
  console.log(`Planned upserts:   ${report.planned.length}`)

  console.log('\n--- Rows found per file/sheet ---')
  for (const entry of report.perFile) {
    console.log(`  ${entry.file}  [${entry.sheet}]  ${entry.rowsFound} row(s)`)
  }

  console.log(`\n--- Known tags never seen in any file (not necessarily a problem — see report) ---`)
  let anyUnseen = false
  // '0' is an alias for '00' (see NICKNAME_TO_TAG), not an twelfth tracked
  // base — skipped here so this list reports against the 11 real bases.
  for (const [nick, tag] of Object.entries(NICKNAME_TO_TAG)) {
    if (nick === '0') continue
    if (!report.tagsSeen.has(normalizeTag(tag))) {
      console.log(`  ${nick} -> ${tag}`)
      anyUnseen = true
    }
  }
  if (!anyUnseen) console.log('  (none — all 11 known tags appear in at least one file)')

  if (report.gapRows.length > 0) {
    console.log(`\n--- Mid-table gap rows tolerated, not treated as the boundary (${report.gapRows.length}) ---`)
    for (const entry of report.gapRows) {
      console.log(`  ${entry.file} [${entry.sheet}]: row ${entry.row}`)
    }
  } else {
    console.log('\n--- Mid-table gap rows: none ---')
  }

  if (report.unmappedNicknames.length > 0) {
    console.log(`\n--- Unmapped Playa values (${report.unmappedNicknames.length}) ---`)
    for (const entry of report.unmappedNicknames) {
      console.log(`  ${entry.file} [${entry.sheet}]: "${entry.playa}"`)
    }
  } else {
    console.log('\n--- Unmapped Playa values: none ---')
  }

  if (report.rowsMissingTH.length > 0) {
    console.log(`\n--- Rows skipped for missing TH (${report.rowsMissingTH.length}) ---`)
    for (const entry of report.rowsMissingTH) {
      console.log(`  ${entry.file} [${entry.sheet}]: "${entry.playa}"`)
    }
  } else {
    console.log('\n--- Rows skipped for missing TH: none ---')
  }

  if (report.columnMapWarnings.length > 0) {
    console.log(`\n--- Column-map warnings (${report.columnMapWarnings.length}) ---`)
    for (const entry of report.columnMapWarnings) {
      console.log(`  ${entry.file} [${entry.sheet}]: ${entry.warning}`)
    }
  } else {
    console.log('\n--- Column-map warnings: none ---')
  }

  if (report.collisions.length > 0) {
    console.log(`\n!!! COLLISIONS with existing non-'import' rows (${report.collisions.length}) !!!`)
    for (const entry of report.collisions) {
      console.log(`  ${entry.tag} @ ${entry.weekStart} — already captured_by=${entry.existingCapturedBy}`)
    }
  } else {
    console.log("\n--- Collisions with existing non-'import' rows: none ---")
  }

  console.log('\n=== end of report ===\n')
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname

if (isMainModule) {
  const write = process.argv.includes('--write')
  const dir =
    process.argv.find((arg) => arg.startsWith('--dir='))?.slice('--dir='.length) ??
    join(
      process.env.HOME ?? '',
      'Library/CloudStorage/Dropbox/info/Games/CoC/Clashy',
    )

  const files = readdirSync(dir)
    .filter((name) => /^Clashy_\d{4}-\d{2}-\d{2}\.xlsx$/.test(name))
    .sort() // filenames sort chronologically — ascending date order, required so the diff note per tag is never computed out of order
    .map((name) => join(dir, name))

  if (files.length === 0) {
    console.error(`No Clashy_*.xlsx files found under ${dir}`)
    process.exit(1)
  }

  const databasePath = databasePathFromEnv(process.env)
  const db = openDatabase(databasePath)

  const report = buildReport(files, db)
  printReport(report)

  if (!write) {
    console.log('Dry run only — no rows written. Re-run with --write to commit.')
    db.close()
    process.exit(0)
  }

  if (report.collisions.length > 0) {
    console.error(
      `\nRefusing to write: ${report.collisions.length} planned upsert(s) would overwrite a week already ` +
        `captured by something other than this script. See COLLISIONS above.`,
    )
    db.close()
    process.exit(1)
  }

  const progress: ProgressStore = createProgressStore(db)
  let written = 0
  for (const plan of report.planned) {
    // Re-check immediately before writing — the report above was built from
    // the same open connection, but nothing else should be writing to this
    // database concurrently during a one-shot import; this is the actual
    // guard, the report was only the preview of it.
    const collision = findNonImportCapturedBy(db, plan.tag, plan.weekStart)
    if (collision) {
      console.error(
        `\nAborting mid-run: ${plan.tag} @ ${plan.weekStart} now has a non-'import' row ` +
          `(captured_by=${collision}) that did not exist when the report was built. ` +
          `${written} row(s) were written before this happened.`,
      )
      db.close()
      process.exit(1)
    }
    progress.upsertSnapshot(plan.tag, plan.weekStart, { auto: plan.auto, manual: plan.manual }, {
      source: 'import',
    })
    written += 1
  }

  console.log(`\nWrote ${written} row(s) with captured_by='import'.`)
  db.close()
}
