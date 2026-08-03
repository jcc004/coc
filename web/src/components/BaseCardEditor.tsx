import { useEffect, useMemo, useState } from 'react'
import { MAX_CARD_COUNT, type BaseInventory } from '@coc/shared'
import { saveBaseCounts } from '../card-inventory.ts'
import {
  ALL_CARDS,
  cardCategoriesInOrder,
  cardsInCategory,
  clampCardCount,
  countMap,
  deckSlug,
  inventorySummary,
  toCardCounts,
} from '../cards.ts'
import { formatDateTime } from '../format.ts'
import { GameIcon } from './primitives.tsx'

/**
 * The 60-tile grid and its entry form, for **one** base.
 *
 * It lives here rather than inside `CardsView` because two pages show it: the card
 * page, which picks the base from a select, and a player's own page, which *is* a
 * base and so needs no select. That is the whole reason for the split — a second
 * copy of sixty tiles and their draft-and-save logic would be two things to keep
 * in step, and the greyscale, the badges, the deck groups and the clamping would
 * drift apart the first time one of them was touched.
 *
 * Choosing the base is deliberately **not** this component's job: it takes a tag
 * and a label and shows that base. Each caller keeps its own idea of which base it
 * is about — a select on the card page, the player whose page it is on the other.
 * Only one of these is ever mounted at a time, which is what lets the deck
 * headings below carry fixed ids.
 */

/** Who last touched a base, in words. */
function Attribution({ base }: { base: BaseInventory | undefined }) {
  if (!base?.updatedAt) {
    return <span className="card-meta">Nothing recorded yet</span>
  }

  const when = new Date(base.updatedAt)
  return (
    <span className="card-meta">
      Updated {Number.isNaN(when.getTime()) ? base.updatedAt : formatDateTime(when)}
      {/* `null` means the account that entered it is gone — the counts outlive it. */}
      {base.updatedBy ? ` by ${base.updatedBy}` : ' by a since-removed account'}
    </span>
  )
}

/**
 * One card: the picture, and the count.
 *
 * The tile shows no card name — the art is the identity, which is how the event
 * itself presents these. The name has not gone anywhere it cannot be recovered
 * from: it opens the number box's accessible name, which is what a screen reader
 * announces for the control the user actually operates, and it is on the tile's
 * `title` as a pointer tooltip. The `title` is a convenience for a mouse and
 * nothing more — a tooltip does not appear on a touch tap, and assistive tech
 * mostly ignores a `title` on a plain container — so the input's label is the
 * accessible name that has to carry this, and it is written out in full there
 * rather than assembled from the surroundings.
 *
 * Held-vs-not is still not carried by colour alone. `--locked` desaturates the
 * art, and the words underneath say "None" or "Have n" independently of it, with
 * the number box repeating it a third time.
 *
 * `GameIcon` is used without a `fallback` on purpose. The card art is gitignored,
 * so a fresh clone has none of it; the element removes itself on error rather
 * than showing a broken-image glyph, and the fixed-height art box keeps the tile
 * the same size either way, so the grid cannot collapse. Without the name label a
 * checkout with no art shows an empty frame over its count — the input's label and
 * the `title` are then the only way to tell the sixty tiles apart, which is the
 * cost of a picture-only grid.
 */
function CardTile({
  card,
  count,
  onCount,
  disabled,
}: {
  card: (typeof ALL_CARDS)[number]
  count: number
  onCount: (next: number) => void
  disabled: boolean
}) {
  const held = count > 0

  return (
    <div
      className={held ? 'card-tile' : 'card-tile card-tile--locked'}
      // The deck's frame colour is picked in CSS off this, so the palette stays
      // in styles.css with the rest of the theme rather than inline here.
      data-deck={deckSlug(card.category)}
      // Names the tile for a pointer now that no text does. The category rides
      // along because the decks draw no heading any more, leaving the frame colour
      // as the only visible grouping.
      title={`${card.name} · ${card.category}`}
    >
      <div className="card-tile__frame">
        <GameIcon src={card.image} className="card-tile__art" />
        {count > 1 ? (
          <span className="card-tile__badge" aria-hidden="true">
            ×{count}
          </span>
        ) : null}
      </div>

      {/* The text half of the encoding: readable with no colour vision at all. */}
      <span className="card-tile__state">{held ? `Have ${count}` : 'None'}</span>

      <input
        className="card-tile__input"
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_CARD_COUNT}
        value={String(count)}
        disabled={disabled}
        onChange={(event) => onCount(clampCardCount(event.target.value))}
        /* Carries the name and the deck, since the tile no longer prints either. */
        aria-label={`${card.name}, ${card.category} — copies held, 0 to ${MAX_CARD_COUNT}`}
      />
    </div>
  )
}

/**
 * The grid and the entry form for one base, saved in a single request.
 *
 * The draft is local until Save, so typing sixty boxes is sixty keystrokes and
 * one write rather than sixty. It is re-seeded whenever the stored base changes
 * identity or timestamp — which is how somebody else's save shows up here — but
 * never while there are unsaved edits, because silently replacing what somebody
 * is typing is worse than showing them a stale number they are about to overwrite.
 */
export function BaseCardEditor({
  tag,
  label,
  base,
}: {
  tag: string
  /** The base's member name, or its tag when no roster we can see names it. */
  label: string
  base: BaseInventory | undefined
}) {
  const stored = useMemo(() => countMap(base), [base])
  const [draft, setDraft] = useState<Map<number, number>>(stored)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const dirty = useMemo(() => {
    if (draft.size !== stored.size) return true
    for (const [id, count] of draft) if (stored.get(id) !== count) return true
    return false
  }, [draft, stored])

  /* Re-seed on a change of base, or when the server's copy moves under us and
     there is nothing unsaved to lose. `dirty` is deliberately not a dependency:
     it would re-run the moment an edit made it false again. */
  useEffect(() => {
    setDraft(stored)
    setProblem(null)
    setSaved(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, base?.updatedAt])

  function setCount(cardId: number, next: number) {
    setSaved(false)
    setDraft((current) => {
      const updated = new Map(current)
      // Zero is an absence, not a value, so the draft stays as sparse as storage.
      if (next <= 0) updated.delete(cardId)
      else updated.set(cardId, next)
      return updated
    })
  }

  async function save() {
    setBusy(true)
    setProblem(null)
    try {
      await saveBaseCounts(tag, toCardCounts(draft))
      setSaved(true)
    } catch (cause) {
      // Never report success on a failure: `saved` stays false and the draft is
      // left exactly as typed, so nothing has to be re-entered.
      setProblem(cause instanceof Error ? cause.message : `Could not save ${tag}.`)
    } finally {
      setBusy(false)
    }
  }

  const summary = inventorySummary({ tag, counts: toCardCounts(draft) })

  return (
    <>
      <div className="card-header">
        <h2 className="section-title" style={{ margin: 0 }}>
          {label}
        </h2>
        <div className="card-header__tools">
          <span className="card-meta">
            {summary.distinct}/{ALL_CARDS.length} cards · {summary.total} copies ·{' '}
            {summary.duplicates} spare{summary.duplicates === 1 ? '' : 's'}
          </span>
          <button type="button" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? 'Saving…' : dirty ? 'Save counts' : 'Saved'}
          </button>
        </div>
      </div>

      <p className="card-meta" style={{ margin: '0 0 12px' }}>
        {/* The tag is still the identity a trade is arranged against, so it stays
            on screen even though the heading now reads as a name. */}
        {label === tag ? null : <>{tag} · </>}
        <Attribution base={base} />
      </p>

      {/* The failure is reported at the control that caused it, not page-wide. */}
      {problem ? (
        <div className="notice notice--error">
          <p className="notice__title">Nothing was saved</p>
          <p className="notice__body">{problem}</p>
          <p className="notice__hint">
            Your typed counts are still here — press <strong>Save counts</strong> to try again.
          </p>
        </div>
      ) : null}

      {saved && !dirty ? <p className="card-meta">Counts saved for everyone.</p> : null}

      {/*
       * One grid for all sixty, not one per deck. Still in deck order, so each
       * type arrives as an unbroken run of tiles wearing its own frame colour —
       * which is now the only *visible* thing separating them, the drawn headings
       * and the gaps between them having gone. A single grid is the point: per-deck
       * grids broke the row wherever a deck ran out mid-line.
       */}
      <div className="card-grid">
        {cardCategoriesInOrder().map((category) => {
          const headingId = `card-deck-${deckSlug(category)}`
          return (
            /*
             * The deck, as a named group. `display: contents` is what lets it name
             * a run of tiles without becoming a box: the tiles stay direct grid
             * items of the one grid above, so the geometry is byte-for-byte what it
             * is with no wrapper at all — measured, not assumed.
             *
             * It exists because the deck stopped being visible when the headings
             * went: the frame colour is the only thing left drawing the boundary,
             * and colour is not a cue this app leans on alone anywhere else. The
             * heading is the `.visually-hidden` recipe, so it names the group, it
             * is reachable by heading navigation, and it draws nothing.
             */
            <div key={category} className="card-deck" role="group" aria-labelledby={headingId}>
              <h3 id={headingId} className="visually-hidden">
                {category}
              </h3>
              {cardsInCategory(category).map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  count={draft.get(card.id) ?? 0}
                  onCount={(next) => setCount(card.id, next)}
                  disabled={busy}
                />
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}
