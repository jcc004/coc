/**
 * Vendors unit artwork from clashofclans.fandom.com into web/public/coc/wiki, and
 * regenerates web/src/wiki-art.generated.ts with the names that resolved.
 *
 * Why a second script: the CoC API returns image URLs for clan badges, league
 * badges and label icons — and nothing else. Troops, spells, heroes, hero
 * equipment and Town Halls come back as bare `{ name, level, maxLevel, village }`,
 * which is why the progression section was text and meters with no imagery. The
 * community wiki has that art, so this fills the gap `fetch-coc-assets.mjs` cannot.
 *
 * How it stays polite:
 *  - MediaWiki API only (action=query&prop=imageinfo), never HTML scraping.
 *  - `iiurlwidth`/`iiurlheight` make MediaWiki produce the thumbnail, so we
 *    download ~48px art for a ~20px slot instead of pulling multi-megapixel
 *    originals and needing an image library to shrink them.
 *  - Existence checks are batched 50 titles per request; downloads run serially
 *    with a delay, and anything already on disk is skipped, so a re-run is cheap.
 *  - Total bytes are capped, and categories are fetched in priority order so a
 *    budget cut lands on the least valuable art rather than truncating silently.
 *
 * It resolves names by *convention*, never by fuzzy matching: a name either hits
 * an exact wiki file title derived from it, or it stays unmapped and reports as a
 * miss. A mislabeled troop icon is worse than no icon.
 *
 * Usage: COC_API_TOKEN=... node scripts/fetch-wiki-art.mjs
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KNOWN_ENTRIES, mergeKnownNames } from './wiki-art-known-names.mjs'

const TOKEN = process.env.COC_API_TOKEN
if (!TOKEN) {
  console.error('COC_API_TOKEN is not set. Load it from .env first, e.g.')
  console.error('  set -a && . ./.env && set +a && node scripts/fetch-wiki-art.mjs')
  process.exit(1)
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(REPO, 'web/public/coc/wiki')
const MANIFEST = join(OUT, 'manifest.json')
const GENERATED = join(REPO, 'web/src/wiki-art.generated.ts')

const COC_API = 'https://api.clashofclans.com/v1'
const WIKI_API = 'https://clashofclans.fandom.com/api.php'
const WIKI_SITE = 'https://clashofclans.fandom.com'

/** MediaWiki's UA policy wants a tool name and a way to reach whoever runs it. */
const CONTACT = process.env.WIKI_CONTACT ?? 'personal use, no bulk crawling'
const UA = `coc-explorer/0.1 (non-commercial Clash of Clans fan tool; ${CONTACT})`

/** Serial pacing between wiki requests. Polite, and ~1 minute for a cold run. */
const DELAY_MS = 300

/** Hard ceiling on what lands in web/public/coc/wiki. Reported against, not guessed at. */
const BUDGET_BYTES = 3 * 1024 * 1024

/**
 * `REFETCH=1` re-downloads every resolved name, overwriting whatever is on disk.
 * The default run skips a name whose art is already present, which is what makes
 * a re-run cheap — but it also means bumping THUMB does nothing on a folder that
 * already has the old, smaller files. Set this to pull the new size over them.
 */
const IGNORE_CACHE = process.env.REFETCH === '1'

/**
 * Longest side, in px. The small `.art-icon` slots render at 32px, but the same
 * unit art now also backs the card-collecting grid, whose tiles are far larger —
 * so these are sized for the biggest consumer (the card grid) rather than the
 * 32px slot. Asking MediaWiki for a thumbnail this size means the card art is
 * sharp and the little slots simply downscale it.
 *
 * Raising a tile's rendered size beyond this makes the art soft again; raise
 * these to match. A re-run at a larger size does not overwrite art already on
 * disk unless `REFETCH=1` is set (see IGNORE_CACHE) — otherwise the old, smaller
 * files are kept and reported as cached.
 */
const THUMB = { unit: 256, townHall: 256 }

/**
 * Fandom's thumbnailer answers WebP even for a `File:…png`, so the extension is
 * taken from the response rather than assumed. Naming a WebP `.png` works in dev
 * but is a real hazard in production: Nginx types the file by extension, and the
 * deployed config sends `X-Content-Type-Options: nosniff`, so the bytes and the
 * declared type have to agree.
 */
const EXTENSIONS = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }
const CANDIDATE_EXTENSIONS = ['webp', 'png', 'jpg']

const TOWN_HALL_MIN = 1
const TOWN_HALL_MAX = 18

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------- what art the app actually needs ---------- */

/**
 * Directory, thumbnail size and fetch order per kind. Order is the priority the
 * brief set: heroes first (few, most prominent), then equipment, home troops,
 * spells, Town Halls, and builder base troops last. A budget cut therefore drops
 * builder base art, not heroes.
 */
const KINDS = {
  hero: { dir: 'heroes', order: 1, size: THUMB.unit },
  equipment: { dir: 'equipment', order: 2, size: THUMB.unit },
  troop: { dir: 'troops', order: 3, size: THUMB.unit },
  spell: { dir: 'spells', order: 4, size: THUMB.unit },
  townHall: { dir: 'townhalls', order: 5, size: THUMB.townHall },
}

/** Builder base units are the tail of the priority list, below Town Halls. */
const orderOf = (entry) =>
  KINDS[entry.kind].order + (entry.village === 'builderBase' ? 10 : 0)

/**
 * Candidate wiki file titles for one name, most likely first.
 *
 * The wiki has two conventions and sticks to them: units (troops, spells, heroes)
 * use `<Name> info.png`, hero equipment uses a bare `<Name>.png`. Town Halls are
 * `Town Hall<n>.png` up to 16, then switch to `Town Hall <n> info.png` because
 * TH17+ ship several weapon states under `Town Hall<n>-<state>.png`.
 *
 * `.PNG` is a separate candidate, not a typo: MediaWiki titles are case sensitive
 * past the first letter, and a handful of uploads (File:Super Bowler.PNG) use it.
 */
function candidates({ kind, name }) {
  if (kind === 'townHall') {
    return [`Town Hall${name}.png`, `Town Hall ${name} info.png`, `Town Hall${name}-1.png`]
  }
  const bare = [`${name}.png`, `${name}.PNG`]
  const info = [`${name} info.png`, `${name} info.PNG`]
  return kind === 'equipment' ? [...bare, ...info] : [...info, ...bare]
}

const cocApi = async (path) => {
  const res = await fetch(`${COC_API}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  // A 403 here is almost always a key bound to a stale IP, not a bad path.
  if (res.status === 403) throw new Error(`${path} -> 403; mint a key for your current IP`)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

/**
 * The set of names to look for. Mostly taken from the API itself rather than
 * hardcoded, so art for a new troop arrives without editing this script: sampled
 * from the highest Town Hall members of a few large clans — a maxed profile lists
 * every unit, including the ones the owner has not unlocked.
 *
 * That sampling only ever finds a name if some sampled account happens to have it
 * equipped, which is a real gap for hero equipment (41 items across six heroes —
 * no small sample owns all of them). `KNOWN_ENTRIES` from
 * ./wiki-art-known-names.mjs supplements it with the complete known equipment and
 * pet catalog, so those names are attempted regardless of what any sampled account
 * happens to be wearing. Troops, spells and heroes stay sample-only: that catalog
 * is far more stable and a hardcoded list there would just be another place to
 * forget to update.
 */
async function discoverNames() {
  const { items: clans } = await cocApi('/clans?minMembers=45&minClanLevel=20&limit=8')

  const candidateTags = []
  for (const clan of clans) {
    const full = await cocApi(`/clans/${encodeURIComponent(clan.tag)}`)
    const ranked = [...full.memberList].sort((a, b) => b.townHallLevel - a.townHallLevel)
    for (const member of ranked.slice(0, 2)) {
      candidateTags.push({ tag: member.tag, townHallLevel: member.townHallLevel })
    }
  }
  candidateTags.sort((a, b) => b.townHallLevel - a.townHallLevel)

  const entries = new Map()
  const remember = (kind, item) => {
    const key = `${kind}:${item.name}`
    // First village wins; only used to order the fetch, and the wiki serves one
    // `info` image per unit name regardless of which village it fights in.
    if (!entries.has(key)) entries.set(key, { kind, name: item.name, village: item.village })
  }

  for (const { tag } of candidateTags.slice(0, 6)) {
    const player = await cocApi(`/players/${encodeURIComponent(tag)}`)
    for (const item of player.troops) remember('troop', item)
    for (const item of player.spells) remember('spell', item)
    for (const item of player.heroes) remember('hero', item)
    for (const item of player.heroEquipment ?? []) remember('equipment', item)
  }
  const sampledCount = entries.size
  console.log(`sampled ${Math.min(6, candidateTags.length)} maxed profiles: ${sampledCount} unit names`)

  const merged = mergeKnownNames([...entries.values()], KNOWN_ENTRIES)
  console.log(
    `known-name catalog: ${KNOWN_ENTRIES.length} hero equipment/pet names checked, ` +
      `${merged.length - sampledCount} not already found by sampling`,
  )

  for (let level = TOWN_HALL_MIN; level <= TOWN_HALL_MAX; level++) {
    merged.push({ kind: 'townHall', name: String(level), village: 'home' })
  }
  return merged
}

/* ---------- resolving names to wiki files ---------- */

const wikiQuery = async (params) => {
  const url = `${WIKI_API}?${new URLSearchParams({ action: 'query', format: 'json', ...params })}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`wiki query -> HTTP ${res.status}`)
  return res.json()
}

/**
 * One `imageinfo` lookup per 50 candidate titles — MediaWiki's per-request title
 * cap — asking for the thumbnail we want in the same round trip. Returns only the
 * titles that exist, so the caller can pick its first surviving candidate.
 */
async function resolveTitles(titles, size) {
  const found = new Map()
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50)
    const data = await wikiQuery({
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      iiurlwidth: String(size),
      iiurlheight: String(size),
      titles: batch.join('|'),
    })
    for (const page of Object.values(data.query?.pages ?? {})) {
      const info = page.imageinfo?.[0]
      if (info?.thumburl) found.set(page.title, info)
    }
    await sleep(DELAY_MS)
  }
  return found
}

/* ---------- naming ---------- */

/**
 * Must stay in step with `normalizeArtName` in web/src/wiki-art.ts — that is the
 * lookup side of this same key, and it is unit tested there.
 */
const normalize = (name) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** Readable on disk, and stable: `P.E.K.K.A` -> `p-e-k-k-a`, not `pekka`. */
const slug = (name) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/* ---------- run ---------- */

const demand = (await discoverNames()).sort(
  (a, b) => orderOf(a) - orderOf(b) || a.name.localeCompare(b.name),
)

// One batched existence pass over every candidate for every name, so the whole
// resolution costs ~a dozen requests rather than one per name. Town Halls want a
// slightly larger thumbnail, so they resolve in their own pass.
const unitTitles = new Set()
const townHallTitles = new Set()
for (const entry of demand) {
  const bucket = entry.kind === 'townHall' ? townHallTitles : unitTitles
  for (const title of candidates(entry)) bucket.add(`File:${title}`)
}
console.log(
  `checking ${unitTitles.size + townHallTitles.size} candidate file titles for ${demand.length} names…`,
)

const resolved = new Map([
  ...(await resolveTitles([...unitTitles], THUMB.unit)),
  ...(await resolveTitles([...townHallTitles], THUMB.townHall)),
])

/** Anything already vendored, kept so a re-run neither re-downloads nor forgets. */
const previous = await readFile(MANIFEST, 'utf8').then(JSON.parse, () => ({ files: {} }))

const manifest = { source: WIKI_SITE, fetchedAt: new Date().toISOString(), files: {} }
const misses = []
let bytes = 0
let downloaded = 0
let cached = 0
let skippedForBudget = 0

for (const entry of demand) {
  const hit = candidates(entry)
    .map((title) => `File:${title}`)
    .find((title) => resolved.has(title))
  if (!hit) {
    misses.push(entry)
    continue
  }

  const info = resolved.get(hit)
  const { dir } = KINDS[entry.kind]
  const base = slug(entry.kind === 'townHall' ? `th-${entry.name}` : entry.name)

  // The extension is not known until the response arrives, so the cache probe
  // has to consider every format this script can write. Skipped under REFETCH,
  // so a re-run at a larger THUMB overwrites the smaller art instead of keeping it.
  let file
  let size = null
  if (!IGNORE_CACHE) {
    for (const ext of CANDIDATE_EXTENSIONS) {
      const found = await stat(join(OUT, dir, `${base}.${ext}`)).then((s) => s.size, () => null)
      if (found !== null) {
        file = `${base}.${ext}`
        size = found
        break
      }
    }
  }

  if (size === null) {
    if (bytes >= BUDGET_BYTES) {
      skippedForBudget++
      continue
    }
    await mkdir(join(OUT, dir), { recursive: true })
    const res = await fetch(info.thumburl, { headers: { 'User-Agent': UA } })
    if (!res.ok) {
      misses.push({ ...entry, why: `thumbnail HTTP ${res.status}` })
      continue
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    const ext = EXTENSIONS[contentType]
    if (!ext) {
      misses.push({ ...entry, why: `unexpected content-type ${contentType || 'none'}` })
      continue
    }
    file = `${base}.${ext}`
    const body = Buffer.from(await res.arrayBuffer())
    await writeFile(join(OUT, dir, file), body)
    bytes += body.byteLength
    downloaded++
    await sleep(DELAY_MS)
  } else {
    bytes += size
    cached++
  }

  manifest.files[`${entry.kind}:${normalize(entry.name)}`] = {
    apiName: entry.name,
    kind: entry.kind,
    src: `/coc/wiki/${dir}/${file}`,
    // Provenance, so attribution is traceable rather than folklore.
    wikiFile: hit,
    wikiPage: `${WIKI_SITE}/wiki/${hit.replace(/ /g, '_')}`,
    thumb: `${info.thumbwidth}x${info.thumbheight}`,
  }
}

// A name vendored by an earlier run whose file is still on disk stays mapped, so
// a run against a profile that happens not to list some unit never loses its art.
for (const [key, record] of Object.entries(previous.files ?? {})) {
  if (manifest.files[key]) continue
  const onDisk = await stat(join(REPO, 'web/public', record.src)).then(() => true, () => false)
  if (onDisk) manifest.files[key] = record
}

await mkdir(OUT, { recursive: true })
await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

const keys = Object.keys(manifest.files).sort()
await writeFile(
  GENERATED,
  `/*
 * Generated by scripts/fetch-wiki-art.mjs — do not edit by hand.
 *
 * Which unit artwork is vendored under web/public/coc/wiki, keyed
 * \`<kind>:<normalized name>\`.
 *
 * The art itself is gitignored, so a checkout that has not run
 * \`npm run assets:wiki\` has these keys but no files. There is no remote fallback
 * on purpose — we do not hotlink the wiki — so \`web/src/wiki-art.ts\` returns a
 * path and the icon quietly renders nothing when the file is absent.
 *
 * A name missing from this map is a name the wiki had no art for. It stays
 * unmapped rather than borrowing a near neighbor's icon.
 *
 * \`WIKI_ART_SOURCES\` records which wiki file each image came from. It lives here,
 * in a tracked file, rather than only in web/public/coc/wiki/manifest.json —
 * that manifest is inside the gitignored art directory, so attribution would not
 * survive a fresh clone. This art is Supercell's, used under their Fan Content
 * Policy, so the provenance has to travel with the repo.
 */

export const WIKI_ART: Readonly<Record<string, string>> = {
${keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(manifest.files[key].src)},`).join('\n')}
}

/** Attribution: lookup key -> the API name and the wiki file it was taken from. */
export const WIKI_ART_SOURCES: Readonly<
  Record<string, { readonly apiName: string; readonly wikiFile: string }>
> = {
${keys
  .map((key) => {
    const { apiName, wikiFile } = manifest.files[key]
    return `  ${JSON.stringify(key)}: { apiName: ${JSON.stringify(apiName)}, wikiFile: ${JSON.stringify(wikiFile)} },`
  })
  .join('\n')}
}

/** Where the art came from, for the attribution note in the UI footer. */
export const WIKI_ART_SOURCE_SITE = ${JSON.stringify(WIKI_SITE)}
`,
)

/* ---------- coverage report ---------- */

const byKind = {}
for (const entry of demand) {
  const bucket = (byKind[entry.kind] ??= { want: 0, got: 0, missed: [] })
  bucket.want++
  if (manifest.files[`${entry.kind}:${normalize(entry.name)}`]) bucket.got++
  else bucket.missed.push(entry.name)
}

console.log('\n--- coverage ---')
for (const [kind, bucket] of Object.entries(byKind)) {
  const pct = ((bucket.got / bucket.want) * 100).toFixed(0)
  console.log(`${kind.padEnd(10)} ${String(bucket.got).padStart(3)}/${bucket.want}  (${pct}%)`)
  if (bucket.missed.length > 0) console.log(`  unresolved: ${bucket.missed.join(', ')}`)
}

const want = demand.length
const got = demand.filter((e) => manifest.files[`${e.kind}:${normalize(e.name)}`]).length
console.log(`\ntotal      ${got}/${want} names resolved to art`)
console.log(`files      ${Object.keys(manifest.files).length} mapped (${downloaded} downloaded, ${cached} already on disk)`)
console.log(`bytes      ${(bytes / 1024).toFixed(0)} KiB of a ${(BUDGET_BYTES / 1024 / 1024).toFixed(0)} MiB budget`)
if (skippedForBudget > 0) {
  console.log(`BUDGET HIT: ${skippedForBudget} lowest-priority names skipped. Raise BUDGET_BYTES or accept the gap.`)
}
if (misses.length > 0) {
  console.log(`\n${misses.length} unresolved: ${misses.map((m) => `${m.kind}/${m.name}${m.why ? ` (${m.why})` : ''}`).join(', ')}`)
}
console.log('\nregenerated web/src/wiki-art.generated.ts')
