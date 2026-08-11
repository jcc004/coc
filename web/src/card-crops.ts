import { CARD_ID_MAX, CARD_ID_MIN } from '@coc/shared'

/**
 * How each of the sixty tiles frames its picture.
 *
 * **Whole is the default, and it is still the framing for most of the sixty.**
 * The art in `web/public/coc/cards/` is a purpose-made set — sixty PNGs, 256×320
 * portrait — and most of them are already cropped tight on their own subject, so
 * the picture *is* the framing the event uses: nothing trimmed, nothing
 * letterboxed. `.card-tile__frame` is 4:5 to match.
 *
 * A handful of cards are the exception, in {@link FACE_CROPS} below — not a
 * regenerated art set, but individual per-card correction, where that one file's
 * own subject sits smaller in its canvas than the rest of the set and needs the
 * same window mechanism cropped in. The mechanism reads identically either way,
 * which is exactly why it was worth keeping unused rather than deleting: an
 * earlier art set was whole figures standing on a patch of grass, needing a
 * window cut out of every tile, and if the set is ever regenerated wholesale
 * again this same table is where that goes too.
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
 * sixty already fill their own 256×320 canvas edge to edge, but five compose their
 * subject smaller, with a visible background margin around it. That margin is easy
 * to miss reading the file at full size — it reads as modest corner shading — and
 * unmissable once the same file renders at an actual tile's ~30–90px, where the
 * margin becomes a clear gap between the character and the tile's own border. These
 * five are that correction, found by rendering all sixty at real tile size rather
 * than by eyeballing the source art:
 *
 * - **Golem (23)** — the rock plates are stacked with glowing seams between them;
 *   the lower seam reaches the image's own left and right edges, with canvas
 *   background showing beneath it at the bottom corners. A small, centered zoom is
 *   enough to clear it without losing either glowing seam — the "eyes" and the
 *   second row both stay in frame.
 * - **Lava Hound (25)** — a flat orange-brown background band across the bottom of
 *   the frame (and a thinner one at the top), cropped out by a modest zoom shifted
 *   slightly above center.
 * - **Ice Golem (27)** — a purple-blue gradient background shows in both top
 *   corners, worse on the top-right (it reaches roughly the top 15% of the
 *   canvas there, confirmed by sampling pixel color at the corner — a clearly
 *   purple gradient, not the character's own pale-white palette). The rest of the
 *   canvas, including the bottom corners, is the creature's own body edge to edge.
 *   A centered zoom shifted a little below the vertical middle clears both top
 *   corners without pushing the mouth or teeth out of frame.
 * - **Cannon Cart (39)** — the barrel is shot on a diagonal with a bright sky
 *   gradient in two opposite corners: a band across the whole top of the canvas,
 *   and a second wedge creeping in from the bottom-right as the top one recedes.
 *   No single centered window clears both without either cropping tight enough to
 *   lose the barrel's own shape or leaving a sliver of one or the other — the fix
 *   is shifting the window left (`x` well under center) and down (`y` well past
 *   center) at a comparatively gentle zoom, so its right edge stays clear of the
 *   bottom-right wedge without needing the height alone to outrun the top band.
 * - **Ice Hound (59)** — a solid orange-gold background band in the top-right
 *   corner. The dark navy area beside the head is *not* this — it is the
 *   creature's own shadowed body, confirmed by sampling its color against the
 *   image's actual corner pixels before treating it as background to crop away.
 *
 * **Revisited once, after shipping too tight.** The first pass at the original four
 * (measured the same way — rendered at real tile size, not eyeballed at full
 * resolution) over-corrected: reported back directly as "zoomed in too much,"
 * and looking at the shipped result, it was — Ice Hound in particular had lost
 * its ice crystal and most of its head to a crop that closed the background gap
 * by a much wider margin than the gap itself needed. Every value below for those
 * four is the result of a second pass that tried the *smallest* zoom that actually
 * clears the background at each of that card's own corners, checked against several
 * candidate zooms side by side rather than picking the first one that worked —
 * the same lesson the file's own "use the smallest zoom that actually closes the
 * gap" line above already stated but the first pass under-applied.
 *
 * **Ice Golem (27) added in a later pass**, against a fresh batch of 28 real-game
 * reference screenshots. That batch covered cards 1–48 (elixir, dark elixir and
 * builder base in full, i.e. every card up to but not including this table's own
 * two super-troop entries) at their actual in-game framing; Golem and Lava Hound
 * were re-checked directly against it and left unchanged — still correct, tight
 * edge-to-edge with no visible background at real tile size. Cannon Cart was
 * *reported* re-checked and left unchanged in that same pass, and that report was
 * wrong on both counts the very next round found: its `zoom: 1.5` still leaked a
 * sliver of sky at the bottom-right corner even at that aggressive a crop, and it
 * was cropped far tighter than the real game's own card actually needs — a direct
 * side-by-side against the reference showed the real card framing the barrel much
 * more loosely. Caught only by actually rendering the reference and the site's own
 * output next to each other at matching scale, not by re-deriving either from the
 * CSS or the source art. **Ice Hound (49–60) was not covered by that batch** — the
 * screenshots never scrolled that far — so it was re-checked only by rendering
 * every one of the sixty tiles at real size and confirming they all fill their
 * frame with the same tight, consistent scale the reference batch showed for
 * 1–48, not against a fresh in-game screenshot of Ice Hound itself. Given Cannon
 * Cart's own "left unchanged" claim from that identical check turned out to be
 * wrong, this internal-consistency check is worth treating as unverified for Ice
 * Hound too until a screenshot actually covering it turns up. Ice Golem's zoom was
 * chosen the same way as the rest of the table: candidates at `zoom` 1.2, 1.25,
 * 1.27, 1.28 and 1.3 (same `x`/`y`) were rendered at real tile size and inspected
 * corner by corner. 1.2 and 1.25 both still showed a sliver of purple in the
 * top-right corner; 1.27 was the first to fully clear every corner, and 1.28 was
 * kept instead of 1.27 only for a small margin of safety against the same corner
 * re-appearing at a tile width this table wasn't checked against — still well
 * short of 1.3, which cleared it with room to spare but cropped tighter than
 * needed.
 *
 * **Cannon Cart took four attempts, not one, and the middle two are worth keeping
 * on the record because each looked verified and wasn't.** Once the "left
 * unchanged" claim above was checked directly against the reference rather than
 * taken on its own report, `zoom: 1.5` turned out neither the tightest crop that
 * clears the sky nor one that clears it at all — the window needed to shift well
 * left and down, not zoom in further.
 *
 * The second attempt, `x: 42, y: 59, zoom: 1.24`, was found by sampling an 8-pixel
 * block at each of the four corners and choosing the smallest zoom that passed —
 * and it did clear the background. What it got wrong was a different axis
 * entirely: `card-crops.test.ts`'s own margin comment checked only `x`'s distance
 * from `clampCenter`'s floor (a comfortable 1.68) and called that the table's
 * narrowest margin, without checking `y` the same way — `y: 59` was actually only
 * 0.68 from its own clamp ceiling, under half of it, caught by review before this
 * ever shipped.
 *
 * The third attempt, `x: 41, y: 59, zoom: 1.28`, fixed that specific problem —
 * chosen for a matched ~1.94 margin on *both* axes instead of a lopsided one — and
 * was re-checked the same way the second attempt had been, an 8-pixel block at
 * each corner, which again passed. That check was the real problem, not either
 * value: an independent review, then a direct re-render, found the background
 * wasn't confined to the corner pixels at all. It was a wedge starting a little
 * way in from the bottom-right and widening toward the edge — exactly the shape
 * an 8px corner block sits entirely inside of without ever touching. This crop
 * leaked more visibly than the original `1.5`, not less.
 *
 * A pixel-map of the *whole* source image (every few pixels, not just near the
 * corners) made the actual shape visible: a clean band across the full width from
 * roughly 15% to 70% of the image's height, with the wedge growing in from the
 * bottom-right below that, and the top few percent solid sky throughout. Only a
 * crop whose entire perimeter — not just its corners — stays inside the clean
 * band is actually safe, so that became the check for the fourth attempt: every
 * pixel in a several-pixel-deep band around all four edges, not a block at each
 * corner. `zoom: 1.45` at `x: 38, y: 50` is the smallest zoom that passes that
 * fuller check, confirmed by rendering each of its four corners individually at
 * 6× magnification and reading them by eye rather than trusting a classifier a
 * third time. It crops tighter than the reference's own looser framing of the
 * barrel — the source art genuinely does not have enough clean margin to match
 * that framing without reopening the leak, a real constraint of this file, not a
 * search that stopped too early. Tighter than hoped, but the first version of
 * this entry that is actually, verifiably clean.
 *
 * `card-crops.test.ts` checks that everything in this table names a real card and
 * stays inside its own picture, so an entry cannot be filled in wrongly and go
 * unnoticed. Kept as a table rather than one-off constants because the next card
 * found this way is another row here, not a new mechanism.
 */
const FACE_CROPS: Readonly<Record<number, Omit<CardFaceCrop, 'kind'>>> = {
  23: { x: 50, y: 50, zoom: 1.15 },
  25: { x: 50, y: 48, zoom: 1.2 },
  27: { x: 50, y: 54, zoom: 1.28 },
  39: { x: 38, y: 50, zoom: 1.45 },
  59: { x: 46, y: 50, zoom: 1.2 },
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
