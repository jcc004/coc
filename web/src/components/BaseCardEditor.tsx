import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import {
  normalizeTag,
  type BaseInventory,
  type CardCategory,
  type SessionUser,
} from '@coc/shared'
import { saveBaseCounts } from '../card-inventory.ts'
import {
  blurDecision,
  cardCountStep,
  cardEntryAccess,
  classifySaveFailure,
  countsDiffer,
  type BaseOwner,
  type CardEntryAccess,
  type SaveFailure,
} from '../card-entry.ts'
import { DEFAULT_CARD_COLUMNS } from '../card-scale.ts'
import { decksPresent, searchCards } from '../card-search.ts'
import { cardsInGridOrder } from '../card-standings.ts'
import { summarizeBase } from '../card-summary.ts'
import {
  ALL_CARDS,
  cardCategoriesInOrder,
  categoryOfCard,
  countMap,
  deckSlug,
  inventorySummary,
  toCardCounts,
} from '../cards.ts'
import { deckProgress, deckSizes } from '../deck-progress.ts'
import { formatDateTime } from '../format.ts'
import { hrefFor } from '../hooks.ts'
import type { GeneratedCard } from '../cards.ts'
import { CardTile } from './CardTile.tsx'
import { DeckPlaques } from './DeckPlaques.tsx'
import { HelpLink } from './primitives.tsx'

/**
 * The 60-tile grid and its entry form, for **one** base.
 *
 * It lives here rather than inside `CardsView` because two pages show it: the card
 * page, which picks the base from a select, and a player's own page, which *is* a
 * base and so needs no select. That is the whole reason for the split — a second
 * copy of sixty tiles and their save logic would be two things to keep in step, and
 * the grayscale, the badges, the deck groups and the clamping would drift apart the
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
 * One end of a tile's count row: a press that moves the count by one.
 *
 * `cardCountStep` decides both whether the press is offered and where it lands, so
 * `to === null` is a bound reached — see the note there for why that is **`disabled`**
 * rather than a press that clamps. A read-only base disables both ends — the two
 * steppers are the whole of this cell, since the badge over the art is decoration,
 * never a control; see the note on `CardEntryTile` below.
 */
function StepButton({
  count,
  by,
  glyph,
  label,
  onCount,
  buttonRef,
  siblingRef,
  readOnlyReason,
}: {
  count: number
  by: 1 | -1
  /** Drawn, and hidden from the accessibility tree: `label` is the name. */
  glyph: string
  /** The whole accessible name, e.g. `One more Barbarian`. */
  label: string
  onCount: (next: number) => void
  /** This button's own node, so its sibling can hand focus to it — see `siblingRef`. */
  buttonRef: RefObject<HTMLButtonElement | null>
  /**
   * The *other* stepper in this cell, for the one press that takes this button away.
   * There used to be a count box to fall back on; now the only other control in the
   * cell that is always operable — never disabled by the same press, and never hidden
   * by width — is the sibling button.
   */
  siblingRef: RefObject<HTMLButtonElement | null>
  /** Why this base cannot be typed into, or `null` when it can. */
  readOnlyReason: string | null
}) {
  const to = cardCountStep(count, by)

  return (
    <button
      ref={buttonRef}
      type="button"
      className="card-tile__step"
      disabled={readOnlyReason !== null || to === null}
      /* The refusal in full for a pointer, where a tooltip costs nothing. The
         accessible name says only *that* it is read-only — see the tile's note. */
      title={readOnlyReason ?? undefined}
      aria-label={readOnlyReason === null ? label : `${label}, read-only`}
      /*
       * Safari does not focus a button when it is clicked, and the commit is "focus
       * left this cell": without this the sibling would blur to nothing, save, and
       * then the press would change a count that nothing was left focused to commit.
       * So the press takes focus explicitly rather than relying on the default that
       * two of three engines happen to give.
       */
      onMouseDown={(event) => {
        event.currentTarget.focus()
      }}
      onClick={() => {
        if (to === null) return
        /*
         * The press that empties this button hands focus to its sibling. A `disabled`
         * element cannot hold focus, so the browser would drop it on `<body>` —
         * which loses the user's place, and counts as leaving the cell, firing a save
         * in the middle of a run of presses. The sibling stepper is the control in
         * this cell that is guaranteed still operable — it only disables at the
         * *opposite* bound — so it is where focus belongs.
         */
        if (cardCountStep(to, by) === null) siblingRef.current?.focus()
        onCount(to)
      }}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}

/**
 * One card, with the row you set its count in: `−`, `+`.
 *
 * The picture, the frame, the deck color and the desaturation are all `CardTile`,
 * shared with the clan-totals grid on the card page. What is added here is that row
 * and the one thing that has to be said at a tile: a save that did not happen.
 *
 * **There is no way to type a count, at any tile width.** Sixty cards is sixty
 * numbers, and a number box or a tap-to-edit badge were both tried and both dropped:
 * the cap is 10, so a run of taps on `+` is never more than ten presses, which is the
 * whole reason this grid can afford to make the steppers the *only* way to change a
 * count rather than a convenience beside a typed one. Nothing on the tile is a target
 * for typing, so nothing has to reserve space, hide itself at a width, or manage a
 * second focus state — the badge over the art (`CardTile`'s `badge` prop) is once
 * again pure decoration, exactly as it is on the totals grid.
 *
 * **The row sits under the frame, not over the art.** Overlaid controls would put a
 * tap target on top of the one thing on the tile that identifies the card, and the
 * art is the identity here — there is no name to fall back on.
 *
 * ## Two controls, and what each of them is called
 *
 * The tile shows no card name; the art is the identity, which is how the event itself
 * presents these. The name is on the tile's `title` as a pointer tooltip and — the
 * part that has to work — in the accessible name of every control in the cell, because
 * a tooltip does not appear on a touch tap and assistive tech mostly ignores a `title`
 * on a plain container.
 *
 * Sixty tiles times two controls is 120 things a screen reader can land on:
 *
 * - `−` is **`One fewer Barbarian`** and `+` is **`One more Barbarian`**. The card's
 *   name, because somebody landing on a `+` has to know which card it belongs to.
 *
 * Naming carries less than it used to, on purpose: there is no third control left to
 * spell out the deck or the range in words, because the badge that would have carried
 * them is `aria-hidden`. The deck still reaches a screen reader nowhere but the tile's
 * `title`, which assistive tech mostly ignores — an honest cost of dropping the count
 * box's accessible name along with the box, recorded rather than papered over. What a
 * sighted reader gets that a screen reader does not: the frame's deck color, and the
 * badge's own count past a spare.
 *
 * The tile itself is still given **no** `label`. The two steppers are the named
 * things; naming the container as well would announce every card a third time.
 *
 * Held-vs-not still is not carried by color alone for a sighted reader: `--locked`
 * desaturates the art, and the badge — past a spare — prints the exact count in words
 * on top of it. Below that (a card held once, or not at all) the grayscale is what is
 * left to say so, which is the same trade the totals grid already makes for every card
 * on that grid, not a new one introduced here.
 */
function CardEntryTile({
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
  /**
   * Focus has left one of this cell's controls. The argument says whether it landed
   * on another of them, which is not a departure — see `blurDecision`.
   */
  onLeave: (focusStaysInCell: boolean) => void
  /** Why this base cannot be typed into, or `null` when it can. */
  readOnlyReason: string | null
  /** Set on the one tile whose blur triggered a save that did not happen. */
  failed: boolean
}) {
  /* So a press that disables its own button can hand focus to the one control in the
     cell guaranteed still operable: its sibling. See `StepButton`'s note on
     `siblingRef` — the badge is never a focus target, so it is never a candidate. */
  const minusRef = useRef<HTMLButtonElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)

  return (
    <CardTile
      card={card}
      held={count > 0}
      // Only past one copy: `×1` on fifty tiles would be noise, where a spare is
      // the fact worth spotting. The totals grid makes the same choice, for the
      // same reason — see `CardTile`.
      badge={count > 1 ? `×${count}` : undefined}
      // Names the tile for a pointer now that no text does. The category rides
      // along because the decks draw no heading any more, leaving the frame color
      // as the only visible grouping.
      title={`${card.name} · ${card.category}`}
      className={failed ? 'card-tile--failed' : undefined}
    >
      {/*
       * The save, and the reason this row is an element at all rather than two
       * siblings: **leaving the cell is the commit**, not leaving one stepper.
       * `focusout` bubbles, so one handler here sees focus move off either button,
       * and `relatedTarget` says where it went — still inside this row, or out.
       * Pressing `+` five times is one departure and one write; without this it
       * would be five writes of the whole base, each moving the `updated_at` the
       * attribution line above the grid reads out. The decision itself is
       * `blurDecision`, so the "a stepper press is not a departure" skip sits with
       * `unchanged` and `busy` rather than being a second, quieter rule living in
       * here.
       */}
      <div
        className="card-tile__count"
        onBlur={(event) => onLeave(event.currentTarget.contains(event.relatedTarget))}
      >
        <StepButton
          count={count}
          by={-1}
          /* U+2212, not a hyphen: at this size a hyphen sits high and reads as
             punctuation rather than as the other half of the `+`. */
          glyph="−"
          label={`One fewer ${card.name}`}
          onCount={onCount}
          buttonRef={minusRef}
          siblingRef={plusRef}
          readOnlyReason={readOnlyReason}
        />

        <StepButton
          count={count}
          by={1}
          glyph="+"
          label={`One more ${card.name}`}
          onCount={onCount}
          buttonRef={plusRef}
          siblingRef={minusRef}
          readOnlyReason={readOnlyReason}
        />
      </div>

      {/* At the tile, because the Save button that used to be the success signal is
          gone and a silent failure would leave somebody believing a count stored. */}
      {failed ? <span className="card-tile__note">Not saved</span> : null}
    </CardTile>
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
      {/* A full-text link rather than a `?` here: this is the moment somebody is
          actually stuck, and the answer is a paragraph about accounts and labels
          rather than something the notice can restate in a clause. */}
      <p className="notice__hint">
        The counts below are shown as stored and cannot be changed from here.{' '}
        <a href={hrefFor({ view: 'help', section: 'owners' })}>
          Who owns a base, and why it matters
        </a>
        .
      </p>
    </div>
  )
}

/**
 * The grid and the entry form for one base, saved in a single request.
 *
 * **Leaving a cell is the save.** There is no Save button: a count is stepped and then
 * committed when focus leaves the card it belongs to, which is also what happens when
 * the user tabs on to another card, clicks elsewhere, or navigates away. Three things
 * that has to get right, and all three are in `card-entry.ts` rather than here:
 *
 * - **the cell, not either stepper alone.** A cell holds two — `−`, `+` — so focus
 *   moving between them is not a departure and must not write. That is the
 *   difference between five presses of `+` being one request and being five;
 * - **an unchanged field writes nothing.** Tabbing across sixty tiles must not fire
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
  showDeckProgress = false,
  columns = DEFAULT_CARD_COLUMNS,
  query = '',
}: {
  tag: string
  /** The base's member name, or its tag when no roster we can see names it. */
  label: string
  base: BaseInventory | undefined
  /** Who owns this base, as `GET /api/owners` reports it. */
  owner: BaseOwner
  user: Pick<SessionUser, 'id' | 'role'>
  /**
   * Whether to draw the four deck plaques under the header's count line.
   *
   * Off by default, and on only for the card page. A player page shows the same
   * plaques *above* this component, outside the `<details>` that holds it, so that
   * they can be read without opening the grid — drawing them here too would print
   * the same four bars twice on one screen.
   */
  showDeckProgress?: boolean
  /**
   * How many cards across. Defaults to the six the grid is designed around, which is
   * what a caller with no scale control of its own should render — see the note on the
   * grid below.
   */
  columns?: number
  /**
   * A card-name filter. Empty means no filter, which is the whole grid.
   *
   * Passed in rather than owned here because the control lives beside the page's other
   * pickers, and because a query is transient: it should not survive navigating away,
   * which a preference inside this component would tempt somebody into making it do.
   */
  query?: string
}) {
  /*
   * What the filter leaves. Both memos key off the query alone — the card list is a
   * generated constant, so nothing else can change the answer.
   *
   * `visibleByDeck` is a map rather than a filter per deck inside the render, so the
   * sixty names are folded once per query instead of once per deck per render.
   */
  const found = useMemo(() => searchCards(cardsInGridOrder(), query), [query])
  const visibleDecks = useMemo(
    () => decksPresent(found.cards, cardCategoriesInOrder()),
    [found],
  )
  const visibleByDeck = useMemo(() => {
    const byDeck = new Map<CardCategory, GeneratedCard[]>()
    for (const card of found.cards) {
      const list = byDeck.get(card.category)
      if (list) list.push(card)
      else byDeck.set(card.category, [card])
    }
    return byDeck
  }, [found])

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
  /*
   * Kept in sync via a layout effect rather than a write during render — the
   * latter is what `react-hooks/refs` flags, since a render can be discarded and
   * this would have written anyway. `useLayoutEffect`, not `useEffect`: the two
   * readers, `commit` and the unmount cleanup below, run outside render and need
   * the draft *as it is now*, including an edit made while a save is already in
   * flight (`commit`'s save loop re-reads this on every iteration, not once at
   * the start) — a plain `useEffect` defers to after paint, which is exactly the
   * lag that would reopen. A layout effect runs synchronously in the same commit
   * as the render it followed, before the browser can process the next event, so
   * the timing this ref depends on is unchanged.
   */
  useLayoutEffect(() => {
    draftRef.current = draft
  }, [draft])

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
   * Leaving a cell. Saves the whole base if — and only if — a number really changed
   * since the last write, and reports at `cardId` if it did not take.
   *
   * `focusStaysInCell` is the tile saying focus only moved between its own three
   * controls, which is not leaving at all — `blurDecision` skips it, and that is what
   * keeps a run of `+` presses to one request.
   */
  async function commit(cardId: number, focusStaysInCell: boolean): Promise<void> {
    const decision = blurDecision({
      draft: draftRef.current,
      saved: savedRef.current,
      writable,
      saving: savingRef.current,
      focusStaysInCell,
    })
    if (!decision.save) return

    savingRef.current = true
    setSaving(true)
    setFailure(null)
    try {
      /*
       * A loop, so a count changed while the request was in flight is not dropped:
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
  }, [tag, writable])

  const summary = inventorySummary({ tag, counts: toCardCounts(draft) })
  const readOnlyReason = access.writable ? null : access.message

  /*
   * The plaques, read off the *draft* rather than the stored record so they agree
   * with the `10/60 cards` count printed directly above them while somebody is
   * typing. Nothing is recounted here: it is `summarizeBase` — the same function the
   * player page's plaques come from — handed this base as it currently stands on
   * screen, exactly as `inventorySummary` is handed it above. The real `updatedAt`
   * rides along so a base entered once and then cleared back to zero still reads as
   * recorded-and-empty rather than as never entered.
   */
  const sizes = useMemo(() => deckSizes(), [])
  const decks = useMemo(() => {
    if (!showDeckProgress) return []
    const canonical = normalizeTag(tag)
    const onScreen: BaseInventory = {
      tag: canonical,
      counts: toCardCounts(draft),
      ...(base?.updatedAt === undefined ? {} : { updatedAt: base.updatedAt }),
    }
    const stand = summarizeBase(canonical, [onScreen], categoryOfCard, cardCategoriesInOrder())
    if (!stand.recorded) return []
    return deckProgress(stand.byCategory, (category) => sizes.get(category))
  }, [showDeckProgress, tag, draft, base?.updatedAt, sizes])

  const headerClass = showDeckProgress ? 'card-header card-header--progress' : 'card-header'
  const toolsClass = showDeckProgress
    ? 'card-header__tools card-header__tools--progress'
    : 'card-header__tools'

  return (
    <>
      {/* The plaques make this header tall enough that the base name has to be
          allowed to take its own line rather than squeeze them — see styles.css. */}
      <div className={headerClass}>
        <h2 className="section-title" style={{ margin: 0 }}>
          {label}
        </h2>
        <div className={toolsClass}>
          <span className="card-meta">
            {summary.distinct}/{ALL_CARDS.length} cards · {summary.total} copies ·{' '}
            {summary.duplicates} spare{summary.duplicates === 1 ? '' : 's'}
          </span>
          {/* The only status left where the Save button was. It says what the form
              is doing, not what it wants you to do — there is nothing to press. */}
          <span className="card-meta" aria-live="polite">
            {/* "card", not "box": there is no box any more, a cell is the two steppers,
                and stepping between them is deliberately not a save — see `blurDecision`. */}
            {saving ? 'Saving…' : writable ? 'Counts save as you leave each card' : 'Read-only'}
          </span>
          {/* Beside the status rather than beside the heading, because the heading is
              a person's name and a `?` after somebody's name reads as a question about
              them. Both callers get it: the grid behaves identically on either page,
              so the explanation should be reachable from either. */}
          <HelpLink section="cards" topic="how the card grid works" />
          {/* The deck totals, on their own line under the count they break down —
              the header's tools box already wraps, which is what puts them there. */}
          <DeckPlaques decks={decks} />
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
              : 'Your typed counts are still here — change one and leave the card to try again.'}
          </p>
        </div>
      ) : null}

      {/*
       * One grid for all sixty, not one per deck. Still in deck order, so each
       * type arrives as an unbroken run of tiles wearing its own frame color —
       * which is now the only *visible* thing separating them, the drawn headings
       * and the gaps between them having gone. A single grid is the point: per-deck
       * grids broke the row wherever a deck ran out mid-line.
       *
       * The column count arrives as a custom property rather than a class per step:
       * the stylesheet keeps the geometry and only the one number comes from state,
       * which is the same division the face-crop framing uses. Six is the fallback in
       * CSS as well as in the default above, so the grid is right even if this value
       * never arrives.
       *
       * **Filtering removes tiles; it never reorders them.** A filtered grid is the
       * same layout with rows missing, so a card stays where you last saw it relative
       * to its neighbors. See `card-search.ts`.
       */}
      <div className="card-grid" style={{ '--card-columns': columns } as CSSProperties}>
        {visibleDecks.map((category) => {
          const headingId = `card-deck-${deckSlug(category)}`
          return (
            /*
             * The deck, as a named group. `display: contents` is what lets it name
             * a run of tiles without becoming a box: the tiles stay direct grid
             * items of the one grid above, so the geometry is byte-for-byte what it
             * is with no wrapper at all — measured, not assumed.
             *
             * It exists because the deck stopped being visible when the headings
             * went: the frame color is the only thing left drawing the boundary,
             * and color is not a cue this app leans on alone anywhere else. The
             * heading is the `.visually-hidden` recipe, so it names the group, it
             * is reachable by heading navigation, and it draws nothing.
             */
            <div key={category} className="card-deck" role="group" aria-labelledby={headingId}>
              <h3 id={headingId} className="visually-hidden">
                {category}
              </h3>
              {visibleByDeck.get(category)?.map((card) => (
                <CardEntryTile
                  key={card.id}
                  card={card}
                  count={draft.get(card.id) ?? 0}
                  onCount={(next) => setCount(card.id, next)}
                  onLeave={(focusStaysInCell) => void commit(card.id, focusStaysInCell)}
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
