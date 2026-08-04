import { useState } from 'react'
import type { SessionUser } from '@coc/shared'
import {
  acceptsColor,
  DEFAULT_SCHEME,
  isDefaultScheme,
  presetsFor,
  roleOutcome,
  SCHEME_ROLES,
  SHIPPED,
  withSchemeColor,
  type ColorScheme,
  type RoleOutcome,
  type SchemeRole,
} from '../color-scheme.ts'
import { useColorScheme } from '../hooks.ts'

/**
 * The colour picker: pick the accent, the plate and the banner, see it happen, put it
 * back.
 *
 * Two things about the shape of it.
 *
 * **The swatches are the path.** Every offered colour is one the guard accepts —
 * asserted in `color-scheme.test.ts`, against the same code the custom input goes
 * through — so the ordinary way to use this cannot produce a message at all. The
 * free colour input is the second path, and the sentence under it always says what
 * happened: which shade each theme was given, or, for the handful of colours this app
 * cannot lend out, which of its own colours the choice collided with and the nearest
 * hue that does not. A control that refuses without saying why is the wall this
 * codebase's messages are written to avoid.
 *
 * **The preview is the app.** Choosing applies immediately, to the page you are on, so
 * there is nothing to interpret from a row of chips; the two chips that are here say
 * what the *other* theme was given, which is the only part you cannot see.
 *
 * No new colour and no inline styles: the swatch is an SVG `rect` with a `fill`
 * attribute, which is how a dynamic colour is drawn here without a style attribute
 * (`deploy/nginx-coc.conf` calls those debt) and without a per-preset CSS class that
 * could drift from the list in `color-scheme.ts`.
 */

const ROLE_TITLE: Record<SchemeRole, string> = {
  accent: 'Accent',
  chrome: 'Plate',
  banner: 'Banner',
}

const ROLE_NOTE: Record<SchemeRole, string> = {
  accent: 'Links, the focus ring, meter fills and progress bars.',
  chrome: 'Panel edges, the committing buttons, the card badge and the display numerals.',
  banner: 'The bar across the top. Left alone, it follows the plate.',
}

/** Drawn at 24 in the viewBox, so one path serves both the swatch and the chip. */
const SWATCH_SIZE = 22
const CHIP_SIZE = 16

export function ColorSchemeCard({ user }: { user: SessionUser }) {
  const [scheme, choose] = useColorScheme(user.id)

  return (
    <section className="card">
      <h2 className="section-title">Colours</h2>
      <p className="lookup-preview">
        Three colours are yours: the accent, the gold plate, and the banner across the top.
        Everything else — the parchment, the ink, and the green, amber and red that mean
        something — stays put, so that whatever you pick still reads. The shade is fitted to
        each theme separately, because a colour that works on parchment can vanish on dark
        wood.
      </p>

      {SCHEME_ROLES.map((role) => (
        <RoleBlock key={role} role={role} scheme={scheme} onChoose={choose} />
      ))}

      <div className="scheme-actions">
        <button
          type="button"
          className="icon-button"
          disabled={isDefaultScheme(scheme)}
          onClick={() => choose(DEFAULT_SCHEME)}
        >
          Reset to the shipped colours
        </button>
        <span className="lookup-preview">
          {isDefaultScheme(scheme)
            ? 'You are on the shipped light and dark themes.'
            : 'Puts all three roles back to the light and dark themes this app ships with.'}
        </span>
      </div>
    </section>
  )
}

function RoleBlock({
  role,
  scheme,
  onChoose,
}: {
  role: SchemeRole
  scheme: ColorScheme
  onChoose: (next: ColorScheme) => void
}) {
  /* What is in the input, which is not the same as what is stored: a colour the guard
     refuses stays visible with its reason rather than disappearing on the way in. */
  const [pending, setPending] = useState<string | null>(null)

  const stored = scheme[role]
  const shown = pending ?? stored ?? SHIPPED[role]
  const outcome = roleOutcome(role, shown)

  function apply(hex: string) {
    setPending(hex)
    if (!acceptsColor(role, hex)) return
    onChoose(withSchemeColor(scheme, role, hex))
  }

  const presets = presetsFor(role)

  return (
    <div className="scheme-role">
      <p className="scheme-role__label">{ROLE_TITLE[role]}</p>
      <p className="scheme-role__note">{ROLE_NOTE[role]}</p>

      <div className="scheme-swatches">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="scheme-swatch"
            /* The pressed state, not a class, carries "this is the one" — so it is in
               the accessibility tree and not only in the ring. */
            aria-pressed={sameColor(preset.hex, stored)}
            aria-label={`${ROLE_TITLE[role]}: ${preset.label}`}
            title={`${preset.label} — ${preset.hex}`}
            onClick={() => apply(preset.hex)}
          >
            <Swatch hex={preset.hex} size={SWATCH_SIZE} />
          </button>
        ))}
      </div>

      <label className="scheme-custom">
        <span>Or any colour</span>
        <input
          type="color"
          value={shown}
          onChange={(event) => apply(event.target.value)}
          aria-label={`${ROLE_TITLE[role]}: choose any colour`}
        />
        <span className="scheme-shade">{shown}</span>
      </label>

      <Outcome outcome={outcome} onApply={apply} />
    </div>
  )
}

/**
 * What the guard said, drawn. The flattening — three `fit` unions narrowed into one
 * shape — is `roleOutcome` in `color-scheme.ts`, with the sentences, so this file holds
 * no color logic and a fourth role would need nothing here but a title and a note.
 */
function Outcome({ outcome, onApply }: { outcome: RoleOutcome; onApply: (hex: string) => void }) {
  const { light, dark, suggestion } = outcome

  return (
    <>
      <p className={outcome.refused ? 'scheme-outcome scheme-outcome--refused' : 'scheme-outcome'}>
        {outcome.message}
      </p>

      {suggestion ? (
        <div className="scheme-swatches">
          <button type="button" className="icon-button" onClick={() => onApply(suggestion)}>
            Use {suggestion} instead
          </button>
        </div>
      ) : null}

      {light && dark ? (
        <div className="scheme-shades">
          <span className="scheme-shade">
            <Swatch hex={light} size={CHIP_SIZE} />
            Light {light}
          </span>
          <span className="scheme-shade">
            <Swatch hex={dark} size={CHIP_SIZE} />
            Dark {dark}
          </span>
        </div>
      ) : null}
    </>
  )
}

function sameColor(hex: string, other: string | null): boolean {
  return other !== null && hex.toLowerCase() === other.toLowerCase()
}

/**
 * A colour, drawn. `fill` is a presentation attribute rather than a style attribute,
 * which is what lets this be dynamic without adding to the inline-style count the CSP
 * comment tracks. `aria-hidden` — the button around it carries the name.
 */
function Swatch({ hex, size }: { hex: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="24" height="24" rx="6" fill={hex} />
    </svg>
  )
}
