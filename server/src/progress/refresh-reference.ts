import { databasePathFromEnv, openDatabase } from '../db.ts'
import { createProgressStore } from './store.ts'
import {
  buildMaxLevelReference,
  buildWallReference,
  parseHeroHallLevelCaps,
  parseLaboratoryUpgradeChart,
  parseTownHallBuildingLevels,
  parseWallReference,
  TOWN_HALL_MAX,
  TOWN_HALL_MIN,
} from './wiki-tables.ts'

/**
 * The weekly job that keeps `max_level_reference` and `wall_reference` current
 * — migration v11's follow-up (`server/src/db.ts`). Run directly:
 *
 *   tsx server/src/progress/refresh-reference.ts
 *
 * with `.env` loaded (`--env-file-if-exists=../.env` from `server/`, or a
 * process manager that loads it another way — a later step wires this into a
 * systemd timer; this file only has to be correct to run under one).
 *
 * Why this exists at all: the Clash of Clans API returns a unit's *absolute*
 * game-max level, never the cap at a given Town Hall. Confirmed directly
 * against the live API earlier in this project — a TH18, a TH12 and a TH11
 * account all reported Barbarian King `maxLevel: 110`, the same number a
 * fresh TH7 account would see the moment the hero unlocks. "% maxed for my
 * current TH", which is what a player actually tracks, needs a reference
 * table nothing in the official API provides. `clashofclans.fandom.com` has
 * it; `wiki-tables.ts` is the parser, kept pure and separate so it can be
 * tested against a captured fixture instead of only against the live wiki.
 *
 * Reached the same way `scripts/fetch-wiki-art.mjs` reaches this wiki: the
 * MediaWiki API only (`action=parse&prop=wikitext`, never page HTML — a plain
 * fetch of a page URL gets HTTP 402, a pay-or-consent wall aimed at
 * ad-supported rendering, confirmed earlier in this project), a descriptive
 * `User-Agent` naming the tool and a contact ({@link WIKI_CONTACT}), and
 * serial requests paced by {@link DELAY_MS}. Four pages, so a cold run costs
 * four requests a little over a second apart — nowhere near what would need
 * batching the way that script's image-existence checks do.
 *
 * Coverage, and why it is partial rather than an accident: `troop`, `spell`
 * and `hero` are covered in full (Town Hall 1-18, from `Laboratory/Upgrade
 * Chart` and the Hero Hall page's "Hero Hall Level Caps" table), and so are
 * walls. `pet` and `equipment` are not — see `wiki-tables.ts`'s header for
 * why each was left out rather than parsed on a guess. This job is additive:
 * it upserts what it found and touches nothing for the categories it did not
 * attempt, so a database that already has pet/equipment data from a future
 * run of an improved script keeps it.
 *
 * One source considered and rejected: each hero's own page lists its level-up
 * requirements in a Statistics table with a "Town Hall Level Required"
 * column, which looks like a direct level -> Town Hall mapping without the
 * Hero Hall indirection at all. It was not used. Barbarian King's level 1 row
 * there carries `rowspan="3"` over three sub-rows with three different
 * "Town Hall Level Required" values (4, 5, 6) and three different damage
 * figures for the same nominal level — almost certainly a history of
 * successive rebalances kept in the same cell rather than one current value,
 * but which of the three (if any) is "current" is not something this pass
 * could establish with confidence. The Hero Hall Level Caps table has no such
 * ambiguity: one row per Hero Hall level, one column per hero, no rowspan.
 */

const WIKI_API = 'https://clashofclans.fandom.com/api.php'

/** MediaWiki's UA policy wants a tool name and a way to reach whoever runs it. */
const CONTACT = process.env.WIKI_CONTACT ?? 'personal use, no bulk crawling'
const UA = `coc-explorer/0.1 (non-commercial Clash of Clans fan tool; ${CONTACT})`

/** Serial pacing between wiki requests, matching `fetch-wiki-art.mjs`. */
const DELAY_MS = 300

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface WikitextParseResponse {
  parse?: { wikitext?: { '*'?: string } }
}

/** Fetches one page's current wikitext via the MediaWiki API — never page HTML. */
async function fetchWikitext(title: string): Promise<string> {
  const params = new URLSearchParams({
    action: 'parse',
    format: 'json',
    prop: 'wikitext',
    page: title,
  }).toString()
  const url = `${WIKI_API}?${params}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`wiki parse ${title} -> HTTP ${res.status}`)
  const body = (await res.json()) as WikitextParseResponse
  const wikitext = body.parse?.wikitext?.['*']
  if (!wikitext) throw new Error(`wiki parse ${title} -> no wikitext in response`)
  return wikitext
}

async function main() {
  console.log(`fetching reference pages from clashofclans.fandom.com as: ${UA}`)

  const townHallWikitext = await fetchWikitext('Town Hall')
  await sleep(DELAY_MS)
  const labChartWikitext = await fetchWikitext('Laboratory/Upgrade Chart')
  await sleep(DELAY_MS)
  const heroHallWikitext = await fetchWikitext('Hero Hall')
  await sleep(DELAY_MS)
  const wallWikitext = await fetchWikitext('Wall/Home Village')

  const thBuildings = parseTownHallBuildingLevels(townHallWikitext)
  const { units: labUnits, warnings: labWarnings } = parseLaboratoryUpgradeChart(labChartWikitext)
  const heroes = parseHeroHallLevelCaps(heroHallWikitext)
  const wallInfo = parseWallReference(wallWikitext)

  const maxLevelRows = buildMaxLevelReference(labUnits, heroes, thBuildings)
  const wallRows = buildWallReference(wallInfo)

  const db = openDatabase(databasePathFromEnv(process.env))
  const store = createProgressStore(db)
  store.upsertMaxLevelReference(maxLevelRows)
  store.upsertWallReference(wallRows)

  /* ---------- coverage report, in the spirit of fetch-wiki-art.mjs's ---------- */

  const byCategory = new Map<string, { units: Set<string>; thMin: number; thMax: number }>()
  for (const row of maxLevelRows) {
    const bucket = byCategory.get(row.category) ?? {
      units: new Set<string>(),
      thMin: Infinity,
      thMax: -Infinity,
    }
    bucket.units.add(row.name)
    bucket.thMin = Math.min(bucket.thMin, row.thLevel)
    bucket.thMax = Math.max(bucket.thMax, row.thLevel)
    byCategory.set(row.category, bucket)
  }

  console.log('\n--- coverage ---')
  for (const [category, bucket] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(
      `${category.padEnd(10)} ${String(bucket.units.size).padStart(3)} units, ` +
        `TH${bucket.thMin}-${bucket.thMax}`,
    )
  }
  if (wallRows.length > 0) {
    const thMin = Math.min(...wallRows.map((row) => row.thLevel))
    const thMax = Math.max(...wallRows.map((row) => row.thLevel))
    console.log(`${'wall'.padEnd(10)}   1 unit,  TH${thMin}-${thMax}`)
  } else {
    console.log(`${'wall'.padEnd(10)} no rows parsed`)
  }
  console.log(
    `${'pet'.padEnd(10)} skipped — Pet House's Max Level Chart uses rowspan this parser ` +
      'does not reconstruct; see wiki-tables.ts',
  )
  console.log(
    `${'equipment'.padEnd(10)} skipped — item rarity is not on the Blacksmith page and this ` +
      'pass did not fetch all ~40 item pages to resolve it; see wiki-tables.ts',
  )

  console.log(
    `\ntotal      ${maxLevelRows.length} max-level rows, ${wallRows.length} wall rows written ` +
      `(TH${TOWN_HALL_MIN}-${TOWN_HALL_MAX} range)`,
  )
  if (labWarnings.length > 0) {
    console.log(`\n${labWarnings.length} Laboratory/Upgrade Chart warnings:`)
    for (const warning of labWarnings) console.log(`  ${warning}`)
  }
}

// Only runs when this file is executed directly (`tsx refresh-reference.ts`), never
// on import — the same guard capture-snapshot.ts and backfill-history.ts use, so
// importing this file (a future test, a future admin-triggered route) can never
// open a database or hit the live wiki as a side effect of `import`.
const isMainModule = process.argv[1] === new URL(import.meta.url).pathname

if (isMainModule) {
  await main()
}
