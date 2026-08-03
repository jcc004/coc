import { CARD_ID_MAX, CARD_ID_MIN } from '@coc/shared'

/**
 * How each of the sixty tiles frames its picture.
 *
 * The event crops every card tightly on the character's head, portrait, so the
 * face fills the frame. The vendored art is the opposite: a whole figure standing
 * on a patch of grass, 256px on the long side. This module is the difference
 * between the two — a window on the existing image, expressed in per-cent, applied
 * in CSS. **No second set of files is generated**: cropping in CSS means nothing to
 * re-fetch, nothing to keep in step with `cards.generated.ts`, and no build step,
 * and the untouched originals stay the source for every other view (the trade
 * table's thumbnails still show the whole troop).
 *
 * ## The three numbers
 *
 * `.card-tile__frame` is a portrait box with `overflow: hidden`. The image inside
 * it is scaled by `--card-zoom` and then slid so that one nominated point of the
 * *image* lands at the *centre of the frame*:
 *
 * - **`zoom`** — the image's height as a multiple of the frame's height. The frame
 *   therefore shows `1 / zoom` of the picture's height: `2` is the top-or-middle
 *   half, `2.3` is about 43%, `1` is the whole thing. Bigger zoom = tighter crop.
 * - **`y`** — the height of the image, in per-cent of its own height, that sits at
 *   the frame's vertical centre. For a face crop this is the middle of the head.
 * - **`x`** — the same horizontally. `50` is the middle of the picture; most of
 *   this art has the figure a little right of centre, hence the default of `52`.
 *
 * ## Adjusting one card
 *
 * Find its id in `OVERRIDES` (add an entry if it has none) and nudge a number:
 *
 * - the head is cut off at the top → **lower** `y`;
 * - too much grass / body showing → **raise** `zoom`;
 * - the crop is too tight, or the picture is wide and the window has gone narrow →
 *   **lower** `zoom`;
 * - the face sits off to one side → move `x` towards it.
 *
 * Then look at the tile. `y` and `zoom` interact: the window is `1/zoom` tall and
 * centred on `y`, so `y` must be at least `50/zoom` or the window runs off the top
 * of the picture and the tile shows empty frame — {@link cardFraming} clamps it,
 * and `card-crops.test.ts` checks every entry is in range without needing the
 * clamp.
 *
 * ## Quality ceiling
 *
 * The window is `0.75 × imageHeight / zoom` wide and `imageHeight / zoom` tall in
 * real pixels — for a 256px source at the default zoom, about 83×111. The tile
 * renders it at roughly 107×143 CSS px, so it is a slight upscale at 1x and about
 * 2.6x at 2x: soft, but these are smooth 3D renders and they enlarge gracefully.
 * Re-fetching at 512px would fix it and is deliberately not done — it takes the
 * vendored art from 3.2MB to roughly 12MB, past the fetch script's own budget.
 */

/** A face crop: a window on the picture, in per-cent of the picture's own size. */
export interface CardFaceCrop {
  kind: 'face'
  /** Per-cent of the image's width held at the frame's horizontal centre. */
  x: number
  /** Per-cent of its height held at the frame's vertical centre. */
  y: number
  /** Image height as a multiple of the frame's height. See the note above. */
  zoom: number
}

/** No head to crop to: the whole picture, letterboxed into the portrait frame. */
export interface CardWholeFraming {
  kind: 'whole'
}

export type CardFraming = CardFaceCrop | CardWholeFraming

/**
 * The starting point: a figure standing upright with its head near the top.
 *
 * It is the safety net rather than the common case — the table below has been tuned
 * for all sixty cards that exist — so what it really covers is a card added to the
 * manifest and not yet looked at. Such a card gets a plausible head crop instead of
 * a blank frame, and `card-crops.test.ts` fails until somebody has framed it.
 */
export const DEFAULT_CROP: CardFaceCrop = { kind: 'face', x: 52, y: 22, zoom: 2.3 }

const WHOLE: CardWholeFraming = { kind: 'whole' }

type Override = Partial<Omit<CardFaceCrop, 'kind'>> | 'whole'

/**
 * Per-card corrections, keyed by the id in `cards.generated.ts`.
 *
 * A single crop cannot suit sixty pictures. The default lands well on the upright
 * humanoids — Barbarian, Archer, Wizard, the Super troops — and lands nowhere on
 * a flying dragon whose head is at two-thirds height, a mounted Hog Rider whose
 * rider sits left of centre, or a Balloon that has no face at all. Every entry
 * below was set by rendering all sixty and looking at them; a card with no entry
 * is one the default already framed.
 *
 * `'whole'` is the deliberate opt-out, used for the five cards whose subject is a
 * vehicle or a building rather than a creature. Zooming a Cannon Cart onto its
 * "head" would show a plank; the silhouette *is* the identity, so those keep the
 * old whole-figure framing in the new portrait frame.
 */
const OVERRIDES: Readonly<Record<number, Override>> = {
  /* ---------- Elixir ---------- */
  1: { x: 60, y: 16 }, // Barbarian — mid-stride, head high and right of centre
  2: { x: 56, y: 13 },
  3: { x: 46, y: 13 }, // Giant — a big head that fills the top of the frame
  4: { x: 70, y: 19, zoom: 1.8 }, // Goblin — landscape art, so a gentler zoom
  5: { x: 50, y: 20 }, // Wall Breaker — the skull, not the bomb beside it
  6: 'whole', // Balloon — the balloon is the card; its pilot is a speck below it
  7: { x: 57, y: 14 },
  8: { x: 53, y: 33 }, // Healer — hovers low inside her halo
  9: { x: 68, y: 55, zoom: 2 }, // Dragon — head forward and down, past the wings
  10: { x: 60, y: 15 }, // P.E.K.K.A — helmet horns need the extra headroom
  11: { x: 58, y: 22, zoom: 2 }, // Baby Dragon — the head is most of the animal
  12: { x: 55, y: 42, zoom: 1.8 }, // Miner — waist-deep in his own tunnel
  13: { x: 62, y: 60, zoom: 2 }, // Electro Dragon — head low, under the wings
  14: { x: 52, y: 33, zoom: 2 }, // Yeti — face below the pack on his shoulders
  15: { x: 42, y: 25, zoom: 1.6 }, // Dragon Rider — the rider, left of the machine
  16: { x: 52, y: 19 },
  17: { x: 36, y: 12 }, // Root Rider — small rider, top left of the root
  18: { x: 47, y: 30 }, // Thrower — head behind the log on his shoulder
  19: { x: 55, y: 34, zoom: 2 }, // Meteor Golem — the glowing face, not the debris

  /* ---------- Dark Elixir ---------- */
  20: { x: 57, y: 55, zoom: 1.8 }, // Minion — dives head-down
  21: { x: 42, y: 27 }, // Hog Rider — mounted: the rider, not the hog
  22: { x: 62, y: 17 },
  23: { x: 55, y: 48, zoom: 1.7 }, // Golem — eyes deep in a wide pile of rock
  24: { x: 47, y: 22 },
  25: { x: 64, y: 45, zoom: 1.8 }, // Lava Hound — the head is one lobe of the mass
  26: { x: 62, y: 14, zoom: 1.9 }, // Bowler — leans right, boulder on the left
  27: { x: 52, y: 30, zoom: 1.5 }, // Ice Golem — short, wide art
  28: { x: 40, y: 15 }, // Headhunter — hooded head, thrown forward and left
  29: { x: 48, y: 21 }, // Apprentice Warden — under the brim of the hat
  30: { x: 62, y: 23 }, // Druid — head right, staff filling the left
  31: 'whole', // Furnace — a building; the whole thing is the card
  32: { x: 76, y: 30, zoom: 1.8 }, // Ruin Witch — witch on the right, skeletons left

  /* ---------- Builder Base ---------- */
  33: { x: 60, y: 17 },
  34: { x: 55, y: 19 },
  35: { x: 50, y: 16 }, // Boxer Giant — square art, head dead centre at the top
  36: { x: 63, y: 42, zoom: 1.5 }, // Beta Minion — wide art, head to the right
  37: { x: 48, y: 23 }, // Bomber — skeleton head among the thrown bombs
  38: { x: 58, y: 22, zoom: 2 }, // Baby Dragon (Builder) — same picture as 11
  39: 'whole', // Cannon Cart — a cart with a gun on it
  40: { x: 55, y: 21 },
  41: 'whole', // Drop Ship — balloon and basket; nothing to call a face
  42: { x: 52, y: 21 }, // Power P.E.K.K.A — horns again
  43: { x: 52, y: 62, zoom: 1.1 }, // Hog Glider — 256x141; a tight zoom would be 40px wide

  /* ---------- Super Troop ---------- */
  44: { x: 58, y: 26 }, // Super Barbarian — sword arm raised above the head
  45: { x: 50, y: 17 },
  46: { x: 52, y: 15 },
  47: { x: 58, y: 30 }, // Sneaky Goblin — crouched, sack over the shoulder
  48: { x: 52, y: 13 }, // Super Wall Breaker — skull above a barrel
  49: 'whole', // Rocket Balloon — the rockets and the balloon are the card
  50: { x: 52, y: 13 },
  51: { x: 48, y: 60, zoom: 1.05 }, // Super Dragon — 256x131, and the head is low
  52: { x: 70, y: 44, zoom: 1.9 }, // Inferno Dragon — already a close-up
  53: { x: 42, y: 23 }, // Super Miner — head left, drill across the body
  54: { x: 50, y: 48, zoom: 2 }, // Super Yeti — face under the ice crown
  55: { x: 47, y: 48, zoom: 1.8 }, // Super Minion — head above the ammo pack
  56: { x: 62, y: 23 }, // Super Hog Rider — mounted, rider up and right
  57: { x: 40, y: 19, zoom: 1.9 }, // Super Valkyrie — head left, axes swung right
  58: { x: 55, y: 19 },
  59: { x: 55, y: 36, zoom: 2 }, // Ice Hound — head tucked into the body
  60: { x: 52, y: 20, zoom: 2 }, // Super Bowler — the spirit above the bowler
}

/** Keeps a window inside the picture, so a tile can never show empty frame. */
function clampCentre(value: number, zoom: number): number {
  const half = 50 / zoom
  return Math.min(Math.max(value, half), 100 - half)
}

/**
 * How to frame card `id`. Unknown ids get the default rather than throwing: a tile
 * that is framed a little oddly beats a grid that will not render.
 */
export function cardFraming(id: number): CardFraming {
  const override = OVERRIDES[id]
  if (override === 'whole') return WHOLE
  if (override === undefined) return DEFAULT_CROP

  const zoom = override.zoom ?? DEFAULT_CROP.zoom
  return {
    kind: 'face',
    zoom,
    x: clampCentre(override.x ?? DEFAULT_CROP.x, zoom),
    y: clampCentre(override.y ?? DEFAULT_CROP.y, zoom),
  }
}

/** The ids carrying an override, for the tests and for anyone auditing the table. */
export function overriddenCardIds(): number[] {
  return Object.keys(OVERRIDES)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id >= CARD_ID_MIN && id <= CARD_ID_MAX)
    .sort((a, b) => a - b)
}

/** The ids framed whole instead of cropped to a face. */
export function wholeFramedCardIds(): number[] {
  return overriddenCardIds().filter((id) => OVERRIDES[id] === 'whole')
}
