import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render } from '@testing-library/react'
import { installTestCleanup, stubApi } from './test-support.ts'
import { useBaseLabels, type BaseLabels } from './base-labels.ts'

/**
 * `useBaseLabels`'s tag-set union — the one piece of this hook worth pinning
 * beyond what `CardsView.test.tsx` and `PlayerCardPanel.test.tsx` already exercise
 * indirectly through their own views. What matters here is `extraTags`: it has to
 * be strictly additive, so every existing caller (cards, trades — neither of which
 * passes it) keeps reading exactly as it did before this parameter existed.
 *
 * `api.player` is stubbed to reject for every tag, and `api.savedClans` to answer
 * with none — `useMemberNames` (`base-labels.ts`) treats both as "leave it
 * unnamed", so every base in these tests renders as its own tag. That is fine: the
 * property under test is the *set* of tags, not the names resolved for them.
 */

installTestCleanup()

function Probe({
  owners,
  bases,
  extraTags,
  onResult,
}: {
  owners: readonly { tag: string }[]
  bases: []
  extraTags?: readonly string[]
  onResult: (result: BaseLabels) => void
}) {
  const result = useBaseLabels(owners, bases, extraTags)
  onResult(result)
  return null
}

function mount(
  owners: readonly { tag: string }[],
  extraTags?: readonly string[],
): () => BaseLabels {
  stubApi({
    savedClans: async () => ({ clans: [] }),
    player: async () => {
      throw new Error('not stubbed for this test')
    },
  })

  let latest: BaseLabels | undefined
  render(
    <Probe
      owners={owners}
      bases={[]}
      extraTags={extraTags}
      onResult={(result) => {
        latest = result
      }}
    />,
  )

  return () => {
    assert.ok(latest, 'useBaseLabels never rendered a result')
    return latest
  }
}

/** Lets the member-name fetch effect settle before the result is read. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useBaseLabels', () => {
  it('adds extraTags to the tag set alongside the owner assignments', async () => {
    const result = mount([{ tag: '#OWNED1' }], ['#EXTRA1', '#EXTRA2'])
    await settle()

    assert.deepEqual(result().tags, ['#EXTRA1', '#EXTRA2', '#OWNED1'])
  })

  it('deduplicates a tag present in both the owner assignments and extraTags', async () => {
    const result = mount([{ tag: '#SHARED' }], ['#SHARED', '#EXTRA1'])
    await settle()

    assert.deepEqual(result().tags, ['#EXTRA1', '#SHARED'])
  })

  it('is unaffected by the new parameter when extraTags is omitted', async () => {
    const result = mount([{ tag: '#OWNED1' }, { tag: '#OWNED2' }])
    await settle()

    assert.deepEqual(result().tags, ['#OWNED1', '#OWNED2'])
  })

  it('labels an extra tag the same fallback-to-tag way an owner tag would be', async () => {
    const result = mount([], ['#EXTRA1'])
    await settle()

    assert.equal(result().labelOf('#EXTRA1'), '#EXTRA1')
    assert.ok(result().options.some((option) => option.tag === '#EXTRA1'))
  })
})
