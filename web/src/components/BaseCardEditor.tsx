import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MAX_CARD_COUNT, type BaseInventory, type SessionUser } from '@coc/shared'
import { saveBaseCounts } from '../card-inventory.ts'
import { cardFraming } from '../card-crops.ts'
import {
  blurDecision,
  cardEntryAccess,
  classifySaveFailure,
  countsDiffer,
  type BaseOwner,
  type CardEntryAccess,
  type SaveFailure,
} from '../card-entry.ts'
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
 * copy of sixty tiles and their save logic would be two things to keep in step, and
 * the greyscale, the badges, the deck groups and the clamping would drift apart the
 * first time one of them was touched.
 *
 * Choosing the base is deliberately **not** this component's job: it takes a tag
 * and a label and shows that base. Each caller keeps its own idea of which base it
 * is about — a select on the card page, the player whose page it is on the other.
 * Only one of these is ever mounted at a time, which is what lets the deck
 * headings below carry fixed ids.
 *
 * Neither is *deciding* anything: which counts are worth writing, and whether this
 * session may write them at all, are `card-entry.ts`, and how each tile frames its
 * picture is `card-crops.ts`. Both are pure and tested. What is left here is the
 * markup, the draft, and reporting a failure at the control that caused it.
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
 * One card: a crop of the picture, and the count.
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
 * Held-vs-not is still not carried by colour alone. `--locked` desaturates the art,
 * and the **number box** says it independently: 0 for a card the base lacks, n for
 * one it holds. That box is visible at every breakpoint, which is why the `Have n` /
 * `None` line that used to repeat it a third time has gone.
 *
 * `GameIcon` is used without a `fallback` on purpose. The card art is gitignored,
 * so a fresh clone has none of it; the element removes itself on error rather
 * than showing a broken-image glyph, and the fixed-size art box keeps the tile
 * the same size either way, so the grid cannot collapse. Without the name label a
 * checkout with no art shows an empty frame over its count — the input's label and
 * the `title` are then the only way to tell the sixty tiles apart, which is the
 * cost of a picture-only grid.
 */
function CardTile({
  card,
  count,
  onCount,
  onLeave,
  readOnlyReason,
  failed,
}: {
  card: (typeof ALL_CARDS)[number]
  count: number
  onCount: (next: number) => void
  onLeave: () => void
  /** Why this base cannot be typed into, or `null` when it can. */
  readOnlyReason: string | null
  /** Set on the one tile whose blur triggered a save that did not happen. */
  failed: boolean
}) {
  const held = count > 0
  const framing = cardFraming(card.id)

  /* The crop's three numbers reach CSS as custom properties, so the geometry stays
     in styles.css and only the per-card values are set from data. */
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
  if (failed) classes.push('card-tile--failed')

  return (
    <div
      className={classes.join(' ')}
      // The deck's frame colour is picked in CSS off this, so the palette stays
      // in styles.css with the rest of the theme rather than inline here.
      data-deck={deckSlug(card.category)}
      // Names the tile for a pointer now that no text does. The category rides
      // along because the decks draw no heading any more, leaving the frame colour
      // as the only visible grouping.
      title={`${card.name} · ${card.category}`}
    >
      <div className="card-tile__frame" data-crop={framing.kind} style={frameStyle}>
        <GameIcon src={card.image} className="card-tile__art" />
        {count > 1 ? (
          <span className="card-tile__badge" aria-hidden="true">
            ×{count}
          </span>
        ) : null}
      </div>

      <input
        className="card-tile__input"
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_CARD_COUNT}
        value={String(count)}
        disabled={readOnlyReason !== null}
        onChange={(event) => onCount(clampCardCount(event.target.value))}
        /* The save. Leaving the field is the commit — see the note on `commit`. */
        onBlur={onLeave}
        aria-invalid={failed || undefined}
        /* Carries the name and the deck, since the tile no longer prints either,
           and the refusal too when there is one: a disabled control that does not
           say why is a dead end, and sixty of them is sixty dead ends. */
        title={readOnlyReason ?? undefined}
        aria-label={
          readOnlyReason === null
            ? `${card.name}, ${card.category} — copies held, 0 to ${MAX_CARD_COUNT}`
            : `${card.name}, ${card.category} — copies held, read-only. ${readOnlyReason}`
        }
      />

      {/* At the tile, because the Save button that used to be the success signal is
          gone and a silent failure would leave somebody believing a count stored. */}
      {failed ? <span className="card-tile__note">Not saved</span> : null}
    </div>
  )
}

/** Names the state a base is in for a session that may not write it. */
function ReadOnlyNotice({ access }: { access: CardEntryAccess }) {
  if (access.writable) return null
  return (
    <div className="notice">
      <p className="notice__title">
        {access.refusal === 'notOwner' ? 'Someone else owns this base' : 'This base has no owner'}
      </p>
      <p className="notice__body">{access.message}</p>
      <p className="notice__hint">
        The counts below are shown as stored and cannot be changed from here.
      </p>
    </div>
  )
}

/**
 * The grid and the entry form for one base, saved in a single request.
 *
 * **Leaving a field is the save.** There is no Save button: a count is typed and
 * then committed on blur, which is also what happens when the user tabs on to
 * another card, clicks elsewhere, or navigates away. Two things that has to get
 * right, and both are in `card-entry.ts` rather than here:
 *
 * - **an unchanged field writes nothing.** Tabbing across sixty boxes must not fire
 *   sixty requests, because every one of them moves `updated_at`, and `updated_at`
 *   is what the attribution line above the grid reads out. The comparison is against
 *   `savedRef` — the counts the server is known to hold — so retyping the same
 *   number, or arrowing up and straight back down, is silent too;
 * - **a failure is visible and keeps the typed number.** The draft is left exactly
 *   as typed, the tile says `Not saved`, and the panel says why. A 403 is reported
 *   as the rule it is ("this base is not yours") rather than as a breakage, because
 *   with the owner check on the server it is now an expected answer.
 *
 * The write is the existing whole-base endpoint. Sixty counts is a tiny payload, and
 * a per-card route would be a second write path able to disagree with the first.
 */
export function BaseCardEditor({
  tag,
  label,
  base,
  owner,
  user,
}: {
  tag: string
  /** The base's member name, or its tag when no roster we can see names it. */
  label: string
  base: BaseInventory | undefined
  /** Who owns this base, as `GET /api/owners` reports it. */
  owner: BaseOwner
  user: Pick<SessionUser, 'id' | 'role'>
}) {
  const stored = useMemo(() => countMap(base), [base])
  const [draft, setDraft] = useState<Map<number, number>>(stored)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<(SaveFailure & { cardId: number }) | null>(null)
  /* Mirrors `saving` for the blur handler, which has to know whether a request is
     in flight *now* rather than at the last render. */
  const savingRef = useRef(false)

  const access = useMemo(() => cardEntryAccess(user, owner, tag), [user, owner, tag])
  const writable = access.writable

  /*
   * What the server is known to hold. A ref, not state: it is read inside the blur
   * handler at the moment of the decision, and a re-render is never the thing that
   * should make a write happen.
   */
  const savedRef = useRef(stored)
  /* The draft, for the same reason — a blur handler must see what is in the boxes
     now, not what was there when React last closed over it. */
  const draftRef = useRef(stored)
  draftRef.current = draft

  /*
   * Re-seed on a change of base, or when the server's copy moves under us — which
   * is how somebody else's save shows up here — but never over unsaved edits,
   * because silently replacing what somebody is typing is worse than showing them a
   * stale number they are about to overwrite. Our own save lands here too, and by
   * then the draft already matches, so the seed is a no-op.
   */
  useEffect(() => {
    if (countsDiffer(draftRef.current, savedRef.current)) return
    savedRef.current = stored
    setDraft(stored)
    setFailure(null)
    // `stored` is a fresh Map each render, so the identity of the base's record is
    // what this keys off instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, base?.updatedAt])

  function setCount(cardId: number, next: number) {
    setDraft((current) => {
      const updated = new Map(current)
      // Zero is an absence, not a value, so the draft stays as sparse as storage.
      if (next <= 0) updated.delete(cardId)
      else updated.set(cardId, next)
      return updated
    })
  }

  /**
   * Leaving a field. Saves the whole base if — and only if — a number really
   * changed since the last write, and reports at `cardId` if it did not take.
   */
  async function commit(cardId: number): Promise<void> {
    const decision = blurDecision({
      draft: draftRef.current,
      saved: savedRef.current,
      writable,
      saving: savingRef.current,
    })
    if (!decision.save) return

    savingRef.current = true
    setSaving(true)
    setFailure(null)
    try {
      /*
       * A loop, so a box changed while the request was in flight is not dropped:
       * that blur decided `busy` and did nothing, and this is where the deferral is
       * picked up. It terminates because only typing can reopen the gap, and
       * `savedRef` only ever records what the server actually took.
       */
      while (countsDiffer(draftRef.current, savedRef.current)) {
        const attempt = new Map(draftRef.current)
        await saveBaseCounts(tag, toCardCounts(attempt))
        savedRef.current = attempt
      }
    } catch (cause) {
      setFailure({ ...classifySaveFailure(cause, tag), cardId })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  /*
   * Navigating away is leaving the field too. Without this, typing a number and
   * then switching base or closing the panel would drop the edit with no blur ever
   * firing — the one way an auto-saving form can still lose a number.
   */
  useEffect(() => {
    return () => {
      if (!writable) return
      if (!countsDiffer(draftRef.current, savedRef.current)) return
      // Fire-and-forget: the component is going, so there is nothing left to
      // report to. The store records the failure, and the base still shows the
      // stored counts, which is the honest outcome.
      void saveBaseCounts(tag, toCardCounts(new Map(draftRef.current))).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, writable])

  const summary = inventorySummary({ tag, counts: toCardCounts(draft) })
  const readOnlyReason = access.writable ? null : access.message

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
          {/* The only status left where the Save button was. It says what the form
              is doing, not what it wants you to do — there is nothing to press. */}
          <span className="card-meta" aria-live="polite">
            {saving ? 'Saving…' : writable ? 'Counts save as you leave each box' : 'Read-only'}
          </span>
        </div>
      </div>

      <p className="card-meta" style={{ margin: '0 0 12px' }}>
        {/* The tag is still the identity a trade is arranged against, so it stays
            on screen even though the heading now reads as a name. */}
        {label === tag ? null : <>{tag} · </>}
        <Attribution base={base} />
      </p>

      <ReadOnlyNotice access={access} />

      {/*
       * The failure is reported at the control that caused it, not page-wide — and
       * a refusal is reported as an answer rather than as a fault, because with the
       * owner check on the server a 403 is now an expected outcome.
       */}
      {failure ? (
        <div className={failure.kind === 'refused' ? 'notice' : 'notice notice--error'}>
          <p className="notice__title">
            {failure.kind === 'refused' ? 'That base is not yours to change' : 'Nothing was saved'}
          </p>
          <p className="notice__body">{failure.message}</p>
          <p className="notice__hint">
            {failure.kind === 'refused'
              ? 'Your typed counts are still on screen, but they have not been stored.'
              : 'Your typed counts are still here — change one and leave the box to try again.'}
          </p>
        </div>
      ) : null}

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
                  onLeave={() => void commit(card.id)}
                  readOnlyReason={readOnlyReason}
                  failed={failure?.cardId === card.id}
                />
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}
