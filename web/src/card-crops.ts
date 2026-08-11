import { CARD_ID_MAX, CARD_ID_MIN } from '@coc/shared'

/**
 * How each of the sixty tiles frames its picture.
 *
 * **Whole is the default, and it is still the framing for fifty-six of sixty.**
 * The art in `web/public/coc/cards/` is a purpose-made set — sixty PNGs, 256×320
 * portrait — and most of them are already cropped tight on their own subject, so
 * the picture *is* the framing the event uses: nothing trimmed, nothing
 * letterboxed. `.card-tile__frame` is 4:5 to match.
 *
 * Four cards are the exception, in {@link FACE_CROPS} below — not a regenerated
 * art set, but individual per-card correction, where that one file's own subject
 * sits smaller in its canvas than the rest of the set and needs the same window
 * mechanism cropped in. The mechanism reads identically either way, which is
 * exactly why it was worth keeping unused rather than deleting: an earlier art set
 * was whole figures standing on a patch of grass, needing a window cut out of
 * every tile, and if the set is ever regenerated wholesale again this same table
 * is where that goes too.
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
 * Per-card face crops, keyed by the id in `cards.generated.ts`. **The exception,
 * not the rule.**
 *
 * The set is framed tight on its subject card by card, not uniformly: most of the
 * sixty already fill their own 256×320 canvas edge to edge, but four compose their
 * subject smaller, with a visible background margin around it. That margin is easy
 * to miss reading the file at full size — it reads as modest corner shading — and
 * unmissable once the same file renders at an actual tile's ~30–90px, where the
 * margin becomes a clear gap between the character and the tile's own border. These
 * four are that correction, found by rendering all sixty at real tile size rather
 * than by eyeballing the source art:
 *
 * - **Golem (23)** — the rock plates are stacked with glowing seams between them;
 *   the top seam is the golem's "eyes" and sits well clear of the frame, but the
 *   *second* seam, lower down, reaches the image's own left and right edges, and
 *   the canvas background shows beneath it at the bottom corners. The fix crops to
 *   the top plate and the eye-seam only, above the second seam.
 * - **Lava Hound (25)** — a flat orange-brown background band across the bottom of
 *   the frame, cropped out by centering higher and tighter.
 * - **Cannon Cart (39)** — the barrel is shot on a diagonal with a bright sky
 *   gradient filling whatever the barrel doesn't cover, worst at the top and one
 *   corner. This one has the least headroom of the four: closing the gap costs
 *   more zoom than the other three before the sky clears every corner.
 * - **Ice Hound (59)** — a solid orange-gold background band down the right side of
 *   the frame. The dark navy area beside the head is *not* this — it is the
 *   creature's own shadowed body, confirmed by sampling its color against the
 *   image's actual corner pixels before treating it as background to crop away.
 *
 * `card-crops.test.ts` checks that everything in this table names a real card and
 * stays inside its own picture, so an entry cannot be filled in wrongly and go
 * unnoticed. Kept as a table rather than four one-off constants because the next
 * card found this way is another row here, not a new mechanism.
 */
const FACE_CROPS: Readonly<Record<number, Omit<CardFaceCrop, 'kind'>>> = {
  23: { x: 50, y: 30, zoom: 1.67 },
  25: { x: 48, y: 47, zoom: 1.35 },
  39: { x: 40, y: 58, zoom: 1.9 },
  59: { x: 42, y: 48, zoom: 1.55 },
}

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
