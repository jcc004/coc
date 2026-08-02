import { useEffect, useMemo, useState } from 'react'
import { CARD_SEASON, MAX_CARD_COUNT, type BaseInventory } from '@coc/shared'
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
 * One card. The art carries the held/not distinction as colour, and the count
 * carries it again as text — never colour alone. The badge appears only past one
 * copy, which is exactly when the number is news; `--locked` desaturates the art
 * for a card the base does not hold.
 *
 * `GameIcon` is used without a `fallback` on purpose. The card art is gitignored,
 * so a fresh clone has none of it; the element removes itself on error rather
 * than showing a broken-image glyph, and the fixed-height art box keeps the tile
 * the same size either way, so the grid cannot collapse. The name is always
 * rendered, which is what keeps the card identifiable with no picture at all.
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
  const inputId = `card-count-${card.id}`

  return (
    <div
      className={held ? 'card-tile' : 'card-tile card-tile--locked'}
      // The deck's frame colour is picked in CSS off this, so the palette stays
      // in styles.css with the rest of the theme rather than inline here.
      data-deck={deckSlug(card.category)}
    >
      <div className="card-tile__frame">
        <GameIcon src={card.image} className="card-tile__art" />
        {count > 1 ? (
          <span className="card-tile__badge" aria-hidden="true">
            ×{count}
          </span>
        ) : null}
      </div>

      <label className="card-tile__name" htmlFor={inputId}>
        {card.name}
      </label>
      {/* The text half of the encoding: readable with no colour vision at all. */}
      <span className="card-tile__state">{held ? `Have ${count}` : 'None'}</span>

      <input
        id={inputId}
        className="card-tile__input"
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_CARD_COUNT}
        value={String(count)}
        disabled={disabled}
        onChange={(event) => onCount(clampCardCount(event.target.value))}
        aria-label={`${card.name} copies held, 0 to ${MAX_CARD_COUNT}`}
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
function BaseEditor({ tag, base }: { tag: string; base: BaseInventory | undefined }) {
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
          {tag}
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

      {cardCategoriesInOrder().map((category) => (
        <section key={category} className="card-deck">
          <h3 className="card-deck__title">{category}</h3>
          <div className="card-grid">
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
        </section>
      ))}
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

  const [selected, setSelected] = useState<string | null>(null)
  // Default to the first base once the lists arrive, without pinning the choice
  // if the user has already made one.
  const active = selected !== null && tags.includes(selected) ? selected : (tags[0] ?? null)

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
                  {tags.map((tag) => {
                    const owner = ownerOf(tag)
                    return (
                      <option key={tag} value={tag}>
                        {owner ? `${tag} — ${owner}` : tag}
                      </option>
                    )
                  })}
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
          <BaseEditor key={active} tag={active} base={inventoryFor(bases, active)} />
        </section>
      ) : null}

      <section className="card">
        <h2 className="section-title">Trade suggestions</h2>
        <TradeSuggestions bases={bases} ownerOf={ownerOf} />
      </section>
    </>
  )
}
