import { useEffect, useId, useRef, useState } from 'react'
import type { SessionUser } from '@coc/shared'
import { schemeSummary } from '../color-scheme.ts'
import { hrefFor, navigate, useColorScheme, type Route, type Theme } from '../hooks.ts'
import { menuButtonLabel, nextTheme, themeLabel, userMenuItems } from '../user-menu.ts'

/** The picker lives on the account page; this is the entry point to it. */
const COLORS_ROUTE: Route = { view: 'account' }

/**
 * The account menu: a silhouette in the topbar, holding the theme switch, the
 * password page, the admin panel for admins, and Sign out.
 *
 * It replaces four separate topbar controls — theme cycler, account name as a link,
 * Sign out, and (for admins) no route to the account page at all beyond that name.
 * At 390px those competed with the Clan and Cards links for a bar barely wide enough
 * for the title; and "my settings" is a thing people look for behind their own
 * avatar, not spread across a toolbar.
 *
 * **The theme control stays a live cycler rather than three radio items.** It is the
 * only item somebody presses repeatedly, it has to visit all three states (see
 * `THEME_CYCLE`), and as a cycler it can stay pressed without the menu closing
 * underneath it — so the effect is visible while the control is still under the
 * cursor. Every other item navigates or signs out, and those close the menu, because
 * leaving it open over a page that has just changed is a menu that has to be
 * dismissed twice.
 *
 * Accessibility, hand-rolled because there is no menu library here and one glyph is
 * not worth a dependency:
 *
 * - the button is `aria-haspopup="menu"` / `aria-expanded`, and its accessible name
 *   is the display name and role — a silhouette alone says nothing about *who* is
 *   signed in, which is the one thing worth checking on a shared machine;
 * - the panel is `role="menu"` with `role="menuitem"` children, so it is announced
 *   as a menu rather than as a stack of links;
 * - **Escape closes it and returns focus to the button.** Closing without moving
 *   focus leaves a keyboard user at a control that no longer exists;
 * - a pointer press outside closes it. The listener is on `pointerdown`, not
 *   `click`, so a press that starts outside cannot land on an item that has moved.
 */
export function UserMenu({
  user,
  theme,
  onTheme,
  onSignOut,
}: {
  user: SessionUser
  theme: Theme
  onTheme: (next: Theme) => void
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  /*
   * Read here for the menu's own "Default / Custom" line — and, because this is the
   * one component rendered exactly when somebody is signed in, this call is also what
   * *applies* the scheme to the page. The hook does that in an effect; see
   * `useColorScheme`. It is keyed by account, so it cannot run before there is an
   * account to key it by, which is why it is not up in `App` beside `useTheme`: the
   * sign-in screen has no user id and must show the shipped theme.
   */
  const [scheme] = useColorScheme(user.id)

  /* One effect, and only while open: an outside-press and an Escape listener bound
     for the life of the app would run on every press on every page. */
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Focus goes back to the button, not to wherever it was before the menu.
      buttonRef.current?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const items = userMenuItems(user)

  return (
    <div className="user-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="user-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={menuButtonLabel(user)}
        title={menuButtonLabel(user)}
        onClick={() => setOpen((was) => !was)}
      >
        <Silhouette />
      </button>

      {open ? (
        <div className="user-menu__panel" id={menuId} role="menu">
          {/* Who, spelled out. The button's name carries it for a screen reader; a
              sighted user on a shared machine needs to be able to read it too, and a
              24px glyph cannot say it. */}
          <p className="user-menu__who">
            {user.displayName}
            <span className="card-meta">
              {user.email} · {user.role === 'admin' ? 'Admin' : 'Member'}
            </span>
          </p>

          {/* Not a `menuitem`: it is a button that changes a setting in place rather
              than an item that dismisses the menu, and calling it a menu item would
              promise the closing behavior of the three below it. */}
          <button
            type="button"
            className="user-menu__theme"
            onClick={() => onTheme(nextTheme(theme))}
            title="Cycles system, light and dark"
          >
            <span>Appearance</span>
            <span className="user-menu__theme-value">{themeLabel(theme)}</span>
          </button>

          {/*
            Colors sits directly under Appearance because it is the other half of the
            same setting, and it is a *link* rather than a cycler because there is no
            sensible cycle: the choice is a color, which needs a picker and the room to
            show what the guard did with it. It shows whether anything is customized, so
            "why does this look like this" has an answer without opening the page.
            `menuitem`, like the entries below it, since it navigates and closes.
          */}
          <a
            className="user-menu__theme"
            role="menuitem"
            href={hrefFor(COLORS_ROUTE)}
            title="Pick the accent and the plate"
            onClick={(event) => {
              event.preventDefault()
              setOpen(false)
              navigate(COLORS_ROUTE)
            }}
          >
            <span>Colors</span>
            <span className="user-menu__theme-value">{schemeSummary(scheme)}</span>
          </a>

          {items.map((item) =>
            item.route === null ? (
              <button
                key={item.id}
                type="button"
                className="user-menu__item"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onSignOut()
                }}
              >
                {item.label}
                <span className="card-meta">{item.hint}</span>
              </button>
            ) : (
              /* A real `<a href>`, so it middle-clicks and copies like any link —
                 the routes are hashes and there is no reason to intercept them. The
                 handler only closes the menu; `navigate` is called because a hash
                 that is already current fires no `hashchange`. */
              <a
                key={item.id}
                className="user-menu__item"
                role="menuitem"
                href={hrefFor(item.route)}
                onClick={(event) => {
                  event.preventDefault()
                  setOpen(false)
                  navigate(item.route!)
                }}
              >
                {item.label}
                <span className="card-meta">{item.hint}</span>
              </a>
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The silhouette, drawn by hand for the reason the compass rosette is: every mark in
 * this app is either game art or CSS, and an icon package for one 20px glyph would be
 * the second dependency added for decoration.
 *
 * A head and shoulders in `currentColor`, so it takes the topbar's ink in either
 * theme. `aria-hidden` — the button beside it carries the name.
 */
function Silhouette() {
  return (
    <svg
      className="user-menu__glyph"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="8" r="4" fill="currentColor" />
      {/* Shoulders: a half-capsule clipped by the viewBox, which reads as a torso
          without needing a second path for the crop. */}
      <path d="M4 21a8 8 0 0 1 16 0Z" fill="currentColor" />
    </svg>
  )
}
