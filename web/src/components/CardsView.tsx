import { useEffect, useMemo, useState } from 'react'
import { CARD_SEASON, type BaseInventory, type SessionUser } from '@coc/shared'
import { api } from '../api.ts'
import { baseOptions } from '../base-names.ts'
import { baseOwnerOf } from '../card-entry.ts'
import { inventoryFor, useCardInventoryState } from '../card-inventory.ts'
import {
  groupTradesByPair,
  suggestTrades,
  tradeProposalMessage,
  type TradeSuggestion,
} from '../card-trades.ts'
import { cardById, categoryOfCard } from '../cards.ts'
import { requestChatDraft } from '../chat-draft.ts'
import { hrefFor } from '../hooks.ts'
import { ownerRecordFor, useOwners } from '../owners.ts'
import { useSavedClans } from '../saved-clans.ts'
import { BaseCardEditor } from './BaseCardEditor.tsx'
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
 * both pure and both tested. This file is the base picker, the trade panel, and
 * reporting failures at the control that caused them; the 60-tile grid and its
 * entry form are `BaseCardEditor`, shared with the player page, which shows the
 * same grid for the one base it is already about.
 */

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

export function CardsView({ user }: { user: SessionUser }) {
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
        ) : null}
      </section>

      {active !== null ? (
        <section className="card">
          <BaseCardEditor
            key={active}
            tag={active}
            label={labelOf(active)}
            base={inventoryFor(bases, active)}
            /* Only the *owner* of the chosen base may type into the grid, so the
               editor is handed that base's assignment rather than being left to
               guess from the label beside it. */
            owner={baseOwnerOf(ownerRecordFor(owners, active))}
            user={user}
            /* The four deck plaques, under the count line in the header. Only here:
               the player page draws its own above the panel that holds this grid. */
            showDeckProgress
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
