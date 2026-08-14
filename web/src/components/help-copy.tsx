import { MAX_CARD_COUNT, MIN_TRADEABLE_COUNT } from '@coc/shared'
import { RARITY_TIER_COUNT } from '../card-rarity.ts'
import { cardPoints } from '../card-standings.ts'
import { ALL_CARDS } from '../cards.ts'
import { formatFull } from '../format.ts'
import { ROW_SIZE } from '../row-standings.ts'

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
      <p className="empty-hint">A swap is legal when all of these hold:</p>
      <ul className="rule-list">
        <li>
          the giver holds <strong>{MIN_TRADEABLE_COUNT} or more</strong> of the card it gives — a
          base never trades away its last copy, which is the rule people get wrong by hand;
        </li>
        <li>
          at least <strong>one</strong> side holds none of what it would receive — otherwise
          neither base gains a new card, and there is no point offering it;
        </li>
        <li>
          both cards are in the <strong>same deck</strong>, because the game only swaps within one;
        </li>
        <li>
          and it is <strong>two different bases</strong>.
        </li>
      </ul>
      <p className="empty-hint">
        This is a swap, not a gift, so each side still gives one card and receives one — the rule
        that changed is only <strong>which</strong> side has to actually need it. If you have a
        spare and are missing something else in the same deck, you can propose that swap, and
        whoever accepts may already own the card coming back the other way — completing it just
        won't gain <em>them</em> a new card. A row like that carries a small{' '}
        <strong>One-sided</strong> tag next to its deck, and sorts below the swaps that gain both
        sides something new — a real, completable trade, just a lower-priority one. The{' '}
        <strong>Sides</strong> filter above the table hides these by default; switch it to{' '}
        <strong>One-sided</strong> or <strong>Both</strong> to see them. A pair is listed once
        however the two bases are named, one pair can offer several options, and one spare can
        appear against several partners — so each row is an option to choose between, not a plan.
        Pick one per card.
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
        <strong>Complete moves one card each way on both bases — immediately, for everyone.</strong>{' '}
        <strong>Decline</strong> closes the trade and moves nothing. Neither asks for confirmation
        first. A trade is <strong>resolved once</strong>: re-completing would move the same two
        cards a second time.
      </p>
      <p className="empty-hint">
        The rule is checked again <strong>at completion, against the counts as they are then</strong>{' '}
        — not against the ones the proposal was drawn from. If a giver is down to one copy, or a
        receiver already holds the maximum {MAX_CARD_COUNT}, the trade is refused, the message says
        which side moved, and nothing at all is written. A proposal is deliberately not re-checked
        when it is made: somebody who has just looked at their cards knows more than the table does.
      </p>
      <p className="empty-hint">
        <strong>Either owner, or an admin, can also undo a completed trade</strong>, moving the two
        cards back — this used to be an admin's alone, but it is no longer a special case: undoing
        follows the same "either owner, or an admin" rule as completing and declining above.
        <strong> Undo is the one action that still asks first</strong>, though — reopening a trade
        is rarer, and reverses something that already happened. It is checked again the same way
        completing is, against the counts as they are at that moment, except the floor that stops a
        voluntary trade giving away a last copy does not apply: undoing is a correction, not a
        trade, so it may bring a base back to none of a card. Undoing does not rewrite who
        completed the trade or when — it is a third event, recorded beside the first two, not
        instead of the second.
      </p>
      <p className="empty-hint">
        Pending trades come first however old they are, oldest first, because a swap that has been
        waiting three days is the one being forgotten; resolved rows read newest first. Every row
        names <strong>every</strong> event that has happened to it — who proposed it and when, who
        resolved it and when, and, if it was later undone, who undid it and when.
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

export function RarityScoringRules() {
  return (
    <>
      <p className="empty-hint">
        A second axis beside the points board, sitting next to it rather than replacing it: instead
        of rewarding depth, it rewards <strong>breadth of scarcity</strong>. A base scores once per
        distinct card it holds at least one copy of, weighted by how scarce that card is{' '}
        <strong>across the whole clan right now</strong> — a tenth copy of a card already held adds
        nothing here, which is exactly what the points board already rewards.
      </p>
      <p className="empty-hint">
        Scarcity is recomputed live off current holdings, split into {RARITY_TIER_COUNT} equal-sized
        tiers from rarest to most common. As the clan collects more of a card it can drift into a
        more common tier and score less than it did last week — this board reads the clan's
        holdings as they stand today, not a fixed table.
      </p>
      <p className="empty-hint">
        Level on rarity score, more distinct cards held overall goes first; level on both, by name
        and then tag. A rank is <strong>shared on a genuine tie</strong> and then skips, the same
        rule the points board uses.
      </p>
    </>
  )
}

export function CategoryScoringRules() {
  return (
    <>
      <p className="empty-hint">
        Ranked by <strong>distinct cards held within the chosen deck</strong>, not points — the
        reverse of the Overall board. Choose a deck below the picker to see that deck's own ranking,
        computed <strong>separately for each of the four decks</strong> so a base's Elixir hoard
        cannot carry it up the Dark Elixir board, or the reverse.
      </p>
      <p className="empty-hint">
        More of the chosen deck's cards goes first, whatever the points. Between two bases holding
        the deck outright, a <strong>doubled</strong> deck — every card in it held at least twice,
        shown as a <strong>×2</strong> beside the fraction — goes first; the same points curve as
        the Overall board only breaks a tie once distinct and doubled both agree. Confined to one
        deck, points can disagree outright with "how close is this base to finishing it" — a few
        spares can out-point a base one card short of complete — so completeness leads here. Level
        on distinct, doubled and points together, by name and then tag — but a rank is shared only
        on a genuine tie in distinct and doubled; points breaks the display order between two such
        bases without giving them different ranks. Each of the four boards ranks and ties entirely
        on its own, independently of the other three.
      </p>
    </>
  )
}

export function RowScoringRules() {
  const rowCount = Math.ceil(ALL_CARDS.length / ROW_SIZE)

  return (
    <>
      <p className="empty-hint">
        Ranked by the real game's own collection screen, which is {ROW_SIZE} cards wide and flows
        continuously across deck boundaries — {ALL_CARDS.length} cards make {rowCount} rows exactly.
        A row is <strong>full</strong> when a base holds at least one copy of every card in it, and{' '}
        <strong>doubled</strong> — marked with a blue row instead of a green one — when it holds at
        least two of every card in it.
      </p>
      <p className="empty-hint">
        The score rewards breadth, finishing rows <strong>together</strong>, and finishing them{' '}
        <strong>twice over</strong>: 10 points for every full row, plus 10 more for every doubled
        row, plus a streak bonus for rows finished as one unbroken run. The streak bonus is earned
        per <strong>adjacent pair</strong> of full rows in the same run, not per row in it, so a
        longer run is worth more than the same rows split into separate runs — the same reason
        three-of-a-kind beats two pair. Five full rows scattered across the grid score 50; the same
        five as one unbroken run score 100; the same five as a run of three plus a separate run of
        two score 70 — more than scattered, but less than the unsplit run of five, because
        concentration counts for more than raw row total. A run of three plus two rows completed on
        their own, not next to anything, scores 65 — an isolated full row still earns its 10
        points, just no streak bonus on top.
      </p>
      <p className="empty-hint">
        Level on score, more full rows outright goes first — the same score is reachable by
        different routes, and the base that completed more rows outright is the better position even
        when the arithmetic agrees. A rank is shared on a genuine tie in score and then skips.
      </p>
    </>
  )
}

export function DeckCompletionScoringRules() {
  return (
    <>
      <p className="empty-hint">
        How many of the four decks a base holds <strong>outright</strong> — 0 through 4 — not how
        far into any one of them it has got. A deck counts once every card in it is held, the same
        boundary its own progress plaque on the grid reaches when it reads full — and counts again,
        separately, as <strong>doubled</strong> once every card in it is held at least twice, shown
        as a <strong>×2</strong> on that deck's chip.
      </p>
      <p className="empty-hint">
        Level on decks complete, more <strong>doubled</strong> decks goes first — finishing a deck
        twice over is further than finishing it once, the same way finishing more decks outright
        already beats finishing fewer. Level on both, more distinct cards held{' '}
        <strong>overall</strong> decides — the quantity that has to grow before another deck can
        complete, so among bases tied on whole decks finished and doubled, the one closer to a set
        across the rest of its collection is the one genuinely ahead — though a rank is shared only
        on a genuine tie in decks complete and doubled decks; distinct cards overall breaks the
        display order between two such bases without giving them different ranks.
      </p>
    </>
  )
}

export function SpareScoringRules() {
  return (
    <>
      <p className="empty-hint">
        A different question from every other board: not who's furthest along, but{' '}
        <strong>who's actually worth asking for a trade right now</strong>. Ranked by total
        tradeable spares — copies beyond the one a base keeps of each card, summed across all{' '}
        {ALL_CARDS.length}. A base never gives away its last copy, so a card held once contributes
        nothing here, only from its second copy on.
      </p>
      <p className="empty-hint">
        Level on spares, more <strong>spare variety</strong> goes first — the count of distinct
        cards a base holds at least two of. A base offering three spares each on three different
        cards can answer three different requests; a base offering nine spares of one card can only
        ever answer one.
      </p>
      <p className="empty-hint">
        No fraction is printed on this board, unlike the others: total spares has no ceiling worth
        reading it against, since there is no "fully spared" to reach. A rank is shared on a genuine
        tie in spares and then skips.
      </p>
    </>
  )
}

export function TraderScoringRules() {
  return (
    <>
      <p className="empty-hint">
        The Trade Tracker's own leaderboard, ranking which <strong>bases</strong> — never rolled up
        to the owner — have completed the most trades, so running several bases does not out-rank
        someone trading everything they can on one.
      </p>
      <p className="empty-hint">
        Counts a trade once it reaches <strong>complete</strong>, and keeps counting it even if an
        admin later <strong>undoes</strong> it — undoing corrects a mistake, it does not erase the
        work of having completed the trade in the first place. A trade that was only ever proposed,
        or was declined, never happened and does not count.
      </p>
      <p className="empty-hint">
        Level on completed trades, more <strong>distinct trading partners</strong> goes first — a
        base that traded five times with the same partner and one that traded five different
        partners are not equally established in the trade network. A rank is shared on a genuine tie
        and then skips.
      </p>
    </>
  )
}

/* ---------- weekly progress ---------- */

export function ProgressCapRules() {
  return (
    <>
      <p className="empty-hint">
        Every percent on this page is a level held against <strong>this Town Hall's own cap</strong>,
        not the unit's absolute maximum. A hero, pet, troop, spell or piece of equipment can report a
        higher cap in some other tool that only knows the unit's own ceiling — that number is the
        same whatever Town Hall you're at, so it is not what "100%" means here.
      </p>
      <p className="empty-hint">
        Troops, spells and equipment have very little history yet. The historical import that
        backfilled everything else on this page came from an old hand-kept spreadsheet that never
        tracked those three categories, so their charts only start filling in from whenever
        auto-capture first ran for a given base — a troop chart with one point, or a heatmap with a
        single column, is new data behaving correctly, not a broken chart.
      </p>
    </>
  )
}

/* ---------- base order ---------- */

export function BaseOrderReachRules() {
  return (
    <>
      <p className="empty-hint">
        This page only sets an order — nothing on it changes because of what you pick here. Three
        other pages read the order instead: the card page's <strong>Mine</strong> picker, the
        progress board's <strong>"just me"</strong> Owner filter, and the bases-over-time
        comparison's base selection. Reordering here changes what all three show, which is easy to
        miss if this page is the only one of the four you ever open.
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
        everybody's list, and clearing an owner clears it for the group. That is why{' '}
        <strong>only an admin can add, rename, or remove a saved clan</strong>, the same rule
        that already governs the owner column: a member who could reshape a list everyone else
        sees would be changing it out from under the group, not just for themselves. Everyone
        signed in still reads the whole list either way.
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

/* ---------- propose a change ---------- */

/**
 * Shared between the "Propose a change" page's own disclosure
 * (`ChangeRequestsView.tsx`) and the help page's `change-requests` section — one
 * copy, so the rules cannot state themselves two different ways.
 */
export function ChangeRequestRules() {
  return (
    <>
      <p className="empty-hint">
        Anyone signed in can submit a subject and a description. Nothing changes by itself — an
        admin resolves the request later, over time.
      </p>
      <p className="empty-hint">
        Three things you can do to your own request afterwards, <strong>independent of each other</strong>:
      </p>
      <ul className="rule-list">
        <li>
          <strong>Amend</strong> — add more text, dated, below the original. The original subject
          and description are never edited in place. Locked once the request is closed (canceled or
          resolved), the same way a resolved trade's original proposal never changes.
        </li>
        <li>
          <strong>Cancel</strong> — withdraw it, at any time. <strong>One-way</strong>: there is no
          route to un-cancel. The row stays, marked canceled, in your own list and in the admin
          table — nothing is deleted.
        </li>
        <li>
          <strong>Hide</strong> — remove it from your own "My requests" list. <strong>Reversible</strong>,
          unlike Cancel: there is a Show/Hide toggle rather than a one-way door. It never affects
          what an admin sees; the admin table always shows every request.
        </li>
      </ul>
      <p className="empty-hint">
        <strong>An admin can resolve any request at any time</strong>, whatever its cancel state —
        resolving an already-canceled request is harmless bookkeeping, not a special case. Exactly
        one of <strong>as designed</strong>, <strong>outside of project scope</strong>, or{' '}
        <strong>tied to a commit</strong> picked off the What's New list, each with an optional note.
        Unlike completing a trade, resolving here has no effect beyond recording an answer, so an
        admin may resolve the same request again later to correct or update it — each call replaces
        the prior resolution rather than being refused a second time.
      </p>
      <p className="empty-hint">
        <strong>You'll see a number on your account icon</strong> once one of your own requests is
        resolved — you don't have to remember to come back and check. It clears the moment you
        land on this page, whether or not you read the resolution, so if you're just glancing at
        "My requests" for something else, that clears it too.
      </p>
    </>
  )
}
