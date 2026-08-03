import { CARD_ID_MAX, CARD_ID_MIN } from '@coc/shared'

/**
 * How each of the sixty tiles frames its picture.
 *
 * **Whole is the default, and today it is the only case.** The art in
 * `web/public/coc/cards/` is a purpose-made set — sixty PNGs, 256×320 portrait,
 * each already cropped tight on its own subject — so the picture *is* the framing
 * the event uses. Zooming into it would enlarge a face that already fills the
 * frame. `.card-tile__frame` is 4:5 to match, so a whole-framed tile shows the
 * file exactly: nothing trimmed, nothing letterboxed.
 *
 * The face-crop machinery below is kept deliberately, because the art may be
 * regenerated: an earlier set was whole figures standing on a patch of grass,
 * 256px on the long side, and every tile needed a window cut out of it in CSS. If
 * that happens again, re-cropping is a table of numbers here rather than a rewrite
 * — {@link FACE_CROPS} is empty, not deleted.
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
 * the *centre of the frame*:
 *
 * - **`zoom`** — the image's height as a multiple of the frame's height. The frame
 *   therefore shows `1 / zoom` of the picture's height: `2` is the top-or-middle
 *   half, `2.3` is about 43%, `1` is the whole thing. Bigger zoom = tighter crop.
 * - **`y`** — the height of the image, in per-cent of its own height, that sits at
 *   the frame's vertical centre. For a face crop this is the middle of the head.
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
 * centred on `y`, so `y` must be at least `50/zoom` or the window runs off the top
 * of the picture and the tile shows empty frame. {@link faceCrop} clamps it, and
 * `card-crops.test.ts` pins that clamp — which is how the path stays tested while
 * the table is empty.
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
  /** Per-cent of the image's width held at the frame's horizontal centre. */
  x: number
  /** Per-cent of its height held at the frame's vertical centre. */
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
 * Per-card face crops, keyed by the id in `cards.generated.ts`. **The exception,
 * not the rule.**
 *
 * Empty, and correctly so: the current art is already framed on its subject, and a
 * card listed here would be zoomed into a face that already fills its picture. It
 * is the hook for a future set that is not framed — see the note above for how to
 * fill it in — and `card-crops.test.ts` checks that everything in it names a real
 * card and stays inside its own picture, so it cannot be filled in wrongly and go
 * unnoticed.
 */
const FACE_CROPS: Readonly<Record<number, Omit<CardFaceCrop, 'kind'>>> = {}

/** Keeps a window inside the picture, so a tile can never show empty frame. */
function clampCentre(value: number, zoom: number): number {
  const half = 50 / zoom
  return Math.min(Math.max(value, half), 100 - half)
}

/**
 * A face crop with its window clamped inside the picture.
 *
 * Exported because it is the whole of the face path's arithmetic, and the table
 * that would exercise it is empty — so this is where `card-crops.test.ts` proves
 * the machinery still works rather than asserting it vacuously over no entries.
 */
export function faceCrop(x: number, y: number, zoom: number): CardFaceCrop {
  return { kind: 'face', zoom, x: clampCentre(x, zoom), y: clampCentre(y, zoom) }
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
