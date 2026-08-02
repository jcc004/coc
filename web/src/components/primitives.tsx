import type { ReactNode } from 'react'
import type { ApiError } from '../api.ts'
import { formatFull, formatStat } from '../format.ts'
import type { PagedRows, RowLimit } from '../saved-table.ts'

/**
 * Supercell icon, vendored copy first. The vendored art is gitignored, so a fresh
 * clone that has not run `npm run assets:coc` knows the ids but has no files —
 * dropping back to the CDN URL the API supplied keeps those installs rendering
 * instead of showing broken images. The guard matters: without it a failing
 * fallback would retrigger onError forever.
 */
export function GameIcon({
  src,
  fallback,
  className,
}: {
  src: string
  fallback: string
  className?: string
}) {
  return (
    <img
      className={className}
      src={src}
      alt=""
      onError={(event) => {
        const img = event.currentTarget
        if (!img.src.endsWith(fallback)) img.src = fallback
      }}
    />
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
 * status "good" step — never colour alone, so the level text says `80/80` too.
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
}: {
  name: string
  level: number
  maxLevel: number
  /** Overrides the `n/max` text — achievements track a total that runs past the target. */
  valueLabel?: string
  title?: string
}) {
  const maxed = level >= maxLevel
  return (
    <div className="meter-row">
      <div>
        <div className="meter-row__name">{name}</div>
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

export function RowLimitSelect({
  id,
  options,
  value,
  onChange,
}: {
  id: string
  options: RowLimit[]
  value: RowLimit
  onChange: (next: RowLimit) => void
}) {
  return (
    <label className="row-limit" htmlFor={id}>
      Rows
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
