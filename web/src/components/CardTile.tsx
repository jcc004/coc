import type { CSSProperties, ReactNode } from 'react'
import { cardFraming } from '../card-crops.ts'
import { deckSlug, type GeneratedCard } from '../cards.ts'
import { GameIcon } from './primitives.tsx'

/**
 * One card as a framed picture: the framing, the deck frame, the held-vs-not
 * treatment, and the corner badge.
 *
 * The framing is `cardFraming`'s, and today it is `whole` for all sixty — the art
 * is a 256×320 set already cropped on its subject, and the frame is 4:5 to match,
 * so the picture fills the frame untouched. The face-crop branch below is the
 * exception path, kept because the art may be regenerated unframed; see
 * `card-crops.ts`.
 *
 * It is here rather than inside `BaseCardEditor` because **two grids draw it** —
 * the per-base entry grid, where each tile wraps a number box, and the clan-wide
 * totals grid on the card page, where a tile wraps nothing and carries the
 * clan's total in its badge. Same reasoning as `BaseCardEditor` being its own
 * file: the two grids only earn their place by being scannable card-for-card
 * against each other, and a second copy of the crop geometry, the deck frame and
 * the desaturation would drift apart the first time either was touched.
 *
 * Three things the callers vary, and nothing else:
 *
 * - **the badge.** The entry grid shows one only past a second copy, because `×1`
 *   on fifty tiles is noise where a spare is the fact worth spotting. The totals
 *   grid shows every count including 1, because the totals *are* what it is for.
 * - **what sits under the frame.** A number box, or nothing.
 * - **where the accessible name comes from.** In the entry grid the number box is
 *   the named control and the tile needs no name of its own; in the totals grid
 *   there is no control at all, so `label` names the tile and is the only place
 *   "nobody holds this" is stated in words — greyscale with no badge would
 *   otherwise be colour alone.
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
  /** Drives the desaturation: a card that is not held shows the same art in grey. */
  held: boolean
  /** Corner badge text, lower right over the art. Omit for no badge at all. */
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
      // The deck's frame colour is picked in CSS off this, so the palette stays
      // in styles.css with the rest of the theme rather than inline here.
      data-deck={deckSlug(card.category)}
      title={title}
      /* `img`, not a bare container: with a name on it the tile is a picture with
         a number on it, and a role is what makes that name reliably announced. */
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
    >
      <div className="card-tile__frame" data-crop={framing.kind} style={frameStyle}>
        <GameIcon src={card.image} className="card-tile__art" />
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
