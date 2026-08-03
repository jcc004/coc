import type { SessionUser } from '@coc/shared'
import type { Route, Theme } from './hooks.ts'

/**
 * What is in the account menu, and what the theme control says.
 *
 * The topbar used to carry four separate controls — a theme cycler, the account
 * name as a link, and Sign out — competing for width with the Clan and Cards links
 * on a 390px screen. They are now one silhouette button opening one menu, which is
 * where a person looks for their own settings.
 *
 * The list is here rather than inline in the component because it has a rule with a
 * wrong answer that a screenshot would not catch: **the admin panel is on it only
 * for admins.** A member who can see the entry, click it and be refused has been
 * shown a door that was never theirs; and the entry has to *disappear*, not be
 * disabled, because a greyed-out "Admin panel" tells a member their account is
 * lacking rather than that the feature is not for them.
 *
 * The theme part is here for the smaller reason that the cycle must visit all three
 * states — system, light, dark — and a control that quietly dropped `system` would
 * strand anybody whose OS switches at dusk. One table, so the order and the labels
 * cannot disagree.
 */

/* ---------- the items ---------- */

export interface MenuItem {
  /** Stable id, for keys and for tests to assert on without matching prose. */
  id: 'help' | 'account' | 'admin' | 'signOut'
  label: string
  /** Where it goes, or `null` for the action item (Sign out). */
  route: Route | null
  /** Short note under the label, saying what the item is for. */
  hint: string
}

/**
 * The menu, in order: help, your own password, then the admin panel if it is yours,
 * then Sign out.
 *
 * Sign out is **last and on its own**, because it is the one item that discards
 * state — putting it between two navigation items is how it gets pressed by
 * accident.
 *
 * **Help is first, and it is on everybody's menu.** It is the only item somebody
 * opens this panel for while confused rather than while administering something, so
 * it should be the first thing under their own name; and unlike the admin entry
 * there is no version of it that is not theirs — a help page hidden from members
 * would be hidden from exactly the people who need it. Nothing on it depends on the
 * account reading it, so there is no rule here to get wrong, only an order.
 */
export function userMenuItems(user: Pick<SessionUser, 'role'>): MenuItem[] {
  const items: MenuItem[] = [
    {
      id: 'help',
      label: 'Help',
      /* The whole page, from the top. The `?` marks beside the panels are what link
         into a section; arriving from here you have not said which part you want. */
      route: { view: 'help', section: null },
      hint: 'Cards, owners, trades and how the board scores',
    },
    {
      id: 'account',
      label: 'Change password',
      route: { view: 'account' },
      hint: 'And the account details the server holds',
    },
  ]

  if (user.role === 'admin') {
    items.push({
      id: 'admin',
      label: 'Admin panel',
      route: { view: 'admin' },
      hint: 'Accounts: create, rename, promote, disable, reset',
    })
  }

  items.push({ id: 'signOut', label: 'Sign out', route: null, hint: 'On this browser' })

  return items
}

/* ---------- the theme control ---------- */

/**
 * The three themes in cycle order, and what each one is called on the button.
 *
 * `system` is in the cycle and is the default. Light and dark are the two explicit
 * overrides; landing back on `system` is how somebody undoes an override, which is
 * not otherwise possible without clearing storage.
 */
export const THEME_CYCLE: readonly Theme[] = ['system', 'light', 'dark']

const THEME_LABEL: Record<Theme, string> = {
  system: '◐ System',
  light: '☀ Light',
  dark: '☾ Dark',
}

export function themeLabel(theme: Theme): string {
  return THEME_LABEL[theme]
}

/** The next theme in the cycle, wrapping — so every state is reachable by clicking. */
export function nextTheme(theme: Theme): Theme {
  const at = THEME_CYCLE.indexOf(theme)
  /* An unrecognised stored value lands on `system`, which is the default and the one
     answer that is never wrong. */
  if (at === -1) return 'system'
  return THEME_CYCLE[(at + 1) % THEME_CYCLE.length] as Theme
}

/**
 * What the menu button announces.
 *
 * The display name is in it, not just "Account": on a shared machine the one thing
 * worth being able to check at a glance is *who you are signed in as*, and a
 * silhouette alone says nothing about that. It is the accessible name and the
 * tooltip; the glyph itself is `aria-hidden`.
 */
export function menuButtonLabel(user: Pick<SessionUser, 'displayName' | 'role'>): string {
  const role = user.role === 'admin' ? 'admin' : 'member'
  return `${user.displayName} (${role}) — account menu`
}
