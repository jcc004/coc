/**
 * Naming the bases on the card page.
 *
 * A base is a player tag, and a tag tells you nothing — `#2GCJ2QPU` is not who
 * you go and talk to. The name a base answers to is its **clan member name**, so
 * the labels come from the saved clans' rosters; `CardsView` does the fetching and
 * hands the result in here, which keeps every rule about how a base is *written*
 * pure and testable.
 *
 * Tags stay the identity throughout — the select's values, the inventory keys and
 * the trade suggestions are all still tags. This module only decides the text.
 */

export interface NamedBase {
  tag: string
  /** The member name, when a roster we can see has this tag on it. */
  name?: string
}

export interface BaseOption {
  tag: string
  label: string
}

/**
 * Collision key for two bases "having the same name".
 *
 * Case- and space-insensitive on purpose: `darek` and `Darek ` are different
 * accounts, and showing them as two identical-looking entries is exactly the
 * confusion the tag suffix exists to prevent.
 */
function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * The base list, in the order it should be offered, each with the text to show.
 *
 * - a named base shows its name
 * - a name shared by more than one base shows `Name (#TAG)`, because otherwise
 *   the two entries are indistinguishable
 * - a base no visible roster names shows its tag, which is all there is
 *
 * Ordered by the label rather than by tag: a list of names sorted by their hidden
 * tags looks shuffled. Unnamed bases sort after named ones — they are the ones
 * you cannot act on without looking something up. The tag breaks any remaining
 * tie so the order is total and cannot flicker between renders.
 */
export function baseOptions(bases: NamedBase[]): BaseOption[] {
  const shared = new Set<string>()
  const seen = new Set<string>()
  for (const base of bases) {
    const name = base.name?.trim()
    if (!name) continue
    const key = nameKey(name)
    if (seen.has(key)) shared.add(key)
    else seen.add(key)
  }

  return bases
    .map((base) => {
      const name = base.name?.trim()
      if (!name) return { tag: base.tag, label: base.tag, named: false }
      const label = shared.has(nameKey(name)) ? `${name} (${base.tag})` : name
      return { tag: base.tag, label, named: true }
    })
    .sort((a, b) => {
      if (a.named !== b.named) return a.named ? -1 : 1
      const byLabel = a.label.localeCompare(b.label)
      return byLabel !== 0 ? byLabel : a.tag.localeCompare(b.tag)
    })
    .map(({ tag, label }) => ({ tag, label }))
}
