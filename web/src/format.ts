const FULL = new Intl.NumberFormat('en-US')
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Stat-tile figures: exact under 10k, compacted above it (1,284 / 12.9K / 4.2M). */
export function formatStat(value: number): string {
  return Math.abs(value) < 10_000 ? FULL.format(value) : COMPACT.format(value)
}

export function formatFull(value: number): string {
  return FULL.format(value)
}

/** `moreThanOncePerWeek` → `More than once per week`. */
export function humanizeCamel(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })

/** "in 4 hours" / "2 days ago", picking the largest sensible unit. */
export function formatRelative(date: Date): string {
  const seconds = (date.getTime() - Date.now()) / 1000
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit)
  }
  return RELATIVE.format(Math.round(seconds), 'second')
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return numerator === 0 ? '—' : '∞'
  return (numerator / denominator).toFixed(2)
}
