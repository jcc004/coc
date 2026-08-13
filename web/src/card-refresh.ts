/**
 * When the shared card data is due a re-read.
 *
 * Completing a trade moves a card on **two** bases, and the two people it moves them
 * for are hardly ever looking at the same tab. The person who pressed Complete is
 * already served — `trades.ts` reloads both stores off the back of that request — so
 * what this is for is *everybody else's* screen, which until now went on showing the
 * counts from before the swap until somebody reloaded the page.
 *
 * There is no websocket layer and none is being added for this, so the page asks:
 * once when it opens, whenever the tab is brought back to the front, and every
 * {@link CARD_POLL_INTERVAL_MS} while it is on screen and visible.
 *
 * **Why polling is acceptable here and nowhere else in this app.** Every clan and
 * player route spends the Supercell token, which is rate limited and is the thing the
 * whole cache/TTL design exists to protect. `GET /api/cards/inventory` and
 * `GET /api/cards/trades` spend none of it: both are local SQLite reads out of
 * `card_inventory` and `trades` (`server/src/cards/routes.ts:131` and
 * `trade-routes.ts`), with no upstream call anywhere behind them. A tick every ten
 * seconds is two selects. Do not copy this to anything that reaches upstream.
 *
 * The decision is a pure function for the usual reason: it is four conditions that
 * each cost something real when they are wrong — a backgrounded tab polling for
 * hours, two identical requests half a second apart, a refresh landing on top of
 * somebody's half-typed counts — and none of them is visible in a screenshot. The
 * hook that owns the interval and the listeners is `use-card-refresh.ts`; everything
 * it decides is here.
 */

/**
 * How often a card-showing page re-reads while it is open and visible.
 *
 * Originally thirty seconds, against how the trade actually happens: two people
 * agree in chat, one presses Complete, and the other is looking at their cards while
 * it happens — half a minute is inside that conversation. Tightened to ten seconds,
 * 2026-08-12, to shrink how long the *other* party can be looking at stale counts
 * without needing a websocket layer — still cheap for the reason above this
 * constant: both reads are local SQLite selects, not upstream Supercell calls.
 */
export const CARD_POLL_INTERVAL_MS = 10_000

/**
 * The shortest gap a *focus* may re-read after the previous read started.
 *
 * Not the poll interval, because the whole point of the focus trigger is to answer
 * immediately when somebody comes back to the tab: making them wait out the
 * remainder of a thirty-second window would be the staleness this exists to fix.
 * It is only here to collapse the pile-up — `focus` and `visibilitychange` both fire
 * when a tab comes forward, and either can land in the same moment as a poll — into
 * one request rather than three identical ones.
 */
export const FOCUS_REFRESH_MIN_GAP_MS = 2_000

/** What asked. The two triggers differ only in how fresh is fresh enough. */
export type RefreshTrigger = 'poll' | 'focus'

export type RefreshSkip = 'hidden' | 'inFlight' | 'saving' | 'tooSoon'

export type RefreshDecision = { refresh: true } | { refresh: false; reason: RefreshSkip }

/** How recent a read has to be for this trigger to leave it alone. */
export function minimumGapFor(trigger: RefreshTrigger): number {
  return trigger === 'poll' ? CARD_POLL_INTERVAL_MS : FOCUS_REFRESH_MIN_GAP_MS
}

/**
 * Whether to re-read the card inventory and the trade list right now.
 *
 * The four refusals in the order they are asked, each of which is the answer to a
 * different way of getting this wrong:
 *
 * - `hidden` — a tab in the background must not poll at all. This is the one that
 *   turns a cheap idea into a bad one: a laptop with eight forgotten tabs open
 *   overnight is a thousand requests nobody will ever read the answer to. It is
 *   first because it outranks everything else, including a poll that is long overdue;
 * - `inFlight` — a read we started has not come back. Both stores already share one
 *   request between concurrent callers, so this costs nothing that
 *   `createServerStore` would not also refuse, but asking here keeps the timestamp
 *   honest: it is the *start* of a read that is recorded, and re-entering would move
 *   it forward without a new answer;
 * - `saving` — the card grid is writing a base. Its counts are in flight and the
 *   inventory we would read back is the one from before the write, so a refresh here
 *   is a read that is stale before it lands. Waiting is free: `saveBaseCounts` reloads
 *   the store itself when it finishes;
 * - `tooSoon` — the last read started inside this trigger's window. That is what stops
 *   a focus event arriving on the heels of a poll from firing a second identical pair
 *   of requests.
 *
 * Note what is *not* here: whether somebody is halfway through typing counts. That is
 * `BaseCardEditor`'s to refuse and it already does — its re-seed effect bails out
 * while `countsDiffer(draft, saved)`, so a refresh that lands mid-entry updates the
 * attribution line and the panels around the grid and leaves the typed numbers
 * exactly where they are. `saving` covers the one case the editor cannot see, which is
 * a write it has already sent.
 */
export function refreshDecision(input: {
  trigger: RefreshTrigger
  now: number
  /** When the last read *started*, or `null` when nothing has been read yet. */
  lastStartedAt: number | null
  /** `document.visibilityState === 'visible'`, read by the caller. */
  visible: boolean
  /** A read this hook started has not come back yet. */
  inFlight: boolean
  /** A base's counts are being written right now — see `savingBaseCounts`. */
  saving: boolean
}): RefreshDecision {
  if (!input.visible) return { refresh: false, reason: 'hidden' }
  if (input.inFlight) return { refresh: false, reason: 'inFlight' }
  if (input.saving) return { refresh: false, reason: 'saving' }

  if (input.lastStartedAt !== null) {
    const age = input.now - input.lastStartedAt
    /* A negative age is a wall clock that moved backwards — an NTP correction, or a
       laptop waking up — not a read from the future. Treating it as due is the safe
       reading of the two: the alternative silently stops refreshing until the clock
       catches up with the stamp, which on an hour's correction is an hour. */
    if (age >= 0 && age < minimumGapFor(input.trigger)) {
      return { refresh: false, reason: 'tooSoon' }
    }
  }

  return { refresh: true }
}
