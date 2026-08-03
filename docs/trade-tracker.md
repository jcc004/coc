# The Trade Tracker

A *suggestion* is arithmetic: recomputed from the shared counts on every render, thrown away, and
true only for as long as the counts behind it are. It answers "what **could** we swap". Nothing in
it recorded that two people had agreed to one, so "did we actually do that swap?" had no answer
anywhere but in a chat scrollback — which is what the tracker replaces.

A **trade** is a stored row: one swap, two bases, visible to everybody, that either party can mark
complete or declined. Completing it is what moves the cards.

## Where it is

Directly **below** the trade suggestions, in both places the suggestions appear — the card page and
each player page's card panel, inside the same disclosure as that base's grid. That order is the
order the work happens in, read downwards: what could be swapped, then what has been agreed and is
waiting on somebody. It is its own panel rather than a second table inside the suggestions, because
a row here is a record with consequences and a row above it is a calculation.

One component, `web/src/components/TradeTracker.tsx`, for both — the fourth thing the two pages
share, after `CardTile`, `BaseCardEditor` and `TradeSuggestions`. The only difference is
`focusTag`: the player page passes its base and gets the trades that base is a side of, the card
page passes nothing and gets the clan's.

## Proposing

Every suggestion row carries a **Propose** button. It writes a row and stops: **no cards move.**
The proposal is one side saying "let's do this", and the *other* side (or an admin) is who
completes it — so the button is safe to press and its label promises only what it does.

You must own one of the two bases, or be an admin. A member who owns neither is told who can
(`darek or Turtle can propose this`) rather than being handed a button that would 403: proposing a
swap between two other people's bases is putting words in their mouths, and the other party would
have to decline something they never discussed. The rule is `tradeProposeAccess` in
`web/src/trade-tracker.ts`, mirroring the server's `mayProposeTrade`; the server is the
enforcement and the client rule only stops the UI offering what would be refused.

A swap already pending reads `On the tracker ↓` instead of offering a second proposal. Pressing it
again would in fact be harmless — the server answers **409 `alreadyProposed` with the existing row**
and `proposeTrade` treats that as success, because what the button promises ("this swap is on the
tracker") is true either way — but a control that does nothing new should not look like one that
does. The check is `findPendingSwap`, the same four columns as the partial unique index in
migration v7, so "already proposed" means the same thing on both sides of the wire.

## Resolving, and who may

**Either party, or an admin.** A trade belongs to *both* bases, which makes its rule different from
the per-base card write: card counts belong to one owner, an agreement does not. The consequence
worth saying out loud is that **completing a trade writes to two bases, one of which the person
clicking very likely does not own** — so the authorisation for those two writes is the *trade
record*, not the owner rule, and `server/src/cards/trade-access.ts` is where that is decided once.

A base carrying only a legacy text label grants nobody anything, exactly as for card entry: the
label is a note about a person, not a permission held by a session, so such a trade is an admin's
to resolve until an admin links the base to an account.

**Completing asks first**, and the question says what it does to whom: it is the only control in the
app that changes somebody else's card counts, and it cannot be undone from here. **Declining does
not ask**, because nothing moves. Both are recorded.

A trade is resolved **once**. Re-completing would move the same two cards a second time — silent,
wrong, and exactly the accident the refusal exists to prevent — and re-declining would rewrite the
audit stamp of a decision somebody else already made. The store refuses, the route answers 409
`alreadyResolved`, and the client hides the buttons; three layers, because the cost of missing it
is a wrong count nobody can trace.

The invariant the whole feature protects is checked **at completion, against the counts as they are
at that moment** — not against the ones the proposal was drawn from. A base must hold at least
`MIN_TRADEABLE_COUNT` (two) of a card to give one away, because a base that trades away its last
copy has lost a card rather than swapped one. Counts are hand-entered and routinely lag the game, so
a proposal is deliberately *not* re-validated when it is made: somebody who has just looked at their
cards knows more than the table does, and refusing them would push the disagreement into a
conversation nobody can see. If the spare has gone by the time it is completed, the route answers
409 `countsChanged` and the tracker shows that message verbatim.

## The audit record

Every row names **both** events: who proposed it and when, and — once resolved — who completed or
declined it and when. Not just the latest one: "Bert completed it" without "Anna proposed it" loses
which direction the agreement came from, which is the first thing somebody checks when a swap turns
out to be wrong. Relative on screen, absolute in the `title`, as everywhere else in the app.

A `null` name means that account has since been deleted, and it is said in words rather than left
blank. Both user columns are `ON DELETE SET NULL` on purpose: the trade is the record of something
that really happened, so deleting an account costs the attribution, not the record.

## Order

Pending first, however old — it is the only status anybody has to act on. Within pending, **oldest
first**, because a swap that has been waiting three days is the one being forgotten. Resolved rows
read newest-first, which is the order you want when checking whether something just went through.
The id breaks every remaining tie, so two trades proposed in the same second cannot swap places
between polls. `sortTrades`, tested.

## What the counts do afterwards

Completing writes both bases in one transaction in `trades-store.ts`, and the response carries the
trade in its new state **plus both bases' current counts** — so one request is enough for a client
to refresh two bases. `web/src/trades.ts` nonetheless reloads the inventory store rather than
patching it from that payload: it is the same refresh every other write does, and patching would
add a second path by which counts enter the cache — one no other write uses, and one that would be
wrong in exactly the case that matters, a count that fell to zero and is therefore *absent* from
the response rather than present as a zero.
