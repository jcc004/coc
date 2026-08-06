import { useEffect, useMemo, useState } from 'react'
import type { BaseInventory } from '@coc/shared'
import { api } from './api.ts'
import { baseOptions, type BaseOption } from './base-names.ts'
import { useSavedClans } from './saved-clans.ts'

/**
 * Turning the tracked base tags into names on screen.
 *
 * A base is a player tag, and a tag tells you nothing — `#2GCJ2QPU` is not who you
 * go and talk to. This is the fetching half; every rule about how a base is
 * *written* stays pure and tested in `base-names.ts`.
 *
 * It lives here rather than in `CardsView` because **two pages name bases now**: the
 * card page's picker, leaderboard and trade table, and the player page's trade
 * table, which names the partner on the other side of each swap. Both must read the
 * same, right down to the `(#TAG)` suffix a shared name gets — two copies of the
 * fetch would give one page names the other lacked the first time either was
 * touched.
 */

/**
 * Member names for every base, keyed by player tag.
 *
 * A base *is* a clan member, so the name to show is the one the roster shows. The
 * saved clans are where the owner assignments came from in the first place, so their
 * rosters are where the names are: one request per saved clan covers every base in
 * it, rather than one request per base.
 *
 * Sequential, like the saved-clans refresh, to keep the upstream rate limit
 * comfortable. A clan that will not load simply leaves its members unnamed — the
 * base falls back to its tag and the page carries on, because a name is a
 * convenience and the tag is the identity.
 */
export function useMemberNames(baseTags: readonly string[]): Map<string, string> {
  const clans = useSavedClans()
  /* Joined into strings so the effect re-runs on a change of *which* clans or
     bases, not on every re-render of the stores' arrays. */
  const clanKey = useMemo(() => clans.map((clan) => clan.tag).sort().join(','), [clans])
  const baseKey = useMemo(() => [...baseTags].sort().join(','), [baseTags])
  const [names, setNames] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!baseKey) return
    const controller = new AbortController()

    void (async () => {
      const found = new Map<string, string>()

      for (const clanTag of clanKey ? clanKey.split(',') : []) {
        try {
          const { items } = await api.clanMembers(clanTag, controller.signal)
          for (const member of items) found.set(member.tag, member.name)
        } catch {
          // Unnamed is a fine outcome; failing the whole page is not.
        }
      }

      /*
       * Anything the rosters did not cover, asked for directly. A base only has to
       * be in a *saved* clan for the sweep above to name it, and an owner can be set
       * on a base whose clan nobody saved — or who has since left. One request each,
       * and only for the leftovers, so the common case still costs one request per
       * clan rather than one per base.
       */
      for (const tag of baseKey.split(',')) {
        if (found.has(tag) || controller.signal.aborted) continue
        try {
          const player = await api.player(tag, controller.signal)
          found.set(tag, player.name)
        } catch {
          // A tag the API will not resolve keeps showing as a tag.
        }
      }

      if (!controller.signal.aborted) setNames(found)
    })()

    return () => controller.abort()
  }, [clanKey, baseKey])

  return names
}

export interface BaseLabels {
  /** Every tracked base, ascending by tag. The identity, and the fetch's input. */
  tags: string[]
  /** The same bases as offerable options, ordered by label. For a picker. */
  options: BaseOption[]
  /** Tag → the text to print for it. Falls back to the tag, which is never empty. */
  labelOf: (tag: string) => string
}

const NO_EXTRA_TAGS: readonly string[] = []

/**
 * The tracked bases, named.
 *
 * **The tags are the owner assignments**, not the bases that happen to have counts —
 * otherwise a base nobody had entered yet could never be chosen, and the entry
 * screen would have nothing to start from. Any base that somehow has counts without
 * an assignment is added anyway, so its rows are never orphaned off the screen.
 *
 * Names are resolved over **every** tracked base, never a filtered subset: the
 * labels have to read the same in a picker, a leaderboard and a trade table on two
 * different pages, and a name shared by two bases must still get its `(#TAG)` suffix
 * when the caller happens to be showing only one of them.
 *
 * `extraTags` is purely additive and defaults to empty, so every existing caller
 * (cards, trades) is unaffected. It exists for `ProgressGridView`, which — unlike
 * cards and trades — is not meant to be owner-gated: progress-tracking reads
 * straight off the live API with no ownership question involved, so the board wants
 * every clan member the server has ever captured a row for, not just the ones
 * somebody has claimed. Passing that wider set here, rather than duplicating this
 * function's tag/name/label machinery in a progress-local copy, is what keeps the
 * two pages' labels reading the same way for a base both happen to show.
 */
export function useBaseLabels(
  owners: readonly { tag: string }[],
  bases: readonly BaseInventory[],
  extraTags: readonly string[] = NO_EXTRA_TAGS,
): BaseLabels {
  const tags = useMemo(() => {
    const all = new Set(owners.map((entry) => entry.tag))
    for (const base of bases) all.add(base.tag)
    for (const tag of extraTags) all.add(tag)
    return [...all].sort()
  }, [owners, bases, extraTags])

  const memberNames = useMemberNames(tags)

  const options = useMemo(
    () => baseOptions(tags.map((tag) => ({ tag, name: memberNames.get(tag) }))),
    [tags, memberNames],
  )

  const labelOf = useMemo(() => {
    const byTag = new Map(options.map((option) => [option.tag, option.label]))
    return (tag: string) => byTag.get(tag) ?? tag
  }, [options])

  return { tags, options, labelOf }
}
