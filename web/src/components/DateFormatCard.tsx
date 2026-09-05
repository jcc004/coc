import type { SessionUser } from '@coc/shared'
import {
  DATE_FORMAT_PRESETS,
  DATE_ORDERS,
  DATE_SEPARATORS,
  DEFAULT_DATE_FORMAT,
  hourCycleLabel,
  HOUR_CYCLES,
  isDefaultDateFormat,
  orderLabel,
  PREVIEW_INSTANT,
  sameDateFormat,
  type DateOrder,
  type DateSeparator,
  type HourCycle,
} from '../date-format.ts'
import { formatDateTime } from '../format.ts'
import { useDateFormatPreference } from '../hooks.ts'

/**
 * The date/time format picker: order, separator, 12- vs. 24-hour, see it happen on
 * a fixed example instant, put it back.
 *
 * `ColorSchemeCard`'s sibling in shape — a live preview instead of a row of
 * chips, because there is no second theme to show a chip for here. `PREVIEW_INSTANT`
 * is a fixed moment rather than "now" for the same reason a unit test would want
 * one: every field in it (day, month, year, an afternoon hour) is distinct, so a
 * changed order or a flipped clock is visible in the preview rather than
 * accidentally unchanged.
 */

export function DateFormatCard({ user }: { user: SessionUser }) {
  const [preference, choose] = useDateFormatPreference(user.id)

  /*
   * Three explicit setters rather than one generic `set(key, value)` closing over
   * `{ ...preference, [key]: value }` — a computed key there would type as a plain
   * string and let a mismatched key/value pair through unnoticed, the same reason
   * `color-scheme.ts`'s `withSchemeColor` writes its three roles out instead of one
   * generic assignment.
   */
  function chooseOrder(order: DateOrder): void {
    choose({ ...preference, order })
  }
  function chooseSeparator(separator: DateSeparator): void {
    choose({ ...preference, separator })
  }
  function chooseHourCycle(hourCycle: HourCycle): void {
    choose({ ...preference, hourCycle })
  }

  return (
    <section className="card">
      <h2 className="section-title">Dates &amp; times</h2>
      <p className="lookup-preview">
        How every date and time on this site is written: the order of day, month and
        year, what separates them, and whether the clock reads 12-hour with AM/PM or
        24-hour. This only changes how an already-correct moment is displayed — never
        what it means or which timezone it is in.
      </p>

      <p className="scheme-shade">
        Right now: <strong>{formatDateTime(PREVIEW_INSTANT, preference)}</strong>
      </p>

      <div className="scheme-swatches">
        {DATE_FORMAT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="icon-button"
            aria-pressed={sameDateFormat(preset.preference, preference)}
            onClick={() => choose(preset.preference)}
          >
            {preset.label} — {formatDateTime(PREVIEW_INSTANT, preset.preference)}
          </button>
        ))}
      </div>

      <div className="date-format-fields">
        <label className="date-format-field">
          Order
          <select
            value={preference.order}
            onChange={(event) => chooseOrder(event.target.value as DateOrder)}
            aria-label="Date order"
          >
            {DATE_ORDERS.map((order) => (
              <option key={order} value={order}>
                {orderLabel(order)}
              </option>
            ))}
          </select>
        </label>

        <label className="date-format-field">
          Separator
          <select
            value={preference.separator}
            onChange={(event) => chooseSeparator(event.target.value as DateSeparator)}
            aria-label="Date separator"
          >
            {DATE_SEPARATORS.map((separator) => (
              <option key={separator} value={separator}>
                {separator}
              </option>
            ))}
          </select>
        </label>

        <label className="date-format-field">
          Time
          <select
            value={preference.hourCycle}
            onChange={(event) => chooseHourCycle(event.target.value as HourCycle)}
            aria-label="Hour cycle"
          >
            {HOUR_CYCLES.map((hourCycle) => (
              <option key={hourCycle} value={hourCycle}>
                {hourCycleLabel(hourCycle)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="scheme-actions">
        <button
          type="button"
          className="icon-button"
          disabled={isDefaultDateFormat(preference)}
          onClick={() => choose(DEFAULT_DATE_FORMAT)}
        >
          Reset to the default format
        </button>
        <span className="lookup-preview">
          {isDefaultDateFormat(preference)
            ? 'You are on the default format.'
            : 'Puts the order, separator and clock back to the default.'}
        </span>
      </div>
    </section>
  )
}
