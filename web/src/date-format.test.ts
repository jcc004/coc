import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  composeDate,
  composeTime,
  dateFormatKey,
  DATE_FORMAT_PRESETS,
  DATE_ORDERS,
  DATE_SEPARATORS,
  DEFAULT_DATE_FORMAT,
  HOUR_CYCLES,
  hourCycleLabel,
  isDefaultDateFormat,
  orderLabel,
  parseDateFormat,
  sameDateFormat,
  serializeDateFormat,
  type DateFormatPreference,
} from './date-format.ts'

// 2026-08-24, 17:42:00 local — day, month and year are all distinct, and the hour
// is past noon, so a swapped order or a flipped clock is visible in every test
// below rather than accidentally unchanged.
const INSTANT = new Date(2026, 7, 24, 17, 42, 0)
const MORNING = new Date(2026, 0, 5, 9, 5, 0)
const MIDNIGHT = new Date(2026, 0, 5, 0, 5, 0)
const NOON = new Date(2026, 0, 5, 12, 0, 0)

describe('composeDate', () => {
  const preference = (order: DateFormatPreference['order'], separator: DateFormatPreference['separator']) => ({
    ...DEFAULT_DATE_FORMAT,
    order,
    separator,
  })

  it('orders MDY', () => {
    assert.equal(composeDate(INSTANT, preference('MDY', '/')), '08/24/2026')
  })

  it('orders DMY', () => {
    assert.equal(composeDate(INSTANT, preference('DMY', '/')), '24/08/2026')
  })

  it('orders YMD', () => {
    assert.equal(composeDate(INSTANT, preference('YMD', '-')), '2026-08-24')
  })

  it('joins with every separator', () => {
    for (const separator of DATE_SEPARATORS) {
      assert.equal(composeDate(INSTANT, preference('MDY', separator)), ['08', '24', '2026'].join(separator))
    }
  })

  it('shortYear renders two digits without moving the year out of its place', () => {
    assert.equal(composeDate(INSTANT, preference('MDY', '/'), { shortYear: true }), '08/24/26')
    assert.equal(composeDate(INSTANT, preference('YMD', '-'), { shortYear: true }), '26-08-24')
  })

  it('zero-pads a single-digit month and day', () => {
    assert.equal(composeDate(MORNING, preference('MDY', '/')), '01/05/2026')
  })
})

describe('composeTime', () => {
  it('12-hour cycle: afternoon gets PM and a 12-hour clock', () => {
    assert.equal(composeTime(INSTANT, { ...DEFAULT_DATE_FORMAT, hourCycle: '12h' }), '5:42 PM')
  })

  it('12-hour cycle: morning gets AM', () => {
    assert.equal(composeTime(MORNING, { ...DEFAULT_DATE_FORMAT, hourCycle: '12h' }), '9:05 AM')
  })

  it('12-hour cycle: midnight is 12 AM, not 0 AM', () => {
    assert.equal(composeTime(MIDNIGHT, { ...DEFAULT_DATE_FORMAT, hourCycle: '12h' }), '12:05 AM')
  })

  it('12-hour cycle: noon is 12 PM, not 0 PM', () => {
    assert.equal(composeTime(NOON, { ...DEFAULT_DATE_FORMAT, hourCycle: '12h' }), '12:00 PM')
  })

  it('24-hour cycle: zero-padded, no AM/PM', () => {
    assert.equal(composeTime(INSTANT, { ...DEFAULT_DATE_FORMAT, hourCycle: '24h' }), '17:42')
    assert.equal(composeTime(MORNING, { ...DEFAULT_DATE_FORMAT, hourCycle: '24h' }), '09:05')
    assert.equal(composeTime(MIDNIGHT, { ...DEFAULT_DATE_FORMAT, hourCycle: '24h' }), '00:05')
  })
})

describe('every order × hour-cycle combination', () => {
  for (const order of DATE_ORDERS) {
    for (const hourCycle of HOUR_CYCLES) {
      it(`${order} / ${hourCycle} composes without throwing and round-trips its own fields`, () => {
        const preference: DateFormatPreference = { order, separator: '/', hourCycle }
        const date = composeDate(INSTANT, preference)
        const time = composeTime(INSTANT, preference)

        // Every field appears somewhere in the composed strings, regardless of order.
        assert.match(date, /2026/)
        assert.match(date, /08/)
        assert.match(date, /24/)
        assert.match(time, hourCycle === '24h' ? /^17:42$/ : /^5:42 PM$/)
      })
    }
  }
})

describe('dateFormatKey', () => {
  it('is per account, like colorSchemeKey', () => {
    assert.equal(dateFormatKey(7), 'coc:dateFormat:7')
    assert.notEqual(dateFormatKey(7), dateFormatKey(8))
  })
})

describe('parseDateFormat', () => {
  it('falls back to the default for anything that is not a stored preference', () => {
    assert.deepEqual(parseDateFormat(null), DEFAULT_DATE_FORMAT)
    assert.deepEqual(parseDateFormat(undefined), DEFAULT_DATE_FORMAT)
    assert.deepEqual(parseDateFormat('not json'), DEFAULT_DATE_FORMAT)
    assert.deepEqual(parseDateFormat('[]'), DEFAULT_DATE_FORMAT)
    assert.deepEqual(parseDateFormat('"a string"'), DEFAULT_DATE_FORMAT)
  })

  it('round-trips a value serializeDateFormat wrote', () => {
    const preference: DateFormatPreference = { order: 'DMY', separator: '.', hourCycle: '24h' }
    assert.deepEqual(parseDateFormat(serializeDateFormat(preference)), preference)
  })

  it('accepts a plain object, not just a JSON string — same as parseScheme reading localStorage', () => {
    const preference: DateFormatPreference = { order: 'YMD', separator: '-', hourCycle: '24h' }
    assert.deepEqual(parseDateFormat(preference), preference)
  })

  it('falls back field-by-field rather than discarding the whole preference', () => {
    assert.deepEqual(parseDateFormat({ order: 'DMY', separator: 'nope', hourCycle: '24h' }), {
      order: 'DMY',
      separator: DEFAULT_DATE_FORMAT.separator,
      hourCycle: '24h',
    })
  })
})

describe('isDefaultDateFormat / sameDateFormat', () => {
  it('the default is the default', () => {
    assert.ok(isDefaultDateFormat(DEFAULT_DATE_FORMAT))
    assert.ok(isDefaultDateFormat({ ...DEFAULT_DATE_FORMAT }))
  })

  it('any changed field is not the default', () => {
    assert.ok(!isDefaultDateFormat({ ...DEFAULT_DATE_FORMAT, order: 'YMD' }))
    assert.ok(!isDefaultDateFormat({ ...DEFAULT_DATE_FORMAT, separator: '-' }))
    assert.ok(!isDefaultDateFormat({ ...DEFAULT_DATE_FORMAT, hourCycle: '24h' }))
  })

  it('sameDateFormat compares all three fields', () => {
    const a: DateFormatPreference = { order: 'MDY', separator: '/', hourCycle: '12h' }
    const b: DateFormatPreference = { order: 'MDY', separator: '/', hourCycle: '12h' }
    const c: DateFormatPreference = { order: 'MDY', separator: '/', hourCycle: '24h' }
    assert.ok(sameDateFormat(a, b))
    assert.ok(!sameDateFormat(a, c))
  })
})

describe('presets', () => {
  it('every preset is a genuinely distinct combination', () => {
    const seen = new Set(DATE_FORMAT_PRESETS.map((preset) => serializeDateFormat(preset.preference)))
    assert.equal(seen.size, DATE_FORMAT_PRESETS.length)
  })

  it('every preset id is unique', () => {
    const ids = new Set(DATE_FORMAT_PRESETS.map((preset) => preset.id))
    assert.equal(ids.size, DATE_FORMAT_PRESETS.length)
  })
})

describe('labels', () => {
  it('name every order and hour cycle, so a new value cannot render blank', () => {
    for (const order of DATE_ORDERS) assert.ok(orderLabel(order).length > 0)
    for (const hourCycle of HOUR_CYCLES) assert.ok(hourCycleLabel(hourCycle).length > 0)
  })
})
