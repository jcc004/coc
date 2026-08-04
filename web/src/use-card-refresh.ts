import { useEffect } from 'react'
import {
  CARD_POLL_INTERVAL_MS,
  refreshDecision,
  type RefreshTrigger,
} from './card-refresh.ts'
import { reloadCardInventory, savingBaseCounts } from './card-inventory.ts'
import { reloadTrades } from './trades.ts'

/**
 * Keeps a card-showing page's counts and trades current without a reload.
 *
 * Mounted by the two pages that show cards — `CardsView` and `PlayerCardPanel` — and
 * by nothing else. It owns the interval and the two listeners; every decision it
 * makes is `refreshDecision` in `card-refresh.ts`, which is pure and tested, and the
 * note there is where the reasoning lives, including why polling these two endpoints
 * is acceptable when polling anything upstream would not be.
 *
 * **It lives in its own module rather than in `hooks.ts`** because that file was being
 * edited in parallel when this was written. It is a reasonable place for it anyway:
 * `hooks.ts` is the app's generic hooks — routing, theme, row limits — and this one is
 * about one feature's two stores.
 *
 * Three things it has to get right, and the third is the one that would be worse than
 * the staleness it fixes:
 *
 * - **the interval dies with the page.** It is created in the effect and cleared in
 *   its teardown, so nothing is left ticking for the life of the session once the
 *   last card page unmounts;
 * - **a hidden tab does not poll.** The tick still fires and does nothing, which is a
 *   `Date.now()` and a comparison; tearing the interval down and rebuilding it on
 *   every visibility change would be a second piece of state saying what
 *   `document.visibilityState` already says;
 * - **nothing is clobbered.** A refresh never touches what is being typed:
 *   `BaseCardEditor` re-seeds its draft only when the draft matches what the server
 *   was last known to hold, so an incoming record with somebody else's numbers is
 *   ignored while there are unsaved edits. What this hook adds is the case the editor
 *   cannot see — a write it has already sent — through `savingBaseCounts`.
 *
 * The state is per-mount rather than module-level on purpose. The router renders one
 * view at a time, so two of these are never alive at once; and if they somehow were,
 * `createServerStore` already shares one request between concurrent readers, so the
 * worst case is two decisions agreeing rather than two requests.
 */
export function useCardRefresh(): void {
  useEffect(() => {
    /*
     * When the last read *started*, not when it landed. A slow answer must not buy
     * itself a shorter window than a fast one, and the point of the stamp is to stop
     * a second request going out — which is a decision about when the first one left.
     */
    let lastStartedAt: number | null = null
    let inFlight = false
    let live = true

    function refreshNow(): void {
      lastStartedAt = Date.now()
      inFlight = true
      /* Neither reload rejects — `createServerStore.load()` records a failure in its
         own snapshot, which is what the panels already read to say they are stale —
         so there is nothing to catch here, only a flag to put back. */
      void Promise.all([reloadCardInventory(), reloadTrades()]).finally(() => {
        inFlight = false
      })
    }

    function maybeRefresh(trigger: RefreshTrigger): void {
      if (!live) return
      const decision = refreshDecision({
        trigger,
        now: Date.now(),
        lastStartedAt,
        visible: document.visibilityState === 'visible',
        inFlight,
        saving: savingBaseCounts(),
      })
      if (decision.refresh) refreshNow()
    }

    /*
     * Both, because neither covers the other. `focus` is what fires when the window
     * comes forward from another application; `visibilitychange` is what fires when
     * the user switches back from another tab in the same window, where some browsers
     * never blur the window at all. They also both fire in the ordinary case, which is
     * exactly the pile-up `FOCUS_REFRESH_MIN_GAP_MS` collapses into one request.
     */
    const onFocus = () => maybeRefresh('focus')
    const onVisibility = () => maybeRefresh('focus')

    /* Opening the page is the first read. On a cold start the store is already
       fetching, and `load()` hands back the request in flight rather than making a
       second one, so this costs nothing there; what it buys is the warm case —
       arriving from another page with a cache that is minutes old. */
    maybeRefresh('poll')

    const ticker = window.setInterval(() => maybeRefresh('poll'), CARD_POLL_INTERVAL_MS)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      live = false
      window.clearInterval(ticker)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
