import { useEffect, useRef, type ReactNode } from 'react'
import { CARD_SEASON } from '@coc/shared'
import { HELP_SECTIONS, type HelpSectionId } from '../help.ts'
import { hrefFor } from '../hooks.ts'
import {
  CardEntryRules,
  OwnershipRules,
  ScoringRules,
  SharedDataRules,
  SwapRules,
  TradeResolutionRules,
} from './help-copy.tsx'

/**
 * `#/help` — what the card event is, who may do what, and how the numbers work.
 *
 * It is here because of what people actually get wrong, not as a feature tour. The
 * four questions this exists to answer, in the order they come up: who owns a base
 * and why that decides anything; the difference between a suggested swap and an
 * agreed trade; what the leaderboard is measuring; and that there is one copy of
 * the data and it is everybody's.
 *
 * **Nothing is written twice.** Every rule block is a component in `help-copy.tsx`,
 * rendered here *and* in a collapsed disclosure under the panel it governs, so the
 * page and the panel cannot come to say different things. What is local to this file
 * is the framing — the headings, the contents list, and the sentences that join one
 * section to the next.
 *
 * **Scrolling to a section is ours to do.** The route carries the section as a path
 * segment (`#/help/owners`), because the hash is already the router and a second `#`
 * in it is not a fragment the browser will act on — see the note at the top of
 * `help.ts`. So one effect finds the element and scrolls it, and moves focus to it
 * as well: a link that scrolls the page but leaves the caret in the topbar sends a
 * keyboard user back through the whole page to reach what they clicked for.
 */
export function HelpView({ section }: { section: HelpSectionId | null }) {
  /* Keyed by the section so the effect can tell "arrived at owners" from a
     re-render, without re-scrolling the page out from under somebody reading it. */
  const scrolled = useRef<HelpSectionId | null>(null)

  useEffect(() => {
    if (section === null || scrolled.current === section) return
    scrolled.current = section

    const target = document.getElementById(section)
    if (!target) return

    target.scrollIntoView({ block: 'start', behavior: 'smooth' })
    /* `preventScroll`, because the browser's own focus scroll would fight the
       smooth one above and land in a different place. The heading carries
       `tabIndex={-1}` purely so this can succeed. */
    target.focus({ preventScroll: true })
  }, [section])

  return (
    <>
      <section className="card">
        <h1 className="section-title">Help</h1>
        <p className="empty-hint help-prose">
          This app is a Clash of Clans explorer with one thing bolted on that the game gives us no
          help with at all: the <strong>card event</strong>, currently season{' '}
          <strong>{CARD_SEASON}</strong>. Everything below is about the parts people ask about
          twice.
        </p>
        {/* An in-page list rather than a sidebar: six items is a paragraph's worth,
            and a second column would be chrome on a page that is already prose. Each
            entry is the same link the `?` beside the panel is, so the two cannot
            point at different places. */}
        <nav aria-label="Help contents">
          <ul className="help-contents">
            {HELP_SECTIONS.map((entry) => (
              <li key={entry.id}>
                <a href={hrefFor({ view: 'help', section: entry.id })}>{entry.title}</a>
                <span className="card-meta"> — {entry.summary}</span>
              </li>
            ))}
          </ul>
        </nav>
      </section>

      <HelpSection id="cards">
        <p className="empty-hint">
          The card page is <strong>Cards</strong> in the topbar. It shows one base's sixty tiles at a
          time, chosen with the <strong>Base</strong> picker, with the whole clan's trades,
          leaderboard and totals underneath — those three are deliberately not narrowed by the
          picker. The same grid is on every player page, collapsed, because a player page{' '}
          <em>is</em> a base.
        </p>
        <CardEntryRules />
      </HelpSection>

      <HelpSection id="owners">
        <p className="empty-hint">
          This is the one that catches people out, because a base can look owned and grant nothing.
        </p>
        <OwnershipRules />
        <p className="empty-hint">
          Most assignments on this install predate accounts existing, so unlinked labels are the
          normal case rather than a fault. Working through them is what the picker is for.
        </p>
      </HelpSection>

      <HelpSection id="trades">
        <p className="empty-hint">
          Two panels, two different kinds of thing, one under the other. The upper one — trade
          suggestions — is a calculation.
        </p>
        <SwapRules />
      </HelpSection>

      <HelpSection id="tracker">
        <p className="empty-hint">
          The lower panel is the record. It replaced "did we actually do that swap?" having no answer
          anywhere but a chat scrollback.
        </p>
        <TradeResolutionRules />
      </HelpSection>

      <HelpSection id="leaderboard">
        <ScoringRules />
      </HelpSection>

      <HelpSection id="shared">
        <SharedDataRules />
        <p className="empty-hint">
          The one thing that is <strong>not</strong> shared is your own login. Accounts are
          per-person, an admin creates them, and there is no self-service password reset — ask an
          admin, who can issue you a one-time password from the{' '}
          <a href={hrefFor({ view: 'admin' })}>accounts page</a>.
        </p>
      </HelpSection>
    </>
  )
}

/**
 * One section: a panel, a linkable heading, and prose held to a readable measure.
 *
 * The heading takes the section's `id` and `tabIndex={-1}` rather than the panel
 * doing so, because the heading is what the scroll should bring to the top and what
 * focus should land on — focusing the whole panel would announce the entire section
 * as one label.
 */
function HelpSection({ id, children }: { id: HelpSectionId; children: ReactNode }) {
  const section = HELP_SECTIONS.find((entry) => entry.id === id)

  return (
    <section className="card">
      <h2 className="section-title help-section__title" id={id} tabIndex={-1}>
        {section?.title ?? id}
      </h2>
      <div className="help-prose">{children}</div>
    </section>
  )
}
