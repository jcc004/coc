import { MAX_CARD_COUNT, MIN_TRADEABLE_COUNT } from '@coc/shared'
import { cardPoints } from '../card-standings.ts'
import { ALL_CARDS } from '../cards.ts'
import { formatFull } from '../format.ts'

/**
 * The rules, written once.
 *
 * Every block here is reachable from **two** places: a collapsed disclosure under
 * the panel it governs, and the matching section of `HelpView`. That is the whole
 * reason the file exists — several of these sentences used to live inside an
 * empty-state branch, so the explanation vanished at exactly the moment the panel
 * filled with data somebody might be confused by. Making them permanently
 * reachable meant rendering them twice, and copy rendered twice is copy that
 * drifts, so it is a component apiece rather than a paragraph apiece.
 *
 * These are *fragments*, not sections: no headings, no wrappers, no margins of
 * their own. The caller supplies the container — a `.group__body` inline, a
 * `.help-prose` section on the help page — and the `.empty-hint` class on each
 * paragraph is what the rest of the app already uses for explanatory text.
 *
 * **The numbers are computed, never typed.** `MIN_TRADEABLE_COUNT`, the 0–10 cap,
 * the sixty cards and the points curve all come from the modules that enforce
 * them, so raising a cap cannot leave a paragraph quietly lying about it.
 */

/* ---------- the card event ---------- */

export function CardEntryRules() {
  return (
    <>
      <p className="empty-hint">
        The event ships <strong>{ALL_CARDS.length} cards in four decks</strong>. Supercell's API
        exposes nothing at all about it, so <strong>every count here is typed in by hand</strong>{' '}
        off somebody's own screen. There is nothing to refresh from: what is stored is whatever a
        person last entered, and the only defense against a wrong number is that everybody can see
        it and see who entered it.
      </p>
      <p className="empty-hint">
        A tile shows its picture in color when the base holds at least one, and the same picture
        in gray when it holds none — but that is never the only cue: the box under the art reads 0
        or the number held at every screen width. A <strong>×n badge</strong> appears in the art's
        corner only past one copy, because a spare is the fact worth spotting and ×1 on fifty tiles
        would be noise.
      </p>
      <p className="empty-hint">
        Each box takes <strong>0 to {MAX_CARD_COUNT}</strong>. There is no Save button:{' '}
        <strong>leaving a box is the save</strong>, and it writes the whole base in one request. A
        box you did not change writes nothing, so tabbing across the grid does not keep claiming
        somebody checked the base. A save that failed says so at the tile and leaves your number on
        screen.
      </p>
      <p className="empty-hint">
        A base <strong>nobody has ever saved</strong> says so rather than showing sixty zeroes — a
        base that has never been checked is a different thing from a base that was checked and
        holds nothing. Saving a base with nothing on it is a real check and is recorded as one.
      </p>
    </>
  )
}

/* ---------- ownership ---------- */

export function OwnershipRules() {
  return (
    <>
      <p className="empty-hint">
        Owning a base is <strong>an account</strong>, not a name. A base whose Owner column carries
        only text somebody typed in — the roster marks those <strong>not an account</strong> —
        grants nobody anything, including the right to edit that base's card counts. The label is
        the only record of whose base it is in real life, so it is kept and shown; it is simply not
        a permission.
      </p>
      <p className="empty-hint">
        <strong>Only the owning account, or an admin, can type a base's card counts.</strong> A
        base with no owner, and a base carrying only an unlinked label, are both admin-writable
        only — nobody else has a claim to them. Somebody refused at the grid is told who to ask
        rather than just told no.
      </p>
      <p className="empty-hint">
        <strong>Only an admin assigns an owner.</strong> Ownership decides who may write a base, so
        a member who could reassign a base could grant themselves that write, which would make it
        not a permission at all. The place to do it is the <strong>Owner</strong> column on the clan
        page, which for an admin is a picker over the accounts on the install. <strong>Mine</strong>{' '}
        on the card page means the same field, so what the picker offers you and what you may write
        cannot come apart.
      </p>
    </>
  )
}

/* ---------- suggestions ---------- */

export function SwapRules() {
  return (
    <>
      <p className="empty-hint">
        A suggestion is <strong>arithmetic over the counts as they stand</strong> — recomputed on
        every render and stored nowhere. It answers "what could we swap", and it is true only for as
        long as the numbers behind it are.
      </p>
      <p className="empty-hint">A swap is legal when all four of these hold:</p>
      <ul className="rule-list">
        <li>
          the giver holds <strong>{MIN_TRADEABLE_COUNT} or more</strong> of the card it gives — a
          base never trades away its last copy, which is the rule people get wrong by hand;
        </li>
        <li>
          the receiver holds <strong>none</strong> of it — a second copy of something you already
          have is worth nothing to you;
        </li>
        <li>
          both cards are in the <strong>same deck</strong>, because the game only swaps within one;
        </li>
        <li>
          and it is <strong>two different bases</strong>.
        </li>
      </ul>
      <p className="empty-hint">
        All four apply <strong>in both directions</strong>: this is a swap, not a gift, so each side
        gives one card and receives one. A pair is listed once however the two bases are named, one
        pair can offer several options, and one spare can appear against several partners — so each
        row is an option to choose between, not a plan. Pick one per card.
      </p>
      <p className="empty-hint">
        <strong>Propose records the swap and stops. No cards move.</strong> It puts the swap on the
        trade tracker for the other member to act on. You must own one of the two bases, or be an
        admin: proposing a swap between two other people's bases is putting words in their mouths.
      </p>
    </>
  )
}

/* ---------- the tracker ---------- */

export function TradeResolutionRules() {
  return (
    <>
      <p className="empty-hint">
        A trade is a <strong>stored agreement</strong> between two bases, visible to everybody —
        which is what a suggestion is not. Proposing one moves nothing; resolving it is what has
        consequences.
      </p>
      <p className="empty-hint">
        <strong>Either owner, or an admin, can complete or decline it.</strong> A trade belongs to
        both bases, so it is not the per-base owner rule: completing one writes to two bases, and
        the authorization for both writes is the trade record itself. A base carrying only an
        unlinked text label is an admin's to resolve until an admin links it to an account.
      </p>
      <p className="empty-hint">
        <strong>Complete moves one card each way on both bases — immediately, for everyone, and it
        cannot be undone from here.</strong> That is why it asks first. <strong>Decline</strong>{' '}
        closes the trade and moves nothing, so it does not ask. A trade is{' '}
        <strong>resolved once</strong>: re-completing would move the same two cards a second time.
      </p>
      <p className="empty-hint">
        The rule is checked again <strong>at completion, against the counts as they are then</strong>{' '}
        — not against the ones the proposal was drawn from. If a giver is down to one copy, or a
        receiver already holds the maximum {MAX_CARD_COUNT}, the trade is refused, the message says
        which side moved, and nothing at all is written. A proposal is deliberately not re-checked
        when it is made: somebody who has just looked at their cards knows more than the table does.
      </p>
      <p className="empty-hint">
        Pending trades come first however old they are, oldest first, because a swap that has been
        waiting three days is the one being forgotten; resolved rows read newest first. Every row
        names <strong>both</strong> events — who proposed it and when, and who resolved it and when.
      </p>
    </>
  )
}

/* ---------- the leaderboard ---------- */

/** The worth of the nth copy, from the function that scores it. Never typed out. */
function worthOfCopy(copy: number): number {
  return cardPoints(copy) - cardPoints(copy - 1)
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th']

export function ScoringRules() {
  const perfect = ALL_CARDS.length * cardPoints(MAX_CARD_COUNT)

  return (
    <>
      <p className="empty-hint">
        The board ranks on <strong>points</strong>, awarded per card by how many copies the base
        holds. The first copy of a card is worth the most and each further copy is worth less:
      </p>
      <ul className="points-curve">
        {ORDINALS.map((ordinal, index) => (
          <li key={ordinal}>
            <span className="points-curve__copy">{ordinal} copy</span>
            <span className="points-curve__worth">{worthOfCopy(index + 1)}</span>
          </li>
        ))}
      </ul>
      <p className="empty-hint">
        Every copy past the {ORDINALS[MAX_CARD_COUNT - 1]} is worth{' '}
        {worthOfCopy(MAX_CARD_COUNT + 1)} as well. So a card held once scores {cardPoints(1)},
        twice {cardPoints(2)}, three times {cardPoints(3)}, and {MAX_CARD_COUNT} times{' '}
        {cardPoints(MAX_CARD_COUNT)} — and all {ALL_CARDS.length} at the cap is{' '}
        {formatFull(perfect)}.
      </p>
      <p className="empty-hint">
        The point of the curve is that the first copy of a card you lack is worth ten times the
        eleventh copy of one you have, so <strong>breadth beats hoarding</strong> — while spares
        still count, because spares are what make a trade possible at all.
      </p>
      <p className="empty-hint">
        Level on points, more distinct cards goes first; level on both, by name and then tag, so the
        order never reshuffles between renders. A rank is <strong>shared on a genuine tie</strong>{' '}
        and then skips (1, 2, 2, 4) — two bases separated by nothing but their names have not
        out-collected one another. The rank is worked out over the whole board, so page 2 opens at 6
        and reads 6.
      </p>
      <p className="empty-hint">
        The board is the <strong>whole clan</strong> and is not affected by the{' '}
        <strong>Show</strong> filter: a leaderboard of one base answers nothing. A base nobody has
        ever saved stays on it, last, and says so rather than printing a score.
      </p>
    </>
  )
}

/* ---------- shared data ---------- */

export function SharedDataRules() {
  return (
    <>
      <p className="empty-hint">
        There is <strong>one dataset for every account</strong>, not a copy each. The saved clans,
        the owner assignments, the card counts and the trades are all shared, and every signed-in
        account reads all of them. That is the point of the exercise: ten people looking at the same
        clan need one canonical answer to "who owns this base", and per-user copies give ten answers
        with no way to reconcile them.
      </p>
      <p className="empty-hint">
        So <strong>Remove means for everyone</strong> — removing a saved clan removes it from
        everybody's list, and clearing an owner clears it for the group.
      </p>
      <p className="empty-hint">
        Every stored row records <strong>who last changed it and when</strong>, and those are shown.
        The name is looked up fresh, so renaming an account never leaves old edits credited to a
        stale name; deleting an account keeps the row and loses only the credit, because the data
        outlives the account that entered it.
      </p>
    </>
  )
}
