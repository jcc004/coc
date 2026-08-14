import { CARD_ID_MAX, CARD_ID_MIN } from '@coc/shared'

/**
 * How each of the sixty tiles frames its picture.
 *
 * **Whole is the default, and today it is the framing for all sixty.** The art in
 * `web/public/coc/cards/` is a purpose-made set — sixty PNGs, 256×320 portrait —
 * already cropped tight on its own subject, so the picture *is* the framing the
 * event uses: nothing trimmed, nothing letterboxed. `.card-tile__frame` is 4:5 to
 * match.
 *
 * {@link FACE_CROPS} below is empty today, not deleted — individual per-card
 * correction for a file whose own subject sits smaller in its canvas than the
 * rest of the set. The mechanism reads identically whether the table holds
 * entries or not, which is exactly why it was worth keeping unused rather than
 * removed: an earlier art set was whole figures standing on a patch of grass,
 * needing a window cut out of every tile, and if the set is ever regenerated
 * wholesale again — or a future file's own subject sits smaller than the rest —
 * this same table is where that goes.
 *
 * ## Cropping again, if the art changes
 *
 * A face crop is a window on the existing image, expressed in per-cent and applied
 * in CSS. **No second set of files is generated**: cropping in CSS means nothing to
 * re-fetch, nothing to keep in step with `cards.generated.ts`, no build step, and
 * the untouched originals stay the source for every other view (the trade table's
 * thumbnails still show the whole troop).
 *
 * `.card-tile__frame` has `overflow: hidden`. The image inside it is scaled by
 * `--card-zoom` and then slid so that one nominated point of the *image* lands at
 * the *center of the frame*:
 *
 * - **`zoom`** — the image's height as a multiple of the frame's height. The frame
 *   therefore shows `1 / zoom` of the picture's height: `2` is the top-or-middle
 *   half, `2.3` is about 43%, `1` is the whole thing. Bigger zoom = tighter crop.
 * - **`y`** — the height of the image, in per-cent of its own height, that sits at
 *   the frame's vertical center. For a face crop this is the middle of the head.
 * - **`x`** — the same horizontally. `50` is the middle of the picture.
 *
 * To crop one card, add an entry to {@link FACE_CROPS} and nudge a number:
 *
 * - the head is cut off at the top → **lower** `y`;
 * - too much background showing → **raise** `zoom`;
 * - the crop is too tight, or the picture is wide and the window has gone narrow →
 *   **lower** `zoom`;
 * - the face sits off to one side → move `x` towards it.
 *
 * Then look at the tile. `y` and `zoom` interact: the window is `1/zoom` tall and
 * centered on `y`, so `y` must be at least `50/zoom` or the window runs off the top
 * of the picture and the tile shows empty frame. {@link faceCrop} clamps it, and
 * `card-crops.test.ts` pins that clamp directly, independent of whatever the table
 * currently holds.
 *
 * ## Quality ceiling
 *
 * A crop costs resolution, which is the other reason not to apply one to art that
 * does not need it. The window is `0.8 × imageHeight / zoom` wide and
 * `imageHeight / zoom` tall in real pixels; a 320px-tall source at zoom 2.3 is
 * about 111×139, rendered at roughly 107×134 CSS px, so it is already at 1:1 and
 * soft at 2x. Framed whole, the same file is 256×320 into a ~107×134 box — a
 * downscale, which is the sharpest a tile can be.
 */

/** A face crop: a window on the picture, in per-cent of the picture's own size. */
export interface CardFaceCrop {
  kind: 'face'
  /** Per-cent of the image's width held at the frame's horizontal center. */
  x: number
  /** Per-cent of its height held at the frame's vertical center. */
  y: number
  /** Image height as a multiple of the frame's height. See the note above. */
  zoom: number
}

/** The whole picture, filling the portrait frame. The default. */
export interface CardWholeFraming {
  kind: 'whole'
}

export type CardFraming = CardFaceCrop | CardWholeFraming

/**
 * What a card gets when nothing says otherwise: the picture as it is.
 *
 * Shared rather than rebuilt per call, so `cardFraming(a) === cardFraming(b)` for
 * any two uncropped cards and a memo on it cannot be defeated by identity.
 */
export const WHOLE_FRAMING: CardWholeFraming = { kind: 'whole' }

/**
 * Per-card face crops, keyed by the id in `cards.generated.ts`. **Empty today —
 * all sixty tiles show the whole picture.** Kept as live, working machinery
 * rather than deleted: this is the second time it has emptied out (see the module
 * doc comment above on the earlier wiki-art set), and both times the reason was
 * the same — the underlying art improved out from under a correction that had
 * been tuned to its old flaws.
 *
 * **History, for whoever next reaches for this table.** Five cards were cropped
 * here at various points — Golem (23), Lava Hound (25), Ice Golem (27), Cannon
 * Cart (39), Ice Hound (59) — each because its subject sat smaller in its 256×320
 * canvas than the rest of the set, with a visible background margin that read as
 * modest corner shading at full resolution and a clear gap at an actual tile's
 * ~30–90px. All five are gone as of 2026-08-14, removed together after a direct
 * side-by-side review — a generated contact sheet of all sixty raw files next to
 * a screenshot of the live grid — judged the crop not worth its cost across the
 * board. Cannon Cart was the clearest case: its crop filled the entire tile with
 * just the barrel disc, discarding the cart itself, to clear a background sliver
 * nobody had actually flagged as a problem in the raw art. Golem and Ice Hound
 * had been through one earlier over-correction already (reported back directly as
 * "zoomed in too much" — Ice Hound had lost its ice crystal to a crop that closed
 * the background gap by far more than the gap itself needed) and a subsequent
 * pass had already found each card's smallest zoom that actually cleared its
 * background before this final round removed them anyway.
 *
 * If a future regeneration of the art reopens a visible background gap on any
 * card, the fix is this same mechanism, not a new one — see the module doc
 * comment above, "Cropping again, if the art changes," for how to add an entry
 * back and what to measure before trusting it. `card-crops.test.ts` checks that
 * anything added here names a real card and stays inside its own picture, so an
 * entry cannot be filled in wrongly and go unnoticed.
 */
const FACE_CROPS: Readonly<Record<number, Omit<CardFaceCrop, 'kind'>>> = {}

/** Keeps a window inside the picture, so a tile can never show empty frame. */
function clampCenter(value: number, zoom: number): number {
  const half = 50 / zoom
  return Math.min(Math.max(value, half), 100 - half)
}

/**
 * A face crop with its window clamped inside the picture.
 *
 * Exported because it is the whole of the face path's arithmetic — so this is
 * where `card-crops.test.ts` proves the clamp itself is correct, independent of
 * whichever cards `FACE_CROPS` currently names.
 */
export function faceCrop(x: number, y: number, zoom: number): CardFaceCrop {
  return { kind: 'face', zoom, x: clampCenter(x, zoom), y: clampCenter(y, zoom) }
}

/**
 * How to frame card `id`. Unknown ids get the default rather than throwing: a tile
 * that is framed a little oddly beats a grid that will not render.
 */
export function cardFraming(id: number): CardFraming {
  const crop = FACE_CROPS[id]
  if (crop === undefined) return WHOLE_FRAMING
  return faceCrop(crop.x, crop.y, crop.zoom)
}

/** The ids cropped to a face, for the tests and for anyone auditing the table. */
export function faceCroppedCardIds(): number[] {
  return Object.keys(FACE_CROPS)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id >= CARD_ID_MIN && id <= CARD_ID_MAX)
    .sort((a, b) => a - b)
}
