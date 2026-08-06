import {
  type AutoCapturePayload,
  type MaxLevelReferenceRow,
  type Player,
  type PlayerItemLevel,
  type UnitLevel,
} from '@coc/shared'
import { createCocClient, type CocClient } from '../coc-client.ts'
import { databasePathFromEnv, openDatabase } from '../db.ts'
import { createProgressStore, type ProgressStore } from './store.ts'
import { createSharedDataStore, type SharedDataStore } from '../shared-data/store.ts'

/**
 * The scheduled auto-capture job: one pass over every base worth tracking —
 * every live member of every saved clan, unioned with every base anyone has
 * claimed (`collectTrackedTags`) — pulling this week's Town Hall, heroes, hero
 * equipment, pets, troops and spells from the live API and writing them into
 * `base_progress` via `upsertSnapshot`. Run standalone —
 * `tsx server/src/progress/capture-snapshot.ts` with `.env` loaded — on
 * whatever schedule a later step wires into systemd. This file only does the
 * one run; it does not loop or sleep.
 *
 * Progress-tracking deliberately does not scope itself to owner assignments the
 * way `web/src/base-labels.ts`'s `useBaseLabels` does for cards and trades. That
 * feature is owner-gated because a base nobody has claimed has nothing for a
 * person to enter; this one reads Town Hall, heroes and the rest straight off the
 * Supercell API with no ownership question involved, so excluding an unclaimed
 * member would only hide a base nobody happens to be watching yet.
 *
 * Only home-village fields are captured — see `homeVillageOnly` below. Builder
 * Base units (Battle Machine, Battle Copter, and any builder-base troop or spell)
 * have no place on a page that is explicitly main-base progress.
 *
 * The functions above the `import.meta` guard at the bottom are pure (or
 * take their dependencies as arguments) and are what `capture-snapshot.test.ts`
 * exercises directly. Nothing below the guard runs on import — only when this
 * file is executed directly — so importing it for tests never opens a real
 * database or calls the live API.
 */

/**
 * The ISO date (`YYYY-MM-DD`, UTC) of the most recent Tuesday on or before
 * `now`. A separate piece of this feature (an HTTP route, built elsewhere)
 * implements the identical algorithm independently; the two are not shared
 * code on purpose, so they must both match this spec rather than each other:
 * `offsetDays = (now.getUTCDay() - 2 + 7) % 7`, then subtract that many days.
 */
export function currentWeekStart(now: Date): string {
  const offsetDays = (now.getUTCDay() - 2 + 7) % 7
  const weekStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offsetDays),
  )
  return weekStart.toISOString().slice(0, 10)
}

/**
 * The set of unit names `max_level_reference` currently calls a pet. Supercell's
 * API does not separate pets from regular troops — both arrive mixed into
 * `Player.troops`, with no field distinguishing them (confirmed by comparing
 * real API responses). Classifying by name against this reference, rather than
 * a hardcoded list, is what keeps the split in sync with the wiki-scraper job
 * that maintains it (`refresh-reference.ts`) instead of drifting from it.
 *
 * An empty result — nothing categorized `'pet'` yet — is an acceptable
 * bootstrap gap on this job's first-ever run, before the reference-refresh job
 * has populated anything: every troop is classified as a troop until then, and
 * the next successful reference refresh self-corrects it. Nothing here papers
 * over that with a fallback list.
 */
export function petNamesFromReference(rows: readonly MaxLevelReferenceRow[]): ReadonlySet<string> {
  return new Set(rows.filter((row) => row.category === 'pet').map((row) => row.name))
}

function toUnitLevel(item: PlayerItemLevel): UnitLevel {
  return { name: item.name, level: item.level, maxLevel: item.maxLevel }
}

/**
 * Drops every Builder Base entry (`village === 'builderBase'`) — and, for
 * completeness, anything that is not `'home'` at all, such as `'clanCapital'` —
 * keeping only the home-village half of whatever `Player.troops` / `.heroes` /
 * `.heroEquipment` / `.spells` handed over. The progress page is explicitly
 * main-base only: the Battle Machine, Battle Copter and every builder-base troop
 * or spell must never appear in a captured week. `player.townHallLevel` is not
 * filtered by this function because it is already home-base-specific — Supercell
 * reports Builder Hall level under a separate field this app does not capture.
 *
 * Applied **before** `splitTroopsAndPets` in `buildAutoCapturePayload`, on
 * purpose: pet classification only ever sees troops that already passed this
 * filter, so a Builder Base unit can never be misclassified as a home-village
 * pet.
 */
function homeVillageOnly(items: readonly PlayerItemLevel[] | undefined): PlayerItemLevel[] {
  return (items ?? []).filter((item) => item.village === 'home')
}

/**
 * Splits `Player.troops` into real troops and pets, per `petNames`. Pure and
 * DB-free so the classification can be tested against a fabricated name set
 * without a database or a live API call.
 */
export function splitTroopsAndPets(
  troops: readonly PlayerItemLevel[],
  petNames: ReadonlySet<string>,
): { troops: UnitLevel[]; pets: UnitLevel[] } {
  const splitTroops: UnitLevel[] = []
  const pets: UnitLevel[] = []

  for (const item of troops) {
    const unit = toUnitLevel(item)
    if (petNames.has(item.name)) pets.push(unit)
    else splitTroops.push(unit)
  }

  return { troops: splitTroops, pets }
}

/**
 * One player's API response, reshaped into what `upsertSnapshot` accepts.
 * `heroes`, `equipment`, `troops` and `spells` are all filtered to the home
 * village first (`homeVillageOnly`) — see that function's doc comment for why,
 * and for why the filter has to run before pet classification rather than after.
 */
export function buildAutoCapturePayload(
  player: Player,
  petNames: ReadonlySet<string>,
): AutoCapturePayload {
  const { troops, pets } = splitTroopsAndPets(homeVillageOnly(player.troops), petNames)
  return {
    thLevel: player.townHallLevel,
    heroes: homeVillageOnly(player.heroes).map(toUnitLevel),
    equipment: homeVillageOnly(player.heroEquipment).map(toUnitLevel),
    pets,
    troops,
    spells: homeVillageOnly(player.spells).map(toUnitLevel),
  }
}

export interface CaptureFailure {
  tag: string
  reason: string
}

export interface CaptureSummary {
  succeeded: string[]
  failed: CaptureFailure[]
}

/** The slice of each dependency this job actually calls, for narrow fakes in tests. */
export interface CaptureDeps {
  coc: Pick<CocClient, 'getPlayer'>
  progress: Pick<ProgressStore, 'upsertSnapshot'>
}

/** The slice of each dependency `collectTrackedTags` actually calls, for narrow fakes in tests. */
export interface RosterDeps {
  coc: Pick<CocClient, 'getClanMembers'>
  sharedData: Pick<SharedDataStore, 'listSavedClans' | 'listOwners'>
}

/**
 * Every tag this run should capture: the union of every live member across
 * every saved clan and every tag somebody has claimed ownership of, deduped.
 *
 * The clan rosters are what bring in the members nobody has assigned a base
 * owner to — the whole point of widening this job beyond `listOwners()` alone,
 * since progress-tracking reads straight off the live API and needs no
 * ownership to do it (see this file's header for why that is a deliberate
 * divergence from `useBaseLabels`). The owner tags stay in the union on top of
 * that so a base whose owner has since left the clan keeps being captured,
 * exactly as it did before this function existed — this only adds coverage, it
 * never removes any.
 *
 * Sequential over the saved clans, the same reasoning `captureAllSnapshots`
 * gives for going tag-by-tag rather than in parallel: this app has a handful of
 * saved clans, not thousands, so there is no throughput reason to fan out, and
 * the client has no built-in rate limiting to protect beyond its own
 * per-request timeout.
 *
 * One clan's roster failing to load — a bad tag, a timeout, the clan going
 * private — does not abort the run or drop the owner-assignment tags already
 * collected. It just means that clan's currently-unassigned members are
 * missing from this run, which is exactly the coverage this job had before
 * this function existed.
 */
export async function collectTrackedTags(deps: RosterDeps): Promise<string[]> {
  const tags = new Set<string>()
  for (const owner of deps.sharedData.listOwners()) tags.add(owner.tag)

  for (const clan of deps.sharedData.listSavedClans()) {
    try {
      const { items } = await deps.coc.getClanMembers(clan.tag)
      for (const member of items) tags.add(member.tag)
    } catch {
      // Handled in the doc comment above: this clan's members are simply
      // missing from this run, and every other clan's fetch still proceeds.
    }
  }

  return [...tags]
}

/**
 * Captures one snapshot per tag, sequentially — a clan-sized batch (dozens of
 * tags, not thousands) does not need concurrency, and the client has no
 * built-in rate limiting to protect beyond its own per-request timeout.
 *
 * A single tag's failure — the API 404ing a tag nobody owns any more, a
 * timeout, whatever — is caught and recorded rather than aborting the run: the
 * point of a scheduled job over dozens of bases is that one bad tag must not
 * cost every other base its week's capture.
 */
export async function captureAllSnapshots(
  tags: readonly string[],
  weekStart: string,
  petNames: ReadonlySet<string>,
  deps: CaptureDeps,
): Promise<CaptureSummary> {
  const succeeded: string[] = []
  const failed: CaptureFailure[] = []

  for (const tag of tags) {
    try {
      const player = await deps.coc.getPlayer(tag)
      const payload = buildAutoCapturePayload(player, petNames)
      deps.progress.upsertSnapshot(tag, weekStart, { auto: payload }, { source: 'auto' })
      succeeded.push(tag)
    } catch (cause) {
      failed.push({ tag, reason: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  return { succeeded, failed }
}

// Only runs when this file is executed directly (`tsx capture-snapshot.ts`),
// never on import — which is what lets the test file import the functions
// above without opening a real database or calling the live API.
const isMainModule = process.argv[1] === new URL(import.meta.url).pathname

if (isMainModule) {
  let coc: CocClient
  try {
    coc = createCocClient({ token: process.env.COC_API_TOKEN ?? '' })
  } catch (err) {
    console.error(`\n✗ ${(err as Error).message}\n`)
    process.exit(1)
  }

  const databasePath = databasePathFromEnv(process.env)
  const db = openDatabase(databasePath)
  const sharedData = createSharedDataStore(db)
  const progress = createProgressStore(db)

  const weekStart = currentWeekStart(new Date())
  const petNames = petNamesFromReference(progress.getAllMaxLevelReference())
  if (petNames.size === 0) {
    console.log(
      '→ max_level_reference has no pet rows yet — every troop this run will classify as a ' +
        "troop until the reference-refresh job populates it. Expected on this job's first-ever run.",
    )
  }

  const tags = await collectTrackedTags({ coc, sharedData })
  console.log(`→ capturing week ${weekStart} for ${tags.length} base(s)`)

  const summary = await captureAllSnapshots(tags, weekStart, petNames, { coc, progress })

  console.log(
    `→ capture complete: ${summary.succeeded.length} succeeded, ${summary.failed.length} failed`,
  )
  for (const failure of summary.failed) {
    console.error(`  ✗ ${failure.tag}: ${failure.reason}`)
  }

  db.close()
  if (summary.failed.length > 0 && summary.succeeded.length === 0) process.exitCode = 1
}
