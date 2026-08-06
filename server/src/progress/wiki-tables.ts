import type { MaxLevelReferenceInput, UnitCategory, WallReferenceInput } from '@coc/shared'

/**
 * Turns the wikitext of a handful of clashofclans.fandom.com pages into the
 * `max_level_reference` / `wall_reference` rows `progress/store.ts` writes.
 * Pure and network-free on purpose — `refresh-reference.ts` is the only caller
 * that fetches anything, so this file is the piece worth pinning with a
 * fixture instead of only integration-testing against the live wiki.
 *
 * The Clash of Clans API gives a unit's *absolute* game-max level, never the
 * cap at a given Town Hall (see `refresh-reference.ts` for the confirmation).
 * The wiki has that, but never as one clean "Town Hall -> cap" table per unit:
 * every unit's own page lists its level-up costs against the level of the
 * *building that unlocks it* (Laboratory, Hero Hall, ...), not against Town
 * Hall directly. So this is a two-step lookup for every category: Town Hall ->
 * that building's max level (`parseTownHallBuildingLevels`), then building
 * level -> unit level (`parseLaboratoryUpgradeChart` / `parseHeroHallLevelCaps`
 * — one aggregate page per category rather than one page per unit, chosen
 * deliberately over the ~30 individual troop/spell/hero pages that carry the
 * same numbers less conveniently).
 *
 * Two categories the schema has room for — `pet` and `equipment` — are not
 * covered here. `Pet House`'s "Max Level Chart" compresses its grid with
 * heavy `rowspan`, which this module's row parser does not reconstruct (see
 * `splitTableRows`); getting it wrong would silently write a wrong number
 * rather than leave a gap, so it is left out rather than guessed at.
 * Equipment's Blacksmith table gives a level cap per *rarity* (Common/Epic),
 * not per item, and nothing on that page says which of the ~40 items across
 * six heroes is which rarity — that lives on each item's own page, and
 * fetching forty pages to resolve one field each run is a cost this pass did
 * not take on. Both are legitimate follow-ups, not forgotten scope.
 */

/** The Town Hall range these pages describe. TH19 does not exist yet; update when it does. */
export const TOWN_HALL_MIN = 1
export const TOWN_HALL_MAX = 18

/* ---------------------------------------------------------------------------
 * Generic wikitext table plumbing
 *
 * MediaWiki table syntax allows a row's cells either one per line (`| a\n| b`)
 * or several to a line (`| a || b`), and both styles appear across the pages
 * this module reads — sometimes in the same table. `splitTableRows` handles
 * both by always splitting a cell-bearing line on its multi-cell separator
 * (`||` or `!!`); a one-cell-per-line table simply never contains that
 * separator, so the split is a no-op for it.
 *
 * What it deliberately does NOT do: reconstruct `rowspan`/`colspan`. Every
 * table this module parses repeats a value on every row that needs it — except
 * Pet House's Max Level Chart, which is exactly why that page is skipped
 * rather than parsed wrong.
 * ------------------------------------------------------------------------- */

/** Every `{|...|}` table in `wikitext`, verbatim, in document order. Tables here never nest. */
export function splitIntoTables(wikitext: string): string[] {
  const lines = wikitext.split('\n')
  const blocks: string[] = []
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (start === -1 && line.startsWith('{|')) {
      start = i
      continue
    }
    if (start !== -1 && line.startsWith('|}')) {
      blocks.push(lines.slice(start, i + 1).join('\n'))
      start = -1
    }
  }
  return blocks
}

/**
 * One table's rows, each a flat array of raw (unprocessed) cell segments —
 * still carrying any `attr="x"|` prefix and wiki markup, which `stripAttrs`,
 * `cleanWikiText`, `cellLabel` and `parseLevelValue` peel off as each caller
 * needs. A row header cell (`!`) and the data cells that follow it on later
 * lines land in the same output row, which is what lets a caller read a
 * row-heading value (e.g. a Town Hall level) and its data cells together.
 */
export function splitTableRows(wikitext: string): string[][] {
  const rows: string[][] = []
  let current: string[] = []
  const flush = () => {
    if (current.length > 0) rows.push(current)
    current = []
  }

  for (const rawLine of wikitext.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('{|') || line.startsWith('|}')) {
      flush()
      continue
    }
    if (line === '|-' || line.startsWith('|-')) {
      flush()
      continue
    }
    if (line.startsWith('|+')) continue // caption, not a cell
    if (line.startsWith('!')) {
      for (const segment of line.slice(1).split('!!')) current.push(segment)
      continue
    }
    if (line.startsWith('|')) {
      for (const segment of line.slice(1).split('||')) current.push(segment)
      continue
    }
    // Prose, template calls, blank lines between tables — not table markup.
  }
  flush()
  return rows
}

/** Content after a cell's `attr="x"|` prefix, if it has one — otherwise the cell unchanged. */
function stripAttrs(raw: string): string {
  const trimmed = raw.trim()
  const pipeIndex = trimmed.indexOf('|')
  return (pipeIndex === -1 ? trimmed : trimmed.slice(pipeIndex + 1)).trim()
}

/** Strips HTML tags, `''`/`'''` emphasis markers and a leading footnote `*`. */
function cleanWikiText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/'{2,}/g, '')
    .replace(/^\*+/, '')
    .trim()
}

/**
 * A unit/building/column name out of `{{H|Name}}` or `[[Name]]` / `[[Name|Alias]]` —
 * the two conventions these pages use for a name that links somewhere — falling
 * back to plain cleaned text for a header cell that is not a link at all (e.g.
 * `Total Levels`).
 */
export function cellLabel(raw: string): string {
  // Checked against the RAW segment, before any attribute stripping: a
  // template or link's own `|` (the one between `{{H|` and the name, or
  // between `[[Name|` and an alias) is not an attribute separator, and a cell
  // with no attribute prefix at all — `{{H|Barbarian}}` with nothing before
  // it — would otherwise have that internal pipe mistaken for one, corrupting
  // the extracted name (`stripAttrs` would leave `Barbarian}}`, not
  // `Barbarian`). Only a cell that is neither falls through to attribute
  // stripping, for plain text that may genuinely carry an attr prefix
  // (`class="colheader"|Total Levels`).
  const templateMatch = /\{\{H\|([^}|]+)/.exec(raw)
  if (templateMatch) return (templateMatch[1] ?? '').trim()
  const linkMatch = /\[\[([^\]|]+)/.exec(raw)
  if (linkMatch) return (linkMatch[1] ?? '').trim()
  return cleanWikiText(stripAttrs(raw))
}

/**
 * A "Level"-style cell's value: a plain integer, `-`/empty for "nothing new at
 * this tier" (`null`), or several upgrades folded into one tier and delimited
 * by `/` — `Laboratory/Upgrade Chart`'s own convention for a unit that can be
 * pushed through more than one level without the Laboratory itself upgrading
 * again — the highest of which is what a running maximum cares about.
 */
export function parseLevelValue(raw: string): number | null {
  const cleaned = cleanWikiText(stripAttrs(raw))
  if (cleaned === '' || cleaned === '-' || cleaned === '—') return null
  const numbers = cleaned
    .split('/')
    .map((part) => Number(part.trim().replace(/,/g, '')))
    .filter((n) => Number.isFinite(n))
  return numbers.length > 0 ? Math.max(...numbers) : null
}

/**
 * Slices out the `{|…|}` table that starts at or after `marker`'s first
 * occurrence in `wikitext` — for a marker that precedes its table, such as a
 * section heading or a tabber tab label. Several tables across these pages
 * share a caption or a column name (see `parseTownHallBuildingLevels`), which
 * is why every caller narrows `wikitext` to the right section before calling
 * this rather than searching the whole page — a marker that is unique only
 * within that narrowed slice still finds the wrong table if the slice is
 * skipped.
 */
export function tableAfter(wikitext: string, marker: string): string {
  const markerIndex = wikitext.indexOf(marker)
  if (markerIndex === -1) throw new Error(`marker not found: ${marker}`)
  const tableStart = wikitext.indexOf('{|', markerIndex)
  if (tableStart === -1) throw new Error(`no table found after marker: ${marker}`)
  const tableEnd = wikitext.indexOf('\n|}', tableStart)
  if (tableEnd === -1) throw new Error(`unterminated table after marker: ${marker}`)
  return wikitext.slice(tableStart, tableEnd + 3)
}

/**
 * Slices out the `{|…|}` table that `marker` itself sits inside — for a
 * marker that is part of the table (a header cell's own text), such as
 * `parseWallReference`'s column header.
 */
export function tableContaining(wikitext: string, marker: string): string {
  const markerIndex = wikitext.indexOf(marker)
  if (markerIndex === -1) throw new Error(`marker not found: ${marker}`)
  const tableStart = wikitext.lastIndexOf('{|', markerIndex)
  if (tableStart === -1) throw new Error(`no table found containing marker: ${marker}`)
  const tableEnd = wikitext.indexOf('\n|}', markerIndex)
  if (tableEnd === -1) throw new Error(`unterminated table containing marker: ${marker}`)
  return wikitext.slice(tableStart, tableEnd + 3)
}

/* ---------------------------------------------------------------------------
 * Town Hall -> building level
 * ------------------------------------------------------------------------- */

export interface ThBuildingLevels {
  laboratory: number
  heroHall: number
}

/**
 * Town Hall -> max Laboratory / Hero Hall level, off the "Building Maximum
 * Levels" tab in the Town Hall page's "Army Buildings and Heroes" section.
 *
 * That tab's caption ("Town Hall - Building Max Level") is reused verbatim by
 * three different building categories on this one page (Resource, Army,
 * Defensive) — a plain caption search lands on the Resource Buildings table
 * instead, silently wrong in a way nothing downstream would catch. Narrowing
 * to the "Army Buildings and Heroes" section first is what makes the caption
 * unique.
 */
export function parseTownHallBuildingLevels(wikitext: string): Map<number, ThBuildingLevels> {
  const sectionIndex = wikitext.indexOf('Army Buildings and Heroes')
  if (sectionIndex === -1) throw new Error('"Army Buildings and Heroes" section not found')
  const section = wikitext.slice(sectionIndex)
  const table = tableAfter(section, 'Building Maximum Levels=')
  const rows = splitTableRows(table)

  const header = rows[0] ?? []
  const laborIndex = header.findIndex((cell) => cell.includes('Laboratory'))
  const heroHallIndex = header.findIndex((cell) => cell.includes('Hero Hall'))
  if (laborIndex === -1 || heroHallIndex === -1) {
    throw new Error('Laboratory or Hero Hall column not found in the Town Hall building table')
  }

  const result = new Map<number, ThBuildingLevels>()
  for (const row of rows.slice(1)) {
    const thLevel = parseLevelValue(row[0] ?? '')
    if (thLevel === null) continue
    const laboratory = parseLevelValue(row[laborIndex] ?? '') ?? 0
    const heroHall = parseLevelValue(row[heroHallIndex] ?? '') ?? 0
    result.set(thLevel, { laboratory, heroHall })
  }
  return result
}

/* ---------------------------------------------------------------------------
 * Hero Hall level -> hero level
 * ------------------------------------------------------------------------- */

/**
 * Hero Hall level -> each hero's max level, off the Hero Hall page's "Hero
 * Hall Level Caps" table — the one place all of them are listed together,
 * rather than the per-hero Statistics tables (rejected; see
 * `refresh-reference.ts`'s header for why those are not a clean "level ->
 * requirement" source for level 1).
 *
 * Hero names come from the table's own header cells rather than a hardcoded
 * list, so a seventh hero added later needs no change here.
 */
export function parseHeroHallLevelCaps(wikitext: string): Map<string, Map<number, number>> {
  const table = tableAfter(wikitext, '===Hero Hall Level Caps===')
  const rows = splitTableRows(table)

  const header = rows[0] ?? []
  // First column is the Hero Hall level itself; the last is the "Total Levels"
  // summary column, which is not a hero.
  const heroNames = header.slice(1, -1).map((cell) => cellLabel(cell))
  const heroCaps = heroNames.map(() => new Map<number, number>())

  for (const row of rows.slice(1)) {
    const hallLevel = parseLevelValue(row[0] ?? '')
    if (hallLevel === null) continue
    for (let i = 0; i < heroCaps.length; i++) {
      const level = parseLevelValue(row[1 + i] ?? '')
      const capMap = heroCaps[i]
      if (level !== null && capMap) capMap.set(hallLevel, level)
    }
  }

  const heroes = new Map<string, Map<number, number>>()
  heroNames.forEach((name, i) => {
    const capMap = heroCaps[i]
    if (capMap) heroes.set(name, capMap)
  })
  return heroes
}

/* ---------------------------------------------------------------------------
 * Laboratory level -> troop/spell level
 * ------------------------------------------------------------------------- */

export interface LabUnitCaps {
  name: string
  category: Extract<UnitCategory, 'troop' | 'spell'>
  /**
   * Cumulative max level achievable, keyed by the exact Laboratory level the
   * table lists for that column. Not always 1..16: the Siege Machines table
   * on the same page starts its columns at Laboratory level 10, because no
   * siege machine unlocks before that.
   */
  capAtLabLevel: Map<number, number>
}

/**
 * Every troop, spell and siege machine's level cap by Laboratory level, off
 * `Laboratory/Upgrade Chart` — three tables (Elixir, Dark Elixir, Siege
 * Machines) covering everything the Laboratory upgrades, in one page instead
 * of the ~30 individual unit pages that each carry only their own column of
 * the same numbers. Siege machines are folded into `'troop'`: the CoC API
 * returns them alongside troops, and the schema has no separate category for
 * them.
 *
 * A unit is classified `'spell'` if its name contains "Spell" and `'troop'`
 * otherwise — reliable here because every offensive/reinforcement spell in
 * the game is in fact named "... Spell" and no troop or siege machine is.
 *
 * `warnings` collects anything that did not parse the way the rest of the
 * page did — a table whose Laboratory-level header row was not all integers,
 * or a unit's Level row with a different cell count than its table's own
 * column count — so one malformed row costs that one unit rather than the
 * whole page silently producing nothing or, worse, misaligned numbers.
 */
export function parseLaboratoryUpgradeChart(wikitext: string): {
  units: LabUnitCaps[]
  warnings: string[]
} {
  const units: LabUnitCaps[] = []
  const warnings: string[] = []

  for (const table of splitIntoTables(wikitext)) {
    const rows = splitTableRows(table)

    // rows[0] is the two-cell "Upgrade Chart" / "Laboratory Level" colspan
    // header; rows[1] is the row of individual Laboratory Level column
    // numbers — what this table's value columns actually mean.
    const labLevelsRow = rows[1] ?? []
    const labLevels: number[] = []
    let headerOk = labLevelsRow.length > 0
    for (const cell of labLevelsRow) {
      const level = parseLevelValue(cell)
      if (level === null) {
        headerOk = false
        break
      }
      labLevels.push(level)
    }
    if (!headerOk) {
      warnings.push(
        'a table on Laboratory/Upgrade Chart had no readable Laboratory Level header row; skipped',
      )
      continue
    }

    for (const row of rows.slice(2)) {
      const firstRaw = row[0] ?? ''
      // A unit's Level row is the only kind of row that repeats the rowspanned
      // name cell — Cost and Time rows do not, since the wikitext only writes
      // that cell once. `{{H|...}}` or `[[...]]` in the first cell is what
      // distinguishes the two.
      if (!/\{\{H\||\[\[/.test(firstRaw)) continue
      if (cellLabel(row[1] ?? '').toLowerCase() !== 'level') continue

      const name = cellLabel(firstRaw)
      const values = row.slice(2).map((cell) => parseLevelValue(cell))
      if (values.length !== labLevels.length) {
        warnings.push(
          `${name}: Level row had ${values.length} cells, expected ${labLevels.length}; skipped`,
        )
        continue
      }

      const capAtLabLevel = new Map<number, number>()
      let runningMax = 0
      for (let i = 0; i < labLevels.length; i++) {
        const labLevel = labLevels[i]
        const value = values[i]
        if (labLevel === undefined) continue
        if (value !== null && value !== undefined && value > runningMax) runningMax = value
        if (runningMax > 0) capAtLabLevel.set(labLevel, runningMax)
      }
      if (capAtLabLevel.size === 0) {
        warnings.push(`${name}: no level values parsed at all; skipped`)
        continue
      }

      units.push({ name, category: name.includes('Spell') ? 'spell' : 'troop', capAtLabLevel })
    }
  }

  return { units, warnings }
}

/* ---------------------------------------------------------------------------
 * Walls
 * ------------------------------------------------------------------------- */

export interface WallLevelInfo {
  maxWallLevelByTh: Map<number, number>
  totalWallCountByTh: Map<number, number>
}

/**
 * Town Hall -> max wall level and total wall count, off `Wall/Home Village`.
 *
 * The level cap comes off the Statistics table's "Town Hall Level Required"
 * column — one row per wall level, the same "level -> requirement" shape as
 * every other unit's Statistics table on this wiki, and unambiguous here
 * because a wall has no history-laden level-1 rowspan the way a hero's page
 * does. The count comes from the `{{NumberAvailable|...}}` template call in
 * the same section, which lists it as step changes (`TH2=25`, `TH7=175`, ...)
 * rather than one row per Town Hall, so it is forward-filled across
 * `TOWN_HALL_MIN..TOWN_HALL_MAX` here.
 */
export function parseWallReference(wikitext: string): WallLevelInfo {
  const table = tableContaining(wikitext, 'Level Required<br/>{{Res|Town Hall}}')
  const rows = splitTableRows(table)

  const header = rows[0] ?? []
  const thRequiredIndex = header.findIndex((cell) => cell.includes('Town Hall'))
  if (thRequiredIndex === -1) {
    throw new Error('Town Hall Level Required column not found on the Wall page')
  }

  const requiredByWallLevel = new Map<number, number>()
  for (const row of rows.slice(1)) {
    const wallLevel = parseLevelValue(row[0] ?? '')
    const thRequired = parseLevelValue(row[thRequiredIndex] ?? '')
    if (wallLevel !== null && thRequired !== null) requiredByWallLevel.set(wallLevel, thRequired)
  }

  const maxWallLevelByTh = new Map<number, number>()
  for (let th = TOWN_HALL_MIN; th <= TOWN_HALL_MAX; th++) {
    let best = 0
    for (const [wallLevel, required] of requiredByWallLevel) {
      if (required <= th && wallLevel > best) best = wallLevel
    }
    if (best > 0) maxWallLevelByTh.set(th, best)
  }

  const templateMatch = /\{\{NumberAvailable\|([^}]*)\}\}/.exec(wikitext)
  const totalWallCountByTh = new Map<number, number>()
  if (templateMatch) {
    const steps = new Map<number, number>()
    for (const token of (templateMatch[1] ?? '').split(/\|+/)) {
      const stepMatch = /^TH(\d+)\s*=\s*(\d+)$/i.exec(token.trim())
      if (stepMatch) {
        const th = Number(stepMatch[1])
        const count = Number(stepMatch[2])
        steps.set(th, count)
      }
    }
    let current = 0
    for (let th = TOWN_HALL_MIN; th <= TOWN_HALL_MAX; th++) {
      const step = steps.get(th)
      if (step !== undefined) current = step
      if (current > 0) totalWallCountByTh.set(th, current)
    }
  }

  return { maxWallLevelByTh, totalWallCountByTh }
}

/* ---------------------------------------------------------------------------
 * Combining into what the store accepts
 * ------------------------------------------------------------------------- */

/** The value for the greatest key `<= ceiling`, or `undefined` if no key qualifies. */
function atOrBelow(byRequirement: Map<number, number>, ceiling: number): number | undefined {
  let best: number | undefined
  let bestRequirement = -Infinity
  for (const [requirement, value] of byRequirement) {
    if (requirement <= ceiling && requirement > bestRequirement) {
      best = value
      bestRequirement = requirement
    }
  }
  return best
}

/**
 * `max_level_reference` rows for troops, spells and heroes: every Town Hall in
 * `thBuildings` crossed with every unit, via each unit's own building-level
 * requirement (Laboratory for troops/spells, Hero Hall for heroes). A Town
 * Hall below a unit's minimum requirement contributes no row for it — that
 * unit is not yet obtainable there, which is a gap in the source data, not a
 * bug in this join.
 */
export function buildMaxLevelReference(
  labUnits: LabUnitCaps[],
  heroes: Map<string, Map<number, number>>,
  thBuildings: Map<number, ThBuildingLevels>,
): MaxLevelReferenceInput[] {
  const rows: MaxLevelReferenceInput[] = []

  for (const unit of labUnits) {
    for (const [thLevel, building] of thBuildings) {
      const maxLevel = atOrBelow(unit.capAtLabLevel, building.laboratory)
      if (maxLevel !== undefined) rows.push({ category: unit.category, name: unit.name, thLevel, maxLevel })
    }
  }

  for (const [name, capByHallLevel] of heroes) {
    for (const [thLevel, building] of thBuildings) {
      const maxLevel = atOrBelow(capByHallLevel, building.heroHall)
      if (maxLevel !== undefined) rows.push({ category: 'hero', name, thLevel, maxLevel })
    }
  }

  return rows
}

/** `wall_reference` rows: one per Town Hall that has both a level cap and a count. */
export function buildWallReference(wallInfo: WallLevelInfo): WallReferenceInput[] {
  const rows: WallReferenceInput[] = []
  for (let th = TOWN_HALL_MIN; th <= TOWN_HALL_MAX; th++) {
    const maxWallLevel = wallInfo.maxWallLevelByTh.get(th)
    const totalWallCount = wallInfo.totalWallCountByTh.get(th)
    if (maxWallLevel !== undefined && totalWallCount !== undefined) {
      rows.push({ thLevel: th, maxWallLevel, totalWallCount })
    }
  }
  return rows
}
