import { useEffect, useMemo, useState } from 'react'
import { CARD_SEASON, MAX_CARD_COUNT, type BaseInventory } from '@coc/shared'
import { api } from '../api.ts'
import { baseOptions } from '../base-names.ts'
import { inventoryFor, saveBaseCounts, useCardInventoryState } from '../card-inventory.ts'
import {
  groupTradesByPair,
  suggestTrades,
  tradeProposalMessage,
  type TradeSuggestion,
} from '../card-trades.ts'
import {
  ALL_CARDS,
  cardById,
  cardCategoriesInOrder,
  cardsInCategory,
  categoryOfCard,
  clampCardCount,
  countMap,
  deckSlug,
  inventorySummary,
  toCardCounts,
} from '../cards.ts'
import { requestChatDraft } from '../chat-draft.ts'
import { formatDateTime } from '../format.ts'
import { hrefFor } from '../hooks.ts'
import { useOwners } from '../owners.ts'
import { useSavedClans } from '../saved-clans.ts'
import { ErrorPanel, GameIcon, Loading } from './primitives.tsx'

/**
 * The card-collecting event: who holds what, and who should trade with whom.
 *
 * The bases are `owner_assignments` — the set of player tags the group already
 * tracks — so there is no second list of bases to curate and drift. The owner is
 * shown beside every base because the owner is the person who would do the
 * trading; a tag on its own tells you nothing about who to message.
 *
 * All the rules live in `card-trades.ts` and all the card shaping in `cards.ts`,
 * both pure and both tested. This file is layout, local edit state, and reporting
 * failures at the control that caused them.
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
 * from: it is on the tile's `title` for a hover or a long press, and it opens the
 * input's accessible name, so nothing that reads this page aloud has lost it.
 *
 * Held-vs-not is still not carried by colour alone. `--locked` desaturates the
 * art, and the words underneath say "None" or "Have n" independently of it, with
 * the number box repeating it a third time.
 *
 * `GameIcon` is used without a `fallback` on purpose. The card art is gitignored,
 * so a fresh clone has none of it; the element removes itself on error rather
 * than showing a broken-image glyph, and the fixed-height art box keeps the tile
 * the same size either way, so the grid cannot collapse. Without the name label a
 * checkout with no art shows an empty frame over its count — the `title` and the
 * input's label are then the only way to tell the sixty tiles apart, which is the
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
      // Names the tile now that no text does. The category rides along because
      // the decks lost their headings too, leaving the frame colour as the only
      // visible grouping.
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
function BaseEditor({
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
       * which is now the only visible thing separating them, the headings and the
       * gaps between them having gone. A single grid is the point: per-deck grids
       * broke the row wherever a deck ran out mid-line.
       */}
      <div className="card-grid">
        {cardCategoriesInOrder()
          .flatMap((category) => cardsInCategory(category))
          .map((card) => (
            <CardTile
              key={card.id}
              card={card}
              count={draft.get(card.id) ?? 0}
              onCount={(next) => setCount(card.id, next)}
              disabled={busy}
            />
          ))}
      </div>
    </>
  )
}

/** One side of a suggested swap: the card, named, with its picture if we have it. */
function TradeCard({ cardId }: { cardId: number }) {
  const card = cardById(cardId)
  if (!card) return <>Card {cardId}</>
  return (
    <span className="trade-card">
      <GameIcon src={card.image} className="trade-card__img" />
      {card.name}
    </span>
  )
}

/**
 * Loads a proposal into the chat composer in the sidebar.
 *
 * It fills the box; it does **not** post. A suggestion is a draft by definition —
 * the owners may want to change the wording, or say when — and a button that
 * silently posted to the group channel would be a nasty surprise. The label says
 * "Propose", the composer's own Send button is what sends, and the confirmation
 * below is about the composer, never about a message having gone out.
 */
function ProposeButton({
  trade,
  ownerOf,
}: {
  trade: TradeSuggestion
  ownerOf: (tag: string) => string | undefined
}) {
  const [offered, setOffered] = useState(false)

  return (
    <button
      type="button"
      className="chip"
      onClick={() => {
        requestChatDraft(
          tradeProposalMessage(trade, {
            cardName: (id) => cardById(id)?.name,
            owner: ownerOf,
          }),
        )
        setOffered(true)
      }}
      title="Put this proposal in the chat box — you still press Send"
    >
      {offered ? 'In chat box ↗' : 'Propose in chat'}
    </button>
  )
}

/**
 * Every swap the current counts allow, grouped by the pair of bases involved.
 *
 * The rules are entirely in `suggestTrades`; this only renders them, and names
 * the owners, because "#2GCJ2QPU should talk to #AAABBB" is not actionable until
 * you know that means Jared should talk to Sam.
 */
function TradeSuggestions({
  bases,
  ownerOf,
}: {
  bases: BaseInventory[]
  ownerOf: (tag: string) => string | undefined
}) {
  const pairs = useMemo(
    () => groupTradesByPair(suggestTrades(bases, categoryOfCard)),
    [bases],
  )

  if (pairs.length === 0) {
    return (
      <p className="empty-hint">
        No trades available yet. A swap needs one base holding <strong>two or more</strong> of a
        card the other has <strong>none</strong> of, in <strong>both</strong> directions, within one
        category.
      </p>
    )
  }

  return (
    <>
      <div className="table-wrap">
        {/* Stacks into one labelled card per swap on a phone; the explicit roles
            keep it a table for assistive tech once `display` changes. Nothing
            sorts, so the header row is hidden there rather than kept — see the
            note in styles.css. */}
        <table className="roster roster--stack" role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader">Base</th>
              <th role="columnheader">Gives</th>
              <th role="columnheader">Base</th>
              <th role="columnheader">Gives</th>
              <th role="columnheader">Category</th>
              <th role="columnheader" />
            </tr>
          </thead>
          <tbody role="rowgroup">
            {pairs.flatMap((pair) =>
              pair.trades.map((trade, index) => (
                <tr
                  key={`${trade.baseA}-${trade.baseB}-${trade.cardFromA}-${trade.cardFromB}`}
                  role="row"
                  /*
                   * Marks where one pair's block of options begins, so the wide
                   * table can rule a line above it. Without that, a continuation
                   * row's empty Base cells read as missing data rather than as
                   * "same two bases as above" — seen in a screenshot, where the
                   * second option rendered as a bare "Minion / Hog Rider" row
                   * with nobody's name on it.
                   */
                  data-pair-start={index === 0 ? 'true' : undefined}
                >
                  {/* The pair is named once per group; the rows under it are its
                      options. A cell for a later row is genuinely empty, which is
                      how the stacked layout knows to drop the line rather than
                      print a blank one. */}
                  <td className="stack-title" role="cell">
                    {index === 0 ? <BaseLabel tag={pair.baseA} owner={ownerOf(pair.baseA)} /> : null}
                  </td>
                  {/*
                   * Stacked, a row is its own card, so a later option in a pair has
                   * no base named above it and two bare "Gives" lines would not say
                   * whose. Those rows name the base in the label instead; the first
                   * does not need to, because the base is the line above it.
                   */}
                  <td role="cell" data-label={index === 0 ? 'Gives' : `${pair.baseA} gives`}>
                    <TradeCard cardId={trade.cardFromA} />
                  </td>
                  <td className="stack-title" role="cell">
                    {index === 0 ? <BaseLabel tag={pair.baseB} owner={ownerOf(pair.baseB)} /> : null}
                  </td>
                  <td role="cell" data-label={index === 0 ? 'Gives' : `${pair.baseB} gives`}>
                    <TradeCard cardId={trade.cardFromB} />
                  </td>
                  <td className="card-meta" role="cell" data-label="Category">
                    {trade.category}
                  </td>
                  <td className="row-actions" role="cell">
                    <ProposeButton trade={trade} ownerOf={ownerOf} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
        {pairs.length} pair{pairs.length === 1 ? '' : 's'} could trade. Each row is one option, not
        a commitment — one spare can appear against several partners, so pick one per card and
        re-enter the counts afterwards. <strong>Propose in chat</strong> writes the swap into the
        chat box in the sidebar for you to edit; nothing is posted until you press Send.
      </p>
    </>
  )
}

function BaseLabel({ tag, owner }: { tag: string; owner: string | undefined }) {
  return (
    <>
      <a href={hrefFor({ view: 'player', tag })}>{tag}</a>
      <br />
      <span className="card-meta">{owner ?? 'no owner set'}</span>
    </>
  )
}

/**
 * Member names for every base, keyed by player tag.
 *
 * A base *is* a clan member, so the name to show is the one the roster shows. The
 * saved clans are where the owner assignments came from in the first place, so
 * their rosters are where the names are: one request per saved clan covers every
 * base in it, rather than one request per base.
 *
 * Sequential, like the saved-clans refresh, to keep the upstream rate limit
 * comfortable. A clan that will not load simply leaves its members unnamed — the
 * base falls back to its tag and the page carries on, because a name is a
 * convenience and the tag is the identity.
 */
function useMemberNames(baseTags: string[]): Map<string, string> {
  const clans = useSavedClans()
  /* Joined into strings so the effect re-runs on a change of *which* clans or
     bases, not on every re-render of the stores' arrays. */
  const clanKey = useMemo(() => clans.map((clan) => clan.tag).sort().join(','), [clans])
  const baseKey = useMemo(() => [...baseTags].sort().join(','), [baseTags])
  const [names, setNames] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!baseKey) return
    const controller = new AbortController()

    void (async () => {
      const found = new Map<string, string>()

      for (const clanTag of clanKey ? clanKey.split(',') : []) {
        try {
          const { items } = await api.clanMembers(clanTag, controller.signal)
          for (const member of items) found.set(member.tag, member.name)
        } catch {
          // Unnamed is a fine outcome; failing the whole page is not.
        }
      }

      /*
       * Anything the rosters did not cover, asked for directly. A base only has
       * to be in a *saved* clan for the sweep above to name it, and an owner can
       * be set on a base whose clan nobody saved — or who has since left. One
       * request each, and only for the leftovers, so the common case still costs
       * one request per clan rather than one per base.
       */
      for (const tag of baseKey.split(',')) {
        if (found.has(tag) || controller.signal.aborted) continue
        try {
          const player = await api.player(tag, controller.signal)
          found.set(tag, player.name)
        } catch {
          // A tag the API will not resolve keeps showing as a tag.
        }
      }

      if (!controller.signal.aborted) setNames(found)
    })()

    return () => controller.abort()
  }, [clanKey, baseKey])

  return names
}

export function CardsView() {
  const state = useCardInventoryState()
  const bases = state.entries
  const owners = useOwners()

  /*
   * The bases are the tracked owner assignments, not the bases that happen to
   * have counts — otherwise a base nobody had entered yet could never be chosen,
   * and the entry screen would have nothing to start from. Any base that somehow
   * has counts without an assignment is added so its rows are never orphaned off
   * the screen entirely.
   */
  const tags = useMemo(() => {
    const all = new Set(owners.map((entry) => entry.tag))
    for (const base of bases) all.add(base.tag)
    return [...all].sort()
  }, [owners, bases])

  const ownerOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.owner]))
    return (tag: string) => byTag.get(tag)
  }, [owners])

  /* The list the Base select offers: member names, ordered by name, with a tag
     appended only where two bases would otherwise read identically. */
  const memberNames = useMemberNames(tags)
  const options = useMemo(
    () => baseOptions(tags.map((tag) => ({ tag, name: memberNames.get(tag) }))),
    [tags, memberNames],
  )
  const labelOf = useMemo(() => {
    const byTag = new Map(options.map((option) => [option.tag, option.label]))
    return (tag: string) => byTag.get(tag) ?? tag
  }, [options])

  const [selected, setSelected] = useState<string | null>(null)
  /* Default to the first base once the lists arrive, without pinning the choice
     if the user has already made one. `options[0]`, not `tags[0]`: the list is
     ordered by member name, and defaulting by tag would leave the select showing
     its second or third entry as the chosen one. */
  const active =
    selected !== null && tags.includes(selected) ? selected : (options[0]?.tag ?? null)

  return (
    <>
      <section className="card">
        <div className="card-header">
          <h2 className="section-title" style={{ margin: 0 }}>
            Card collection · {CARD_SEASON}
          </h2>
          <div className="card-header__tools">
            {tags.length > 0 ? (
              <label className="row-limit" htmlFor="cards-base">
                Base
                <select
                  id="cards-base"
                  value={active ?? ''}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {options.map((option) => (
                    <option key={option.tag} value={option.tag}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>

        {state.status === 'error' && state.error ? <ErrorPanel error={state.error} /> : null}

        {tags.length === 0 && state.status === 'loading' ? (
          <Loading what="card counts" />
        ) : tags.length === 0 ? (
          <p className="empty-hint">
            No bases to track yet. Card counts hang off the <strong>owner assignments</strong> —
            open a clan and set an owner on a member, and that base appears here.
          </p>
        ) : (
          <p className="empty-hint" style={{ fontSize: 13 }}>
            Counts are <strong>shared</strong> — everyone signed in sees and edits the same ones,
            and there is no API for this, so every number is typed in by hand. The last write to a
            base wins, which is why each one says when it changed and who changed it.
          </p>
        )}
      </section>

      {active !== null ? (
        <section className="card">
          <BaseEditor
            key={active}
            tag={active}
            label={labelOf(active)}
            base={inventoryFor(bases, active)}
          />
        </section>
      ) : null}

      <section className="card">
        <h2 className="section-title">Trade suggestions</h2>
        <TradeSuggestions bases={bases} ownerOf={ownerOf} />
      </section>
    </>
  )
}
