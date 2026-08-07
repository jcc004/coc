import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { alphabetizeTags, applyBaseOrder, moveTag, reconcileOrder } from './base-order.ts'

describe('reconcileOrder', () => {
  it('keeps the saved order when it matches what is owned', () => {
    assert.deepEqual(reconcileOrder(['#A', '#B', '#C'], ['#C', '#A', '#B']), ['#C', '#A', '#B'])
  })

  it('appends a newly owned tag the saved order never mentioned', () => {
    assert.deepEqual(reconcileOrder(['#A', '#B', '#C'], ['#B', '#A']), ['#B', '#A', '#C'])
  })

  it('drops a saved tag that is no longer owned', () => {
    assert.deepEqual(reconcileOrder(['#A', '#C'], ['#A', '#B', '#C']), ['#A', '#C'])
  })

  it('does both at once: drops what is no longer owned, appends what is new', () => {
    assert.deepEqual(reconcileOrder(['#A', '#D'], ['#B', '#A']), ['#A', '#D'])
  })

  it('an empty saved order is every owned tag, in the given order', () => {
    assert.deepEqual(reconcileOrder(['#A', '#B'], []), ['#A', '#B'])
  })

  it('an empty owned list is always empty, whatever was saved', () => {
    assert.deepEqual(reconcileOrder([], ['#A', '#B']), [])
  })

  it('two empty lists reconcile to empty', () => {
    assert.deepEqual(reconcileOrder([], []), [])
  })
})

describe('moveTag', () => {
  const tags = ['#A', '#B', '#C', '#D']

  it('moves the first item to the end', () => {
    assert.deepEqual(moveTag(tags, 0, 3), ['#B', '#C', '#D', '#A'])
  })

  it('moves the last item to the start', () => {
    assert.deepEqual(moveTag(tags, 3, 0), ['#D', '#A', '#B', '#C'])
  })

  it('moves a middle item later', () => {
    assert.deepEqual(moveTag(tags, 1, 2), ['#A', '#C', '#B', '#D'])
  })

  it('moves a middle item earlier', () => {
    assert.deepEqual(moveTag(tags, 2, 0), ['#C', '#A', '#B', '#D'])
  })

  it('a no-op index change returns the same order', () => {
    assert.deepEqual(moveTag(tags, 1, 1), tags)
  })

  it('clamps a target past the end to the last position', () => {
    assert.deepEqual(moveTag(tags, 0, 99), ['#B', '#C', '#D', '#A'])
  })

  it('clamps a negative target to the start', () => {
    assert.deepEqual(moveTag(tags, 3, -5), ['#D', '#A', '#B', '#C'])
  })

  it('an out-of-range source index is a no-op', () => {
    assert.deepEqual(moveTag(tags, 9, 0), tags)
    assert.deepEqual(moveTag(tags, -1, 0), tags)
  })

  it('a single-item list is unaffected by any move', () => {
    assert.deepEqual(moveTag(['#A'], 0, 0), ['#A'])
  })

  it('an empty list is unaffected', () => {
    assert.deepEqual(moveTag([], 0, 2), [])
  })

  it('returns a new array rather than mutating the input', () => {
    const original = ['#A', '#B', '#C']
    const copy = [...original]
    moveTag(original, 0, 2)
    assert.deepEqual(original, copy)
  })
})

describe('alphabetizeTags', () => {
  const labels: Record<string, string> = { '#A': 'Charlie', '#B': 'alpha', '#C': 'Bravo' }
  const labelOf = (tag: string) => labels[tag] ?? tag

  it('an empty list is unaffected', () => {
    assert.deepEqual(alphabetizeTags([], labelOf), [])
  })

  it('a single-item list is unaffected', () => {
    assert.deepEqual(alphabetizeTags(['#A'], labelOf), ['#A'])
  })

  it('leaves an already-sorted list as is', () => {
    assert.deepEqual(alphabetizeTags(['#B', '#C', '#A'], labelOf), ['#B', '#C', '#A'])
  })

  it('reorders tags whose labels are out of order', () => {
    assert.deepEqual(alphabetizeTags(['#A', '#B', '#C'], labelOf), ['#B', '#C', '#A'])
  })

  it('sorts case-insensitively', () => {
    const caseLabels: Record<string, string> = { '#X': 'bravo', '#Y': 'Alpha' }
    assert.deepEqual(alphabetizeTags(['#X', '#Y'], (tag) => caseLabels[tag] ?? tag), ['#Y', '#X'])
  })

  it('returns a new array rather than mutating the input', () => {
    const original = ['#A', '#B', '#C']
    const copy = [...original]
    alphabetizeTags(original, labelOf)
    assert.deepEqual(original, copy)
  })
})

describe('applyBaseOrder', () => {
  const item = (tag: string) => ({ tag, label: `label-${tag}` })

  it('places items in the given order', () => {
    const items = [item('#A'), item('#B'), item('#C')]
    assert.deepEqual(
      applyBaseOrder(items, ['#C', '#A', '#B']),
      [item('#C'), item('#A'), item('#B')],
    )
  })

  it('appends an item the order never mentions, after the ones it does', () => {
    const items = [item('#A'), item('#B'), item('#C')]
    assert.deepEqual(applyBaseOrder(items, ['#B', '#A']), [item('#B'), item('#A'), item('#C')])
  })

  it('keeps appended items in their original relative order', () => {
    const items = [item('#A'), item('#B'), item('#C'), item('#D')]
    assert.deepEqual(
      applyBaseOrder(items, ['#C']),
      [item('#C'), item('#A'), item('#B'), item('#D')],
    )
  })

  it('ignores an order entry with no matching item', () => {
    const items = [item('#A'), item('#B')]
    assert.deepEqual(applyBaseOrder(items, ['#Z', '#B', '#A']), [item('#B'), item('#A')])
  })

  it('an empty order leaves items in their original order', () => {
    const items = [item('#A'), item('#B')]
    assert.deepEqual(applyBaseOrder(items, []), items)
  })

  it('an empty items list is always empty, whatever the order', () => {
    assert.deepEqual(applyBaseOrder([], ['#A', '#B']), [])
  })

  it('returns a new array rather than mutating the input', () => {
    const items = [item('#A'), item('#B')]
    const copy = [...items]
    applyBaseOrder(items, ['#B', '#A'])
    assert.deepEqual(items, copy)
  })
})
