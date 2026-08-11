import type { DeckProgress } from '../deck-progress.ts'

/**
 * The four deck-progress plaques, as the event draws them across the top of its
 * own panel: a rounded plaque per deck in that deck's color, the deck named
 * along the top, and a bar beneath with the fraction printed on it.
 *
 * **The fraction is the encoding; the bar is a second telling of it.** That is the
 * one rule this component cannot bend — a plaque whose progress could only be read
 * off a length or a hue would be unreadable to anyone who cannot compare the four,
 * and it is the numbers people actually quote to each other ("I'm 7 of 19").
 *
 * **The bar fill is the sequential blue ramp — `--accent` on `--track` — not the
 * game's gold, for any deck still in progress.** The game fills these bars gold,
 * but gold in this app is chrome: panel edges, buttons and the two display
 * numerals, and it has never encoded a value (see the note at the top of
 * styles.css). A gold bar whose length meant something would be the first, and it
 * would put the app's one "this is furniture, not data" signal to work as data.
 * The deck's own color was the other candidate and is rejected for the same reason
 * *while the deck is still filling*: `--deck-*` is a *categorical* role, it already
 * says which deck on the plaque around the bar, and reusing it for a bar whose
 * *length* varies would leave four bars whose colors differ for a reason unrelated
 * to how full they are.
 *
 * **A complete deck is where that reasoning stops applying, and the *whole plaque*
 * goes solid `--deck` — mirroring the event's own plaque, which does the same
 * thing.** Not just the bar: the outer card's tinted background, its border, the
 * distinction between "card" and "bar inside it" all collapse into one flat
 * block, same as the reference. A first pass got this wrong — swapped only the
 * bar's own fill and left the card around it on its usual tint, a two-tone look
 * the event's plaque does not have — caught by a direct screenshot comparison,
 * not by re-reading the CSS. `deck.complete` (see its own doc comment in
 * `deck-progress.ts` for exactly what counts) is not "does this look 100% full"
 * — a data disagreement can also clamp the bar to full without every card
 * actually being held, and that must not flip the fill. Once a deck genuinely is
 * complete there is no length left to encode: every one of the four decks is
 * equally "done," so a categorical color no longer competes with the magnitude
 * ramp for the same signal, the exact condition under which `--deck-*` was
 * ruled out above. The fraction still prints on top of it, unchanged — see the
 * next paragraph for why that half of the design never bends, complete or not.
 *
 * There is **no resource icon** at the right end, unlike the game. The event's
 * elixir / dark-elixir / builder-gold / potion icons are not among the vendored
 * art (`web/public/coc/` has cards, league badges, labels and wiki unit art, and
 * nothing else), and an equipment gem standing in for a resource would be a
 * picture that said something untrue. The space goes to the fraction instead.
 */
export function DeckPlaques({
  decks,
  className,
}: {
  decks: readonly DeckProgress[]
  /** A placement modifier, for the tighter copy in the card page's header. */
  className?: string
}) {
  if (decks.length === 0) return null

  return (
    <div className={className ? `deck-plaques ${className}` : 'deck-plaques'}>
      {decks.map((deck) => (
        /* The deck's color is picked in CSS off `data-deck`, like the card tiles'
           frames, so no color is ever set inline from data. `data-complete` is the
           same `deck.complete` the bar below also carries — set on both rather
           than reached via `:has()` from just the bar's, since `data-deck` already
           proves two attributes off the same value in the same iteration cannot
           drift from each other any more than one would. */
        <div
          key={deck.category}
          className="deck-plaque"
          data-deck={deck.slug}
          data-complete={deck.complete ? 'true' : undefined}
        >
          <span className="deck-plaque__name">{deck.category} Cards</span>
          {/*
           * A real progressbar, named and valued. `aria-valuetext` overrides the
           * per-cent a screen reader would otherwise compute from valuenow/valuemax:
           * the bar says "7 of 19" on screen, and announcing "37%" instead would be
           * a third number nobody can act on.
           */}
          <div
            className="deck-plaque__bar"
            role="progressbar"
            aria-label={deck.label}
            aria-valuemin={0}
            aria-valuemax={deck.size}
            aria-valuenow={deck.held}
            aria-valuetext={deck.spoken}
            /* Picked up in CSS to swap the fill from the magnitude ramp to a solid
               `--deck` — see this file's own doc comment above. Not color set
               inline from data, same reasoning as `data-deck` on the plaque itself. */
            data-complete={deck.complete ? 'true' : undefined}
          >
            <span className="deck-plaque__fill" style={{ width: `${deck.percent}%` }} />
            <span className="deck-plaque__fraction">{deck.fraction}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
