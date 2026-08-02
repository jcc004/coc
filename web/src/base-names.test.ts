import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { baseOptions } from './base-names.ts'

const labels = (bases: Parameters<typeof baseOptions>[0]) =>
  baseOptions(bases).map((option) => option.label)

/* Order-independent, for the cases where the relative order of two labels is the
   locale's business rather than ours. */
const labelByTag = (bases: Parameters<typeof baseOptions>[0]) =>
  Object.fromEntries(baseOptions(bases).map((option) => [option.tag, option.label]))

describe('baseOptions', () => {
  it('shows the member name, not the tag', () => {
    assert.deepEqual(
      labels([
        { tag: '#2GCJ2QPU', name: 'darek' },
        { tag: '#29L9QJL8V', name: 'MasterNate' },
      ]),
      ['darek', 'MasterNate'],
    )
  })

  it('adds the tag only to the names that are shared', () => {
    assert.deepEqual(
      labels([
        { tag: '#AAA', name: 'darek' },
        { tag: '#BBB', name: 'darek' },
        { tag: '#CCC', name: 'Zack' },
      ]),
      // Alphabetical the way a reader expects: d before Z, case ignored.
      ['darek (#AAA)', 'darek (#BBB)', 'Zack'],
    )
  })

  /* Two entries reading the same is the whole problem, so near-misses that render
     identically count as shared too. */
  it('treats names differing only by case or padding as shared', () => {
    assert.deepEqual(
      labelByTag([
        { tag: '#AAA', name: 'darek' },
        { tag: '#BBB', name: 'Darek' },
      ]),
      { '#AAA': 'darek (#AAA)', '#BBB': 'Darek (#BBB)' },
    )
    assert.deepEqual(
      labelByTag([
        { tag: '#AAA', name: 'darek' },
        { tag: '#BBB', name: ' darek ' },
      ]),
      { '#AAA': 'darek (#AAA)', '#BBB': 'darek (#BBB)' },
    )
  })

  it('trims a name before showing it', () => {
    assert.deepEqual(labels([{ tag: '#AAA', name: '  Bacon Rider 69  ' }]), ['Bacon Rider 69'])
  })

  it('falls back to the tag when no roster names the base', () => {
    assert.deepEqual(
      labels([
        { tag: '#ZZZ' },
        { tag: '#AAA', name: 'darek' },
      ]),
      ['darek', '#ZZZ'],
    )
  })

  it('treats a blank name as no name at all', () => {
    assert.deepEqual(labels([{ tag: '#AAA', name: '   ' }]), ['#AAA'])
  })

  it('sorts named bases by label and pushes the unnamed ones last', () => {
    assert.deepEqual(
      labels([
        { tag: '#NN2' },
        { tag: '#CCC', name: 'Zack' },
        { tag: '#NN1' },
        { tag: '#AAA', name: 'darek' },
      ]),
      ['darek', 'Zack', '#NN1', '#NN2'],
    )
  })

  it('keeps the tag as the identity whatever the label says', () => {
    const options = baseOptions([
      { tag: '#AAA', name: 'darek' },
      { tag: '#BBB', name: 'darek' },
    ])
    assert.deepEqual(
      options.map((option) => option.tag),
      ['#AAA', '#BBB'],
    )
  })

  it('is total: equal labels still order deterministically by tag', () => {
    const bases = [
      { tag: '#BBB', name: 'same' },
      { tag: '#AAA', name: 'same' },
    ]
    assert.deepEqual(baseOptions(bases), baseOptions([...bases].reverse()))
  })

  it('is empty for no bases', () => {
    assert.deepEqual(baseOptions([]), [])
  })
})
