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
 * game's gold.** The game fills these bars gold, but gold in this app is chrome:
 * panel edges, buttons and the two display numerals, and it has never encoded a
 * value (see the note at the top of styles.css). A gold bar whose length meant
 * something would be the first, and it would put the app's one "this is furniture,
 * not data" signal to work as data. The deck's own color was the other candidate
 * and is rejected for the mirror-image reason: `--deck-*` is a *categorical* role,
 * it already says which deck on the plaque around the bar, and reusing it for the
 * bar would leave four bars whose colors differ for a reason unrelated to their
 * lengths. So the plaque keeps the deck color, the bar keeps the magnitude ramp
 * every other meter in the app uses, and the fraction is printed either way.
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
           frames, so no color is ever set inline from data. */
        <div key={deck.category} className="deck-plaque" data-deck={deck.slug}>
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
          >
            <span className="deck-plaque__fill" style={{ width: `${deck.percent}%` }} />
            <span className="deck-plaque__fraction">{deck.fraction}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
