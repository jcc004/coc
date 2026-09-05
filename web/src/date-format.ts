/**
 * The user's date/time format: which order the day, month and year print in, what
 * separates them, and whether the clock reads 12-hour with AM/PM or 24-hour.
 *
 * This is `color-scheme.ts`'s sibling — same shape, same reason. `format.ts` used to
 * hand every date straight to `toLocaleDateString`/`toLocaleString` with `undefined`
 * as the locale, which means "whatever this browser happens to be set to": two
 * people looking at the same base on the same day could see `8/24/2026` and
 * `24/8/2026` with nothing on screen explaining why, and neither could change it.
 * `claude-kit/rules/invariants.md`'s "every displayed date or time gets a
 * user-configurable format" is the rule this closes.
 *
 * **Display only.** Nothing here resolves *which instant* a date means — the caller
 * still owns that, exactly as before. This only changes how an already-correct
 * `Date` gets turned into a string.
 *
 * **Manual composition, not `Intl` options.** Once the day/month/year *order* is a
 * per-user choice, `Intl.DateTimeFormat`'s own locale machinery is the wrong tool —
 * its options (`dateStyle`, or a field list) pick a *locale's* order, never an
 * arbitrary one a person names for themselves. So a chosen order is built by hand:
 * zero-padded month and day, always a 4-digit year (or 2-digit for the short form —
 * see `composeDate`'s `shortYear` option, matching what `formatShortDate` printed
 * before this existed), joined with the chosen separator.
 */

export type DateOrder = 'MDY' | 'DMY' | 'YMD'
export type DateSeparator = '/' | '-' | '.'
export type HourCycle = '12h' | '24h'

export const DATE_ORDERS: readonly DateOrder[] = ['MDY', 'DMY', 'YMD']
export const DATE_SEPARATORS: readonly DateSeparator[] = ['/', '-', '.']
export const HOUR_CYCLES: readonly HourCycle[] = ['12h', '24h']

export interface DateFormatPreference {
  readonly order: DateOrder
  readonly separator: DateSeparator
  readonly hourCycle: HourCycle
}

/**
 * What `format.ts` produced before this module existed, for `en-US` — the most
 * common case of the browser-locale answer it used to give everyone regardless of
 * where they actually are. Not a claim that this is "correct": it is a starting
 * point everyone can change, same as `color-scheme.ts`'s shipped colors are a
 * starting point and not a claim that they suit everyone.
 */
export const DEFAULT_DATE_FORMAT: DateFormatPreference = {
  order: 'MDY',
  separator: '/',
  hourCycle: '12h',
}

/** A fixed instant used to preview a format — deliberately not "now", so a preview
 *  and a test both see the same digits regardless of when either runs. Every field
 *  is distinct (day ≠ month, hour past noon) so a swapped order or a flipped clock
 *  is visible rather than accidentally unchanged. */
export const PREVIEW_INSTANT: Date = new Date(2026, 7, 24, 17, 42)

export interface DateFormatOption {
  readonly id: string
  readonly label: string
  readonly preference: DateFormatPreference
}

/**
 * The offered starting points. Not exhaustive — every axis is also independently
 * adjustable — just the three shapes somebody is most likely to already think in.
 */
export const DATE_FORMAT_PRESETS: readonly DateFormatOption[] = [
  { id: 'us', label: 'US', preference: { order: 'MDY', separator: '/', hourCycle: '12h' } },
  { id: 'iso', label: 'ISO', preference: { order: 'YMD', separator: '-', hourCycle: '24h' } },
  { id: 'european', label: 'European', preference: { order: 'DMY', separator: '/', hourCycle: '24h' } },
]

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The date half, in the chosen order and separator.
 *
 * `shortYear` renders the year as two digits — what `formatShortDate` always
 * printed, for the same reason it still does: a numeric column value where a full
 * 4-digit year is more than the column has room to spend on it. It does not move
 * the year out of its place in the order; only its own width changes.
 */
export function composeDate(
  date: Date,
  preference: DateFormatPreference,
  options: { shortYear?: boolean } = {},
): string {
  const fullYear = String(date.getFullYear())
  const year = options.shortYear ? fullYear.slice(-2) : fullYear
  const month = pad2(date.getMonth() + 1)
  const day = pad2(date.getDate())

  const parts =
    preference.order === 'MDY' ? [month, day, year] : preference.order === 'DMY' ? [day, month, year] : [year, month, day]

  return parts.join(preference.separator)
}

/** The time half, per the chosen hour cycle: `5:42 PM` or `17:42`. */
export function composeTime(date: Date, preference: DateFormatPreference): string {
  const hours24 = date.getHours()
  const minutes = pad2(date.getMinutes())

  if (preference.hourCycle === '24h') return `${pad2(hours24)}:${minutes}`

  const period = hours24 < 12 ? 'AM' : 'PM'
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  return `${hours12}:${minutes} ${period}`
}

export function dateFormatKey(userId: number): string {
  /* Per account, exactly like `colorSchemeKey` — one browser can be shared, and a
     format preference belongs to the person, not the machine. */
  return `coc:dateFormat:${userId}`
}

function isDateOrder(value: unknown): value is DateOrder {
  return typeof value === 'string' && (DATE_ORDERS as readonly string[]).includes(value)
}

function isDateSeparator(value: unknown): value is DateSeparator {
  return typeof value === 'string' && (DATE_SEPARATORS as readonly string[]).includes(value)
}

function isHourCycle(value: unknown): value is HourCycle {
  return typeof value === 'string' && (HOUR_CYCLES as readonly string[]).includes(value)
}

function readObject(stored: unknown): Record<string, unknown> | null {
  const value = typeof stored === 'string' ? tryParse(stored) : stored
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * A stored preference, made safe — the same reasoning `parseScheme` gives:
 * anything wrong here (not JSON, not an object, a field that is not one of the
 * three known values) falls back to the default on that field alone, rather than
 * discarding the other two or throwing during render.
 */
export function parseDateFormat(stored: unknown): DateFormatPreference {
  const raw = readObject(stored)
  if (!raw) return DEFAULT_DATE_FORMAT

  return {
    order: isDateOrder(raw.order) ? raw.order : DEFAULT_DATE_FORMAT.order,
    separator: isDateSeparator(raw.separator) ? raw.separator : DEFAULT_DATE_FORMAT.separator,
    hourCycle: isHourCycle(raw.hourCycle) ? raw.hourCycle : DEFAULT_DATE_FORMAT.hourCycle,
  }
}

export function serializeDateFormat(preference: DateFormatPreference): string {
  return JSON.stringify(preference)
}

export function isDefaultDateFormat(preference: DateFormatPreference): boolean {
  return sameDateFormat(preference, DEFAULT_DATE_FORMAT)
}

export function sameDateFormat(a: DateFormatPreference, b: DateFormatPreference): boolean {
  return a.order === b.order && a.separator === b.separator && a.hourCycle === b.hourCycle
}

const ORDER_LABEL: Record<DateOrder, string> = {
  MDY: 'Month / Day / Year',
  DMY: 'Day / Month / Year',
  YMD: 'Year / Month / Day',
}

const HOUR_CYCLE_LABEL: Record<HourCycle, string> = {
  '12h': '12-hour (AM/PM)',
  '24h': '24-hour',
}

export function orderLabel(order: DateOrder): string {
  return ORDER_LABEL[order]
}

export function hourCycleLabel(hourCycle: HourCycle): string {
  return HOUR_CYCLE_LABEL[hourCycle]
}
