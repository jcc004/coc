import { useState, type ReactNode } from 'react'
import type { ApiError } from '../api.ts'
import { formatFull, formatStat } from '../format.ts'
import type { HelpSectionId } from '../help.ts'
import { hrefFor } from '../hooks.ts'
import {
  sortOptionLabel,
  type PagedRows,
  type RowLimit,
  type TableColumn,
} from '../saved-table.ts'
import { townHallArt } from '../wiki-art.ts'

/**
 * Bump this whenever the vendored art under `web/public/coc/` changes without its
 * filenames changing — the normal case, since `cards:generate` and `assets:coc`
 * overwrite files in place and the manifest paths stay the same. `deploy/nginx-coc.conf`
 * caches `/coc/` for 24h client-side, and that cache is keyed on the exact URL: a
 * browser that already fetched an image will not ask the server again until its own
 * copy's max-age elapses, no matter what the server's Cache-Control header says on
 * later requests. Changing the URL is the only thing that reaches an already-cached
 * browser, so every same-origin `/coc/...` src gets `?v=` appended below, and bumping
 * this number is what forces a fresh fetch everywhere.
 *
 * First bumped 2026-08-08, after the card art swapped in d63eb01 sat behind warm
 * 24h caches on clients that had loaded the page before the swap.
 */
export const LOCAL_ART_VERSION = 1

/** Vendored art lives under this path; CDN fallbacks (`https://...`) do not and must
 * never get a cache-busting suffix appended — this app does not control that origin
 * and should not force it to be refetched. */
const LOCAL_ART_PREFIX = '/coc/'

function cacheBusted(src: string): string {
  return src.startsWith(LOCAL_ART_PREFIX) ? `${src}?v=${LOCAL_ART_VERSION}` : src
}

/**
 * Supercell icon, vendored copy first. The vendored art is gitignored, so a fresh
 * clone that has not run the asset scripts knows the paths but has no files.
 *
 * With a `fallback` — league and label icons, whose CDN URL the API supplies —
 * dropping back to that URL keeps those installs rendering instead of showing
 * broken images. The guard matters: without it a failing fallback would retrigger
 * onError forever.
 *
 * Without one — wiki-sourced unit art, which we deliberately do not hotlink —
 * there is nowhere to go, so the element leaves the layout entirely. No broken
 * image glyph, and no empty slot holding space either: the gap that separates it
 * from the adjacent text belongs to the parent, so it collapses along with it.
 */
export function GameIcon({
  src,
  fallback,
  className,
}: {
  src: string
  fallback?: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  if (failed) return null

  return (
    <img
      className={className}
      src={cacheBusted(src)}
      alt=""
      onError={(event) => {
        const img = event.currentTarget
        if (fallback === undefined) setFailed(true)
        else if (!img.src.endsWith(fallback)) img.src = fallback
      }}
    />
  )
}

/**
 * A Town Hall level, with its badge when that art is vendored. The number is always
 * rendered, so the badge is decorative and takes an empty `alt` — and a checkout
 * with no art shows exactly what this showed before: the bare number.
 */
export function TownHallBadge({ level, text }: { level: number; text?: string }) {
  const art = townHallArt(level)
  return (
    <span className="th-badge">
      {art ? <GameIcon src={art} className="art-icon" /> : null}
      {text ?? level}
    </span>
  )
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="card">
      {title ? <h2 className="section-title">{title}</h2> : null}
      {children}
    </section>
  )
}

export function StatTile({
  label,
  value,
  note,
  noteTone,
}: {
  label: string
  value: number | string
  note?: string
  noteTone?: 'good'
}) {
  const numeric = typeof value === 'number'
  return (
    <div className="tile">
      <div className="tile__label">{label}</div>
      {/* Exact value on hover, since the displayed figure may be compacted. */}
      <div className="tile__value" title={numeric ? formatFull(value) : undefined}>
        {numeric ? formatStat(value) : value}
      </div>
      {note ? (
        <div className={noteTone === 'good' ? 'tile__note tile__note--good' : 'tile__note'}>
          {note}
        </div>
      ) : null}
    </div>
  )
}

export function TileRow({ children }: { children: ReactNode }) {
  return <div className="tiles">{children}</div>
}

/**
 * Magnitude bar on the single sequential ramp. A maxed value switches to the
 * status "good" step — never color alone, so the level text says `80/80` too.
 */
export function Meter({
  value,
  max,
  label,
}: {
  value: number
  max: number
  label: string
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  const maxed = max > 0 && value >= max
  return (
    <div
      className="meter"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div
        className={maxed ? 'meter__fill meter__fill--max' : 'meter__fill'}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function LevelRow({
  name,
  level,
  maxLevel,
  valueLabel,
  title,
  art,
}: {
  name: string
  level: number
  maxLevel: number
  /** Overrides the `n/max` text — achievements track a total that runs past the target. */
  valueLabel?: string
  title?: string
  /**
   * Vendored unit art, from `artFor`. Supplements the name and meter rather than
   * replacing them, so it is decorative: omit it and the row reads the same.
   */
  art?: string
}) {
  const maxed = level >= maxLevel
  return (
    <div className="meter-row">
      <div>
        <div className="meter-row__name">
          {art ? <GameIcon src={art} className="art-icon" /> : null}
          {name}
        </div>
        <Meter value={level} max={maxLevel} label={`${name} level ${level} of ${maxLevel}`} />
      </div>
      <div
        className={maxed ? 'meter-row__level meter-row__level--max' : 'meter-row__level'}
        title={title}
      >
        {valueLabel ?? `${level}/${maxLevel}`}
      </div>
    </div>
  )
}

/**
 * The quiet `?` beside a panel heading, linking into the help page.
 *
 * **The glyph is not the name.** `?` is a mark, not a label, so it is
 * `aria-hidden` and the accessible name is a `.visually-hidden` sentence naming
 * the topic — the same split the compass rosette and the account-menu silhouette
 * use, and for the same reason: a link announced as "question mark" tells a screen
 * reader user nothing about where it goes, and six of them on one page tell them
 * nothing six times. `title` carries the same words for a pointer.
 *
 * A real `<a href>`, not a button, because it navigates: it middle-clicks and
 * copies like any other link here, and the routes are hashes so there is nothing to
 * intercept.
 *
 * Deliberately visually quiet — an outlined circle in muted ink, not a chip. It
 * sits beside content somebody has already found and is only worth noticing when
 * they are stuck.
 */
export function HelpLink({ section, topic }: { section: HelpSectionId; topic: string }) {
  const name = `Help: ${topic}`
  return (
    <a className="help-link" href={hrefFor({ view: 'help', section })} title={name}>
      <span aria-hidden="true">?</span>
      <span className="visually-hidden">{name}</span>
    </a>
  )
}

export function RowLimitSelect({
  id,
  options,
  value,
  onChange,
  label = 'Rows',
}: {
  id: string
  options: RowLimit[]
  value: RowLimit
  onChange: (next: RowLimit) => void
  /**
   * What the control says it counts. `Rows` for a table where a row is a record;
   * overridden where a table's own vocabulary differs — the trade suggestions
   * table calls a single swap an "option" throughout (the count line below it
   * says so too), so its select says `Options` instead of the generic `Rows`.
   */
  label?: string
}) {
  return (
    <label className="row-limit" htmlFor={id}>
      {label}
      <select
        id={id}
        value={String(value)}
        onChange={(event) =>
          onChange(event.target.value === 'all' ? 'all' : Number(event.target.value))
        }
      >
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {option === 'all' ? 'All' : option}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Sorting, for a table that has stacked into cards.
 *
 * A stacked card has no column heads, so there is nowhere to put the seven sort
 * buttons a wide table carries — reflowing them into a strip above the cards was
 * the first attempt and it read as a run of unexplained gold words. This is the
 * replacement: name the column once, name the direction in words, and put both
 * on controls a thumb can hit.
 *
 * The column heads still exist in the (visually hidden) header row, so the table
 * keeps real `columnheader` cells and its `aria-sort` for assistive tech; this
 * is the visible affordance only, which is why the select is labeled "Sort by"
 * rather than repeating the column names as headings.
 */
export function SortControl<K extends string>({
  id,
  columns,
  sortKey,
  ascending,
  onSort,
}: {
  id: string
  columns: TableColumn<K>[]
  sortKey: K
  ascending: boolean
  /** Same handler the column heads use, so both routes share one behavior. */
  onSort: (key: K) => void
}) {
  const current = columns.find((column) => column.key === sortKey)
  const currentLabel = current ? sortOptionLabel(current) : sortKey
  const direction = ascending ? 'ascending' : 'descending'

  return (
    <div className="sort-control">
      <label className="sort-control__field" htmlFor={id}>
        Sort by
        <select
          id={id}
          value={sortKey}
          onChange={(event) => onSort(event.target.value as K)}
        >
          {columns.map((column) => (
            <option key={column.key} value={column.key}>
              {sortOptionLabel(column)}
            </option>
          ))}
        </select>
      </label>
      {/*
       * Re-picking the column that is already sorted is what reverses it, so this
       * button simply asks for the current column again. The label says which way
       * the list runs *now* and the name says what pressing it will do, because a
       * bare arrow leaves both ambiguous.
       */}
      <button
        type="button"
        className="icon-button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sorted by ${currentLabel}, ${direction}. Reverse to ${
          ascending ? 'descending' : 'ascending'
        }.`}
      >
        {ascending ? '↑ Ascending' : '↓ Descending'}
      </button>
    </div>
  )
}

/**
 * A row limit must never silently swallow rows, so whenever one is in force the
 * table says how much of the list is on screen and offers a way to the rest.
 */
export function Pager({
  view,
  noun,
  onPage,
}: {
  view: PagedRows<unknown>
  noun: string
  onPage: (next: number) => void
}) {
  if (view.pageCount <= 1) return null

  return (
    <div className="pager">
      <span className="pager__status">
        Showing {view.from}–{view.to} of {view.total} {noun}
      </span>
      <button
        type="button"
        className="icon-button"
        onClick={() => onPage(view.page - 1)}
        disabled={view.page <= 1}
      >
        ← Previous
      </button>
      <span className="pager__page">
        Page {view.page} of {view.pageCount}
      </span>
      <button
        type="button"
        className="icon-button"
        onClick={() => onPage(view.page + 1)}
        disabled={view.page >= view.pageCount}
      >
        Next →
      </button>
    </div>
  )
}

/**
 * A password input with a reveal toggle. Every password field in the app uses
 * this one, so the behavior cannot drift between the login form, the
 * change-password form and the admin forms.
 *
 * It starts as `type="password"` and only the toggle changes that, so nothing is
 * revealed by default. The revealed value lives in the caller's own `useState`
 * for exactly as long as the form does: nothing here writes to `localStorage`,
 * a query string, or anywhere else. `autoComplete` is required rather than
 * optional because the wrong value is worse than none — a browser offering a
 * saved password into a "new password" box is how people end up re-setting the
 * password they were trying to replace.
 */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  autoFocus,
  disabled,
}: {
  /** Visible-to-assistive-tech name. Also the default placeholder. */
  label: string
  value: string
  onChange: (next: string) => void
  autoComplete: 'current-password' | 'new-password'
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const action = revealed ? 'Hide' : 'Show'

  return (
    <div className="password-field">
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? label}
        aria-label={label}
        autoComplete={autoComplete}
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
      />
      {/*
       * The label names the action *and* the field, and changes with the state, so
       * a screen-reader user is told which of the two things the button will do
       * rather than just that a toggle exists. `aria-pressed` carries the state
       * itself. `type="button"` keeps it out of the form's submit path.
       */}
      <button
        type="button"
        className="icon-button password-field__toggle"
        onClick={() => setRevealed((on) => !on)}
        aria-pressed={revealed}
        aria-label={`${action} ${label.toLowerCase()}`}
        title={`${action} ${label.toLowerCase()}`}
      >
        {action}
      </button>
    </div>
  )
}

export function Loading({ what }: { what: string }) {
  return <div className="skeleton">Loading {what}…</div>
}

export function ErrorPanel({ error }: { error: ApiError }) {
  return (
    <div className="notice notice--error">
      <p className="notice__title">
        {error.status ? `${error.status} · ` : ''}
        {error.reason}
      </p>
      <p className="notice__body">{error.message}</p>
      {error.hint ? <p className="notice__hint">{error.hint}</p> : null}
    </div>
  )
}
