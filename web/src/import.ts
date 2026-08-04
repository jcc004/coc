import { useEffect, useState } from 'react'
import { normalizeTag, type ImportRequest, type ImportResponse } from '@coc/shared'
import { api } from './api.ts'
import { migrateLegacySaved, reloadOwners } from './owners.ts'
import { reloadSavedClans } from './saved-clans.ts'

/**
 * The one-time hand-off of whatever a browser still holds in `localStorage`, now
 * that saved clans and owners live on the server.
 *
 * Two independent guards against applying it twice:
 *
 * - this flag, which saves the round trip;
 * - the server endpoint itself, which **fills gaps only** and is therefore
 *   idempotent whatever the client does. That is the guard that matters. With
 *   shared data and several people importing at once, an overwriting import would
 *   mean whoever signed in last silently won every disagreement.
 *
 * The `localStorage` keys are read and never cleared. If the import turns out to
 * have been wrong, the original data is still sitting there.
 */

const FLAG_KEY = 'coc:importedToServer'
const OWNERS_KEY = 'coc:owners'
const CLANS_KEY = 'coc:savedClans'
/** The pre-owners key, still worth carrying if a browser skipped that migration. */
const LEGACY_KEY = 'coc:saved'

function parseArray(raw: string | null): unknown[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Turns the raw stored JSON into the request body. Pure, and separate from the
 * reading of `localStorage`, so it can be tested against what a browser might
 * really be holding rather than what it ought to be.
 */
export function buildImportPayload(
  ownersRaw: string | null,
  clansRaw: string | null,
  legacyRaw: string | null = null,
): ImportRequest {
  // `coc:owners` wins where both exist; the legacy key only fills what it lacks.
  const owners = new Map<string, string>()
  for (const source of [migrateLegacySaved(legacyRaw), migrateLegacySaved(ownersRaw)]) {
    for (const entry of source) owners.set(entry.tag, entry.owner)
  }

  const clans: NonNullable<ImportRequest['clans']> = []
  const seen = new Set<string>()

  for (const raw of parseArray(clansRaw)) {
    const entry = asRecord(raw)
    if (!entry) continue

    const name = asString(entry['name']).trim()
    if (!name) continue

    let tag: string
    try {
      tag = normalizeTag(asString(entry['tag']))
    } catch {
      continue
    }
    if (seen.has(tag)) continue
    seen.add(tag)

    const clan: NonNullable<ImportRequest['clans']>[number] = { tag, name }
    if (entry['custom'] === true) clan.custom = true

    const clanLevel = asNumber(entry['clanLevel'])
    if (clanLevel !== undefined) clan.clanLevel = clanLevel
    const members = asNumber(entry['members'])
    if (members !== undefined) clan.members = members
    const clanPoints = asNumber(entry['clanPoints'])
    if (clanPoints !== undefined) clan.clanPoints = clanPoints
    const warLeague = asString(entry['warLeague']).trim()
    if (warLeague) clan.warLeague = warLeague

    clans.push(clan)
  }

  return {
    owners: [...owners].map(([tag, owner]) => ({ tag, owner })),
    clans,
  }
}

/** Nothing to say and nothing to send. */
export function isImportEmpty(payload: ImportRequest): boolean {
  return (payload.owners?.length ?? 0) === 0 && (payload.clans?.length ?? 0) === 0
}

/** A one-line human summary of what the server did with it. */
export function describeImport(result: ImportResponse): string {
  const parts: string[] = []
  const say = (counts: { applied: number; skipped: number }, noun: string) => {
    if (counts.applied > 0) parts.push(`${counts.applied} ${noun} added`)
    if (counts.skipped > 0) parts.push(`${counts.skipped} ${noun} already on the server, left alone`)
  }

  say(result.owners, 'owner assignment' + (result.owners.applied === 1 ? '' : 's'))
  say(result.clans, 'saved clan' + (result.clans.applied === 1 ? '' : 's'))

  return parts.length > 0
    ? `Imported this browser's data — ${parts.join(', ')}.`
    : 'This browser had nothing left to import.'
}

/**
 * Sends the payload once, then records the flag. The flag is set only on success,
 * so a failed import is retried on the next sign-in rather than silently lost.
 */
export async function runOneTimeImport(): Promise<ImportResponse | null> {
  if (localStorage.getItem(FLAG_KEY) === 'done') return null

  const payload = buildImportPayload(
    localStorage.getItem(OWNERS_KEY),
    localStorage.getItem(CLANS_KEY),
    localStorage.getItem(LEGACY_KEY),
  )

  if (isImportEmpty(payload)) {
    // Nothing here to carry over; mark it so this never runs again either.
    localStorage.setItem(FLAG_KEY, 'done')
    return null
  }

  const result = await api.importBrowserData(payload)
  localStorage.setItem(FLAG_KEY, 'done')

  // The two stores may already have loaded the pre-import lists.
  await Promise.all([reloadOwners(), reloadSavedClans()])
  return result
}

/**
 * Runs the import once a session exists, and hands back a line to show. Returns
 * `null` when there was nothing to do, which is the case for everybody after the
 * first time.
 */
export function useOneTimeImport(signedIn: boolean): {
  summary: string | null
  dismiss: () => void
} {
  const [summary, setSummary] = useState<string | null>(null)

  useEffect(() => {
    if (!signedIn) return

    let canceled = false
    runOneTimeImport().then(
      (result) => {
        if (!canceled && result) setSummary(describeImport(result))
      },
      (cause: unknown) => {
        // Worth saying out loud: the flag is not set, so it will try again, but
        // meanwhile this browser's data is not on the server yet.
        if (!canceled) {
          setSummary(
            `Could not import this browser's saved data (${
              (cause as Error)?.message ?? 'request failed'
            }). It will be retried next time you sign in.`,
          )
        }
      },
    )

    return () => {
      canceled = true
    }
  }, [signedIn])

  return { summary, dismiss: () => setSummary(null) }
}
