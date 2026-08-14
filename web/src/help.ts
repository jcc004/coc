/**
 * The help page's sections, and how a link points at one of them.
 *
 * This is a pure module rather than a list inside `HelpView` because a deep link
 * has a wrong answer that nothing on screen would catch: a `?` beside the trade
 * tracker that scrolls to the leaderboard is worse than no `?` at all, and a link
 * to a section id that has since been renamed silently lands at the top of the
 * page and looks like it worked. So the ids live here, once, the panels reference
 * them by name, and the tests assert that every id a link can carry is a section
 * the page actually draws.
 *
 * **How the anchor is spelled: `#/help/<section>`, and the scroll is ours.**
 *
 * The obvious answer — `#/help#owners` — is not available: the hash is already
 * spent on the route, and a second `#` in it is just part of the fragment string,
 * so the browser's own anchor scrolling can never fire here. Of the two remaining
 * shapes, a query (`#/help?section=owners`) and a path segment
 * (`#/help/owners`), the path segment is the one this app already speaks:
 * `parseHash` splits on `/` and hands the second segment to the view, exactly as
 * `#/player/<tag>` and `#/clan/<tag>` do. A query would need `parseHash` to learn
 * a second syntax for the sake of one route.
 *
 * The cost is that `HelpView` has to do the scrolling itself, which the browser
 * would have done for a real fragment. That is a `scrollIntoView` in one effect,
 * and it buys something the native behavior does not give: the section ids stay
 * ordinary element ids, so they are still what a screen reader announces and what
 * the in-page contents list links to.
 *
 * An unrecognized section is **not** an error. It falls back to the top of the
 * page — somebody following an old link should get the help page, not a 404 for a
 * heading that was renamed.
 */

/** One section of the help page. Each is a deep-link target. */
export type HelpSectionId =
  | 'cards'
  | 'owners'
  | 'trades'
  | 'tracker'
  | 'leaderboard'
  | 'progress'
  | 'base-order'
  | 'shared'
  | 'change-requests'

export interface HelpSection {
  id: HelpSectionId
  /** The section's heading, and its line in the contents list. One string. */
  title: string
  /** One line saying what the section answers, for the contents list. */
  summary: string
}

/**
 * The sections, in reading order.
 *
 * Ordered as a narrative rather than by importance: what the event is, then who
 * owns a base (which decides what anybody may do), then the two halves of trading,
 * then how the board scores, then the app's other tracked feature — weekly progress,
 * and the base order that quietly feeds three other pages — then the thing that
 * surprises people about all of it: that there is one copy of the data and it is
 * everybody's — and last, how to ask for the app itself to change.
 */
export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'cards',
    title: 'The card event',
    summary: 'Sixty cards in four decks, and why every count is typed by hand',
  },
  {
    id: 'owners',
    title: 'Who owns a base, and why it matters',
    summary: 'Ownership is an account, and a typed-in name grants nobody anything',
  },
  {
    id: 'trades',
    title: 'Trade suggestions: what makes a swap legal',
    summary: 'Arithmetic over the current counts, and the rules behind it',
  },
  {
    id: 'tracker',
    title: 'The trade tracker: agreeing, completing, declining',
    summary: 'A stored agreement, who may resolve it, and what completing does',
  },
  {
    id: 'leaderboard',
    title: 'How the leaderboard scores',
    summary: 'Seven boards behind one picker — points, rarity, full rows, and four more',
  },
  {
    id: 'progress',
    title: "Weekly progress: what's automatic, and what you type in",
    summary: "A level's percent is against this Town Hall's own cap, not the game's flat maximum",
  },
  {
    id: 'base-order',
    title: "Your base order, and where else it's read",
    summary: 'One list, but three other pages read it — reordering here moves more than this page',
  },
  {
    id: 'shared',
    title: 'The data is shared',
    summary: 'One dataset for every account, and who last changed each row',
  },
  {
    id: 'change-requests',
    title: 'Propose a change',
    summary: 'Anyone can ask for something to be different; an admin resolves it over time',
  },
]

/** The ids, as a set, so a lookup does not walk the list. */
const IDS = new Set<string>(HELP_SECTIONS.map((section) => section.id))

/**
 * The section a `#/help/<param>` link is asking for, or `null` for the whole page.
 *
 * Case-insensitive and space-tolerant, because this is a URL somebody may have
 * typed or had mangled by a chat client. Anything still unrecognized is `null`
 * rather than a throw: see the note at the top about old links.
 */
export function helpSection(param: string | null | undefined): HelpSectionId | null {
  if (!param) return null
  const wanted = param.trim().toLowerCase()
  return IDS.has(wanted) ? (wanted as HelpSectionId) : null
}

/**
 * The href for the help page, or for one section of it.
 *
 * `hrefFor` in `hooks.ts` delegates to this so the whole scheme — including the
 * `null` case that must not leave a trailing slash — is testable without pulling
 * React in.
 */
export function helpHref(section: HelpSectionId | null): string {
  return section === null ? '#/help' : `#/help/${section}`
}
