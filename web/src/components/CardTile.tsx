import type { CSSProperties, ReactNode } from 'react'
import { cardFraming } from '../card-crops.ts'
import { deckSlug, type GeneratedCard } from '../cards.ts'
import { GameIcon } from './primitives.tsx'

/**
 * One card as a framed picture: the framing, the deck frame, the held-vs-not
 * treatment, and the corner badge.
 *
 * The framing is `cardFraming`'s: `whole` for fifty-six of the sixty, where the
 * art is already cropped on its subject and the 4:5 frame fills untouched, and
 * `face` for four individually corrected cards whose own art has more background
 * around a smaller subject than the rest of the set. See `card-crops.ts` for which
 * four and why, and for the face-crop path's other role as the hook for a future
 * wholesale art regeneration.
 *
 * It is here rather than inside `BaseCardEditor` because **two grids draw it** —
 * the per-base entry grid, where each tile wraps a row of count controls, and the
 * clan-wide totals grid on the card page, where a tile wraps nothing and carries the
 * clan's total in its badge. Same reasoning as `BaseCardEditor` being its own
 * file: the two grids only earn their place by being scannable card-for-card
 * against each other, and a second copy of the crop geometry, the deck frame and
 * the desaturation would drift apart the first time either was touched.
 *
 * Three things the callers vary, and nothing else:
 *
 * - **the badge.** Both grids show one only past a copy — `×1` on fifty tiles is
 *   noise where a spare is the fact worth spotting — and it is always plain,
 *   decorative text: see the note on `badge` below for why the entry grid's copy is
 *   not a control despite sitting inside one now.
 * - **what sits under the frame.** Nothing, on both grids now — the entry grid's old
 *   stepper row moved *outside* this component (see "nothing here is clickable"
 *   below), leaving the slot to whatever a caller still needs said at the tile
 *   itself: today that is only the entry grid's `Not saved` note, past a failed
 *   write. The slot has never cared how many children go in it, which is why they
 *   arrive as `children` and not as a prop here.
 * - **where the accessible name comes from.** In the entry grid the two count
 *   controls are the named things, and the tile needs no name of its own — both
 *   already say which card this is, and a name on the container would be a third. In
 *   the totals grid the tile holds no control, so `label` names the tile and is the
 *   only place "nobody holds this" is stated in words — grayscale with no badge would
 *   otherwise be color alone.
 *
 * **Nothing here is clickable, and that is a decision rather than an omission — now
 * true of both grids the same way, not just one of them.** The totals grid has always
 * made its tiles pressable — a press lists the bases holding that card — by wrapping
 * this in a `<button>` of its own rather than handling the press in here. The entry
 * grid now does the same thing, for the same reason: a tap anywhere on its tile adds a
 * copy, and that press is a `<button>` in `BaseCardEditor.tsx`'s `CardEntryTile`
 * *wrapping* this component, not a handler added to it. Handling either grid's press
 * in here would make both pressable at once with no way to tell them apart, and for
 * the entry grid specifically it would nest that press's own target around whatever
 * sits under the frame — a button inside a button, which is not even markup a browser
 * will keep. `CardEntryTile` also draws a second, smaller button — the corner `−`
 * circle — but that one is a *sibling* of the button wrapping this component, not
 * anything rendered inside it, so it costs this component nothing either.
 *
 * So the caller wrapping it is the contract, for both grids identically: this stays a
 * picture, and `label` is the name a wrapping button computes from its content when it
 * has no better name of its own to offer (the entry grid's wrapping button supplies
 * its own accessible name instead, so it never sets `label` here). The badge is part
 * of that picture, not an exception to it: max count is 10, so a press on either of
 * the entry grid's two controls is the whole answer to changing it, and the badge only
 * ever needs to be looked at, never touched.
 *
 * `GameIcon` is used without a `fallback` on purpose: the card art is gitignored,
 * so a fresh clone has none of it, and the element removes itself on error rather
 * than showing a broken-image glyph. The frame is a *reserved* size, so the grid
 * neither collapses nor reflows when that happens.
 */
export function CardTile({
  card,
  held,
  badge,
  title,
  label,
  className,
  children,
}: {
  card: GeneratedCard
  /** Drives the desaturation: a card that is not held shows the same art in gray. */
  held: boolean
  /**
   * Corner badge text, bottom-center over the art, straddling its lower edge. Omit
   * for no badge at all.
   *
   * Sized, shaped and placed off the real game's own card-collection screen — a
   * wide, chamfered bar roughly half the art's width, centered on the art's bottom
   * edge — rather than an app-invented convention, which is why it reads larger and
   * more prominent than a typical corner-chip badge. See `.card-tile__badge` in
   * styles.css for the measurements.
   */
  badge?: string
  /** Pointer tooltip. A convenience for a mouse — never the only carrier of anything. */
  title: string
  /**
   * The tile's own accessible name, for a caller with no named control inside it.
   * Given one, the tile is announced as the picture it is; the badge over the art
   * is decoration over words this name already spells out.
   */
  label?: string
  /** Extra state class, e.g. the one failed tile in the entry grid. */
  className?: string
  children?: ReactNode
}) {
  const framing = cardFraming(card.id)

  /* A face crop's three numbers reach CSS as custom properties, so the geometry
     stays in styles.css and only the per-card values are set from data. A whole
     framing needs none of them: `data-crop` alone selects the fill-the-frame rule. */
  const frameStyle =
    framing.kind === 'face'
      ? ({
          '--card-x': `${framing.x}%`,
          '--card-y': `${framing.y}%`,
          '--card-zoom': `${framing.zoom}`,
        } as CSSProperties)
      : undefined

  const classes = ['card-tile']
  if (!held) classes.push('card-tile--locked')
  if (className) classes.push(className)

  return (
    <div
      className={classes.join(' ')}
      // The deck's frame color is picked in CSS off this, so the palette stays
      // in styles.css with the rest of the theme rather than inline here.
      data-deck={deckSlug(card.category)}
      title={title}
      /* `img`, not a bare container: with a name on it the tile is a picture with
         a number on it, and a role is what makes that name reliably announced. */
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
    >
      <div className="card-tile__frame" data-crop={framing.kind} style={frameStyle}>
        {/* The art's own rounded-corner clip, split out from the frame so the
            badge below — a sibling, not a child of this — can straddle the
            frame's bottom edge without being clipped along with the art. See
            `.card-tile__badge`'s doc comment in styles.css for why that overlap
            is the point. */}
        <div className="card-tile__art-clip">
          <GameIcon src={card.image} className="card-tile__art" />
        </div>
        {badge === undefined ? null : (
          <span className="card-tile__badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}
