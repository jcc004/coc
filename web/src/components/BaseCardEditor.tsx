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
 * Safari does not focus a clicked button by default — without forcing it on
 * `mousedown`, a blur-driven save can fire with nothing left focused to have
 * caused it. One function, not one copy per button, so a future fix to this
 * cannot be applied to only one of the tile's two controls and silently miss
 * the other.
 */
function focusOnMouseDown(event: { currentTarget: HTMLButtonElement }): void {
  event.currentTarget.focus()
}

/**
 * Steps `count` by `by`, and — if that lands the *other* end of the range at its
 * own bound — hands focus to `sibling` before that control can disable or unmount
 * out from under whatever was focused. One function for both directions, not one
 * copy per button: `StepButton`'s old single implementation did this for both `−`
 * and `+` from one place, and the two-sibling-button shape does not need two
 * copies of the same reasoning just because the two controls now look different.
 * A no-op if `by` is not itself legal from `count` — the caller's own render
 * condition is what keeps that from happening in practice, but this stays safe to
 * call regardless.
 */
function stepAndHandOff(
  count: number,
  by: 1 | -1,
  onCount: (next: number) => void,
  sibling: RefObject<HTMLButtonElement | null>,
): void {
  const to = cardCountStep(count, by)
  if (to === null) return
  if (cardCountStep(to, by) === null) sibling.current?.focus()
  onCount(to)
}

/**
 * The corner decrement control: a small red circle over the tile's upper-right
 * corner.
 *
 * It is not `StepButton`'s old `−` end reused verbatim — that lived in a row under
 * the frame, sized identically to its `+` sibling. This one overlays the picture
 * instead, at a much smaller footprint, which is a real usability question of its
 * own: see the CSS comment on `.card-entry-tile__minus` for the touch-target
 * measurement that shape forces and what was done about it.
 *
 * **Rendered whenever `cardCountStep(count, -1)` is legal at all — writable or
 * not.** That used to be conflated with `readOnlyReason === null`, which meant a
 * read-only base holding a card drew no `−` at all, identically to a writable base
 * holding none: a screen-reader user browsing a read-only base's controls could
 * not tell "you hold none of this" from "this base isn't yours" for a card whose
 * own badge shows it *is* held. The caller now renders this whenever there is a
 * copy to decrement, and this component itself decides whether that press is
 * actually allowed — `disabled`, with the same `, read-only` accessible-name
 * suffix `StepButton`'s old `−` used to carry, so a read-only base's held cards
 * show an inert-but-present control instead of an absent one indistinguishable
 * from "you have zero."
 */
function DecrementButton({
  card,
  count,
  onCount,
  buttonRef,
  siblingRef,
  readOnlyReason,
}: {
  card: (typeof ALL_CARDS)[number]
  count: number
  onCount: (next: number) => void
  /** This button's own node, so the tile-wide `+` can hand focus to it. */
  buttonRef: RefObject<HTMLButtonElement | null>
  /** The tile-wide `+` button, for the press that takes this one to disabled. */
  siblingRef: RefObject<HTMLButtonElement | null>
  /** Why this base cannot be typed into, or `null` when it can. */
  readOnlyReason: string | null
}) {
  const disabled = readOnlyReason !== null

  return (
    <button
      ref={buttonRef}
      type="button"
      className="card-entry-tile__minus"
      disabled={disabled}
      /* Unlike the tile-wide `+`'s own `title` (see the note there), nothing sits
         inside this button to steal the tooltip resolution — it carries only a
         decorative, `aria-hidden` glyph — so this one genuinely surfaces on
         hover. */
      title={readOnlyReason ?? undefined}
      aria-label={disabled ? `One fewer ${card.name}, read-only` : `One fewer ${card.name}`}
      onMouseDown={focusOnMouseDown}
      onClick={() => {
        if (disabled) return
        stepAndHandOff(count, -1, onCount, siblingRef)
      }}
    >
      <span aria-hidden="true">−</span>
    </button>
  )
}

/**
 * One card: tap the tile to add a copy, tap the small corner circle to remove one.
 *
 * The picture, the frame, the deck color and the desaturation are all `CardTile`,
 * shared with the clan-totals grid on the card page. What used to be a stepper row
 * under the frame — two same-sized buttons, `−` and `+` — is now two sibling
 * buttons wrapped around the tile instead: the whole tile for `+`, a small circle
 * over its corner for `−`. See "Two controls, in a new shape" below for the DOM
 * structure that makes that legal, and the paragraph after it for why this is not
 * the number-box/tap-to-edit-badge shape this grid already tried once and dropped.
 *
 * **There is still no way to type a count, at any tile width.** A number box, and
 * later a tap-to-edit badge, were each tried here and dropped — the record of why
 * is worth keeping rather than replacing, because the reasoning that killed those
 * two is not the reasoning this design has to answer to. Both of the old designs
 * put a *typed, arbitrary* number within reach: a box you could type `37` into, or
 * a badge doubling as a text field with its own hidden edit state — sixty of either
 * is what that reasoning was about. Neither exists here. The cap is still 10, a
 * press still moves the count by exactly one, and `cardCountStep` still decides
 * both whether a press is offered and where it lands, unchanged from the
 * two-button design — only *read* by two differently-shaped controls now instead
 * of two identically-shaped ones. What changed is the hit area a single-step press
 * has to land on — the whole tile for `+`, a corner circle for `−` — not the kind
 * of value a press can produce. A tap-to-edit badge would still be the rejected
 * shape if this design brought one back; making the *existing* tap surfaces bigger
 * and relocating one of them is a different change than that was.
 *
 * ## Two controls, in a new shape
 *
 * - **The whole tile is `+`.** Tapping anywhere on the card — the art, the frame,
 *   the badge's own dead space — adds one copy. `CardTile` itself is still not a
 *   button (see its own doc comment); the tile-wide press is a `<button>` that
 *   *wraps* it, the same resolving pattern the totals grid already established for
 *   "make `CardTile` pressable without making it a button itself" — see
 *   `CardsView.tsx`'s `CardTotalPick`. Nothing about `CardTile` changed to allow
 *   this: it is exactly as pressable-from-outside as it always was for that other
 *   caller, which is why `CardTile.tsx` needed no code change here, only its own
 *   doc comment brought up to date.
 * - **A small red circle over the upper-right corner is `−`, drawn whenever there
 *   is a copy to remove.** It is a sibling of the tile-wide button — a child of
 *   the positioning `<div>` this function returns, not a child of that button and
 *   not a child of `CardTile`. A `<button>` nested inside a `<button>` is not
 *   markup a browser will even keep, which `CardTile`'s own doc comment already
 *   names as the trap this grid has to design around now that it is the tile
 *   itself doing the wrapping. `.card-entry-tile__minus` is `position: absolute`
 *   in a `position: relative` wrapper, and it also carries an explicit
 *   `z-index: 1` — both are load-bearing, not just the first. `position: absolute`
 *   alone was checked in a real browser and found *not* sufficient:
 *   `.card-entry-tile` needs `container-type: inline-size` for this circle's own
 *   `cqi` sizing to have anything to measure against (see the CSS comment on
 *   `.card-entry-tile`), and that makes it a stacking context in its own right —
 *   inside which a bare `z-index: auto` on this circle did not reliably win
 *   hit-testing against `.card-entry-tile__hit`'s own nested `position: relative`
 *   descendant (`.card-tile__frame`). Measured before the `z-index` existed:
 *   `document.elementFromPoint()` at this circle's own center returned the art
 *   layer underneath it, so every tap silently incremented instead of
 *   decrementing — exactly the double-fire risk the paragraph below warns jsdom
 *   cannot catch, caught here only because it was checked in an actual browser
 *   rather than assumed from the stacking rules on paper. DOM order (this circle
 *   before the tile-wide button) is free to answer to something else — Tab
 *   order, see the comment there — because it is `z-index`, not DOM position,
 *   doing the stacking work now.
 * - **Which button renders is `cardCountStep`'s call, not a separate `count`
 *   comparison.** The corner circle used to be gated on `count > 0` while its own
 *   press was gated on `cardCountStep(count, -1) !== null` — the same fact,
 *   restated twice, on the same "one function, not a value and a duplicate check
 *   of it" reasoning `cardCountStep`'s own doc comment already gives for why a
 *   stepper's `disabled` state and its landing spot must be one answer. The two
 *   checks agree for every count a working entry grid ever produces, but `count`
 *   is `number`, not `0 | 1 | … | 10`, and `cardCountStep` truncates before it
 *   clamps — so a non-integer count in `(0, 1)`, however it got there, would have
 *   satisfied the old `count > 0` gate and rendered a circle whose own press then
 *   silently did nothing. `minusTo` below is computed once and used for both the
 *   render gate and the disabled reasoning, so the two cannot drift apart again.
 *
 * Sixty tiles times two controls is still 120 things a screen reader can land on,
 * and the naming is unchanged: `−` is **`One fewer Barbarian`**, `+` is
 * **`One more Barbarian`** — now announced by a whole-tile button and a small
 * corner one instead of two same-sized buttons in a row, but the same two
 * sentences either way, and now the same **disabled-not-absent** treatment on a
 * read-only base too — see `DecrementButton`'s own doc comment.
 *
 * **A failed write is announced at the button, not swallowed by it.** The old
 * design rendered `Not saved` as a plain child of `CardTile`, which was not
 * wrapped in anything with an accessible name of its own. Wrapping the tile in a
 * `<button aria-label="One more Barbarian">` changed that: an element with an
 * explicit accessible name excludes its own descendant text from what assistive
 * tech exposes, so the note, left where it was, would never be announced —
 * tabbing to a failed tile would say only "One more Barbarian, button" and leave a
 * screen-reader user believing the edit had saved. The note now renders as this
 * component's own sibling of the button, not the button's child, and the button
 * carries `aria-describedby` pointing at it when `failed` — so a screen reader
 * landing on the button by Tab announces the failure as part of what it says, and
 * one browsing the tile's own content meets the same sentence directly instead of
 * one hidden inside a labeled control's opaque subtree.
 *
 * Held-vs-not is unchanged: `--locked` desaturates the art, the badge prints the
 * exact count past a spare, and below that the grayscale is what is left to say
 * so — the same trade the totals grid already makes for every card on it.
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
  /* So a press that disables, or un-mounts, one of this cell's controls can hand
     focus to the other one rather than dropping it on `<body>` — see `stepAndHandOff`. */
  const minusRef = useRef<HTMLButtonElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)

  const minusTo = cardCountStep(count, -1)
  const plusTo = cardCountStep(count, 1)
  const plusDisabled = readOnlyReason !== null || plusTo === null
  /* One id, from the card rather than a generated one: each `CardEntryTile` in the
     grid is already one specific card, so `card.id` is unique across the sixty
     without a second id-generation scheme to keep in step with it. */
  const noteId = `card-entry-note-${card.id}`

  return (
    <div
      className="card-entry-tile"
      /*
       * The save, and the reason this wrapper is one element with one `onBlur`
       * rather than two independent buttons: **leaving the cell is the commit**,
       * not leaving one control. `focusout` bubbles, so one handler here sees
       * focus move off either button, and `relatedTarget` says where it went —
       * still inside this wrapper (the tile's own other control), or out. Pressing
       * `+` five times is one departure and one write; without this it would be
       * five writes of the whole base, each moving the `updated_at` the
       * attribution line above the grid reads out. The decision itself is
       * `blurDecision`, so the "a press is not a departure" skip sits with
       * `unchanged` and `busy` rather than being a second, quieter rule living in
       * here.
       */
      onBlur={(event) => onLeave(event.currentTarget.contains(event.relatedTarget))}
    >
      {/*
       * Placed *before* the tile-wide button in the DOM, not after — `position:
       * absolute` is what keeps this painted (and hit-tested) above the tile-wide
       * button regardless of which one comes first in markup, so this ordering is
       * free to answer to something else: Tab order. `StepButton`'s old row put
       * `−` before `+`, which made `+` the last stop in a cell and let a Tab off
       * it read as leaving for the next card — the "saves when focus moves on to
       * a different card" test in `BaseCardEditor.test.tsx` depends on exactly
       * that. Swap this order and a Tab off `+` would land back on this circle in
       * the *same* cell instead, which `blurDecision`'s `sameCell` rule reads as
       * not leaving at all.
       *
       * Rendered whenever there is a copy to remove, writable or not — see
       * `DecrementButton`'s own doc comment for why a read-only base's held cards
       * still draw this, disabled, rather than nothing at all.
       */}
      {minusTo !== null ? (
        <DecrementButton
          card={card}
          count={count}
          onCount={onCount}
          buttonRef={minusRef}
          siblingRef={plusRef}
          readOnlyReason={readOnlyReason}
        />
      ) : null}

      <button
        ref={plusRef}
        type="button"
        className="card-entry-tile__hit"
        disabled={plusDisabled}
        aria-label={
          readOnlyReason === null ? `One more ${card.name}` : `One more ${card.name}, read-only`
        }
        aria-describedby={failed ? noteId : undefined}
        onMouseDown={focusOnMouseDown}
        onClick={() => {
          if (plusDisabled) return
          stepAndHandOff(count, 1, onCount, minusRef)
        }}
      >
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
          // `--readonly` is the dimming a read-only base's held tiles need that a
          // capped-out-but-writable one does not — see the CSS comment on
          // `.card-tile--readonly`. The totals grid passes neither this nor
          // `--failed`, so both stay additive to its usage of `CardTile`, never a
          // change to it. No entry-grid-only clearance under the frame any more:
          // the badge is allowed to hang past the border here the same way it
          // already does on the totals grid — see `.card-tile`'s own comment on
          // the padding both grids share.
          className={`${readOnlyReason !== null ? 'card-tile--readonly ' : ''}${failed ? 'card-tile--failed' : ''}`.trim()}
        />
      </button>

      {/* A sibling of the button, not its child — see this component's own doc
          comment on why an aria-labeled button would otherwise swallow this from
          assistive tech. `aria-describedby` above is what still reaches a
          screen-reader user tabbing straight to the button. */}
      {failed ? (
        <span id={noteId} className="card-tile__note">
          Not saved
        </span>
      ) : null}
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
