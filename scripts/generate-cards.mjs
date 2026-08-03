/**
 * Reads web/public/coc/cards/manifest.json and regenerates the committed
 * web/src/cards.generated.ts — id, category, name and image path for all 60
 * event cards.
 *
 * Why this exists at all: `web/public/coc/` is gitignored (the art is
 * Supercell's), and the manifest lives *inside* that directory. So a fresh clone
 * has neither the images nor the list. Generating a tracked TypeScript module
 * means the app always knows which sixty cards exist and what they are called,
 * and only the pictures are missing — a card with no image still renders by
 * name, which is the whole degradation story. Same shape as
 * `scripts/fetch-wiki-art.mjs`, which does this for unit art.
 *
 * Each card ships one picture: `color`. A card the base holds renders it as-is;
 * a card it lacks renders the same image under a CSS `grayscale(1)` filter
 * (`.card-tile--locked` in styles.css). The art is now sourced from the vendored
 * wiki unit thumbnails rather than the greyscale event screenshots, so a real
 * greyscale render is no longer available anyway — desaturating the colour one is
 * exactly equivalent, and halves the files the grid has to ship and load.
 *
 * The manifest also carries `confidence`, `collected` and `art_source`. Those
 * are the author's notes about sourcing each *image*, not inventory:
 * `collected` means "did we manage to source a colour version of this picture",
 * nothing to do with who holds which card. They are deliberately not carried
 * across — inventory lives in `card_inventory`, entered by hand, per base.
 *
 * Usage: npm run cards:generate
 */
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(REPO, 'web/public/coc/cards/manifest.json')
const PUBLIC_DIR = join(REPO, 'web/public')
const GENERATED = join(REPO, 'web/src/cards.generated.ts')

/** Must match `CardCategory` in shared/src/card-types.ts. */
const CATEGORIES = ['Elixir', 'Dark Elixir', 'Builder Base', 'Super Troop']

const raw = await readFile(MANIFEST, 'utf8').catch(() => null)
if (raw === null) {
  console.error(`✗ No manifest at ${MANIFEST}.`)
  console.error('  web/public/coc/ is gitignored, so this only runs where the card art is.')
  console.error('  web/src/cards.generated.ts is committed and has been left untouched.')
  process.exit(1)
}

const manifest = JSON.parse(raw)
if (!Array.isArray(manifest)) {
  console.error('✗ The manifest must be an array of cards.')
  process.exit(1)
}

/*
 * Validated rather than trusted, because this writes a file that is then
 * committed: a duplicate id or an unknown category would otherwise be discovered
 * as a wrong picture in the UI weeks later. A structural problem aborts and
 * leaves the existing generated module alone.
 */
const problems = []
const cards = []
const seen = new Set()

/** Manifest paths are relative to web/public; the app wants them absolute. */
const webPath = (value) => `/${String(value).replace(/^\/+/, '')}`

for (const [index, entry] of manifest.entries()) {
  const where = `entry ${index}`
  const { id, category, name, color } = entry ?? {}
  // `file` was the single-image key an earlier manifest used. Accepted as an
  // alias for the colour art so this script works against either shape.
  const colour = color ?? entry?.file

  if (!Number.isInteger(id) || id < 1) problems.push(`${where}: id ${JSON.stringify(id)}`)
  else if (seen.has(id)) problems.push(`${where}: duplicate id ${id}`)
  else seen.add(id)

  if (!CATEGORIES.includes(category)) problems.push(`${where}: category ${JSON.stringify(category)}`)
  if (typeof name !== 'string' || !name.trim()) problems.push(`${where}: name ${JSON.stringify(name)}`)
  if (typeof colour !== 'string' || !colour.trim()) problems.push(`${where}: color ${JSON.stringify(colour)}`)

  cards.push({
    id,
    category,
    name: String(name).trim(),
    image: webPath(colour),
  })
}

cards.sort((a, b) => a.id - b.id)

// Contiguity is what lets the UI and the schema's CHECK treat ids as a range.
for (const [index, card] of cards.entries()) {
  if (card.id !== index + 1) {
    problems.push(`ids are not contiguous from 1: expected ${index + 1}, found ${card.id}`)
    break
  }
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} problem(s) in the manifest; nothing was written:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

/* A missing image is reported but is not fatal: the module records the path, and
   `GameIcon` drops the element on error so the card still reads by name. */
const missing = []
for (const card of cards) {
  await access(join(PUBLIC_DIR, card.image.slice(1))).catch(() => missing.push(card.image))
}

const byCategory = new Map(CATEGORIES.map((category) => [category, 0]))
for (const card of cards) byCategory.set(card.category, byCategory.get(card.category) + 1)

await writeFile(
  GENERATED,
  `/*
 * Generated by scripts/generate-cards.mjs — do not edit by hand.
 * Run \`npm run cards:generate\` after changing web/public/coc/cards/manifest.json.
 *
 * The sixty cards of the collecting event: id, category, name, and the path to
 * the one vendored picture of each. A held card shows it in colour; a card the
 * base lacks shows the same image under a CSS greyscale filter, so there is a
 * single file per card rather than a colour/greyscale pair.
 *
 * This module is **tracked**, unlike the art it points at. web/public/coc/ is
 * gitignored, so a fresh clone — and any host that has not been given the images
 * — has this list but none of the pictures. That is the supported state: the
 * grid still renders sixty named cards, and \`GameIcon\` removes an image that
 * fails to load rather than showing a broken-image glyph or collapsing the cell.
 *
 * The card art is a purpose-made 256x320 portrait set, each file already framed
 * on its own subject — **not** derived from the wiki thumbnails
 * \`fetch-wiki-art.mjs\` vendors, which is why the tiles are framed whole rather
 * than cropped. No script regenerates it: it exists only where it was assembled,
 * so a host is given the files by hand. Per-card provenance is
 * \`scripts/card-art-sources.csv\`, and the manifest's \`art_source\` records it.
 * It is Supercell's, used under their Fan Content Policy.
 *
 * The manifest's \`collected\` and \`confidence\` fields are **not** carried
 * across. They are notes about how each image was sourced, not inventory;
 * inventory is per base, entered by hand, and lives in \`card_inventory\`.
 */
import type { CardCategory } from '@coc/shared'

export interface GeneratedCard {
  /** 1…${cards.length}, contiguous. Also the primary key component in \`card_inventory\`. */
  readonly id: number
  readonly category: CardCategory
  readonly name: string
  /**
   * The card's art. Shown in colour when the base holds at least one, and under a
   * CSS greyscale filter when it holds none. May not exist on disk.
   */
  readonly image: string
}

export const CARDS: readonly GeneratedCard[] = [
${cards
  .map(
    (card) =>
      `  { id: ${card.id}, category: ${JSON.stringify(card.category)}, name: ${JSON.stringify(card.name)}, image: ${JSON.stringify(card.image)} },`,
  )
  .join('\n')}
]
`,
)

console.log(`→ wrote ${GENERATED}`)
console.log(`  ${cards.length} cards: ${[...byCategory].map(([c, n]) => `${c} ${n}`).join(', ')}`)
if (missing.length > 0) {
  console.log(`  ${missing.length} image(s) not on disk — the cards still render by name:`)
  for (const image of missing) console.log(`    ${image}`)
}
