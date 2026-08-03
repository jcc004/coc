/**
 * What this bundle can say about its own age, and how much of it to show to whom.
 *
 * The values are baked in by `vite.config.ts` at build time — see the note there for
 * why they are not fetched from the server. This module turns them into something a
 * footer can print, and it exists as a tested module for one reason: **every field can
 * be absent**, and the wrong answer to that is a footer confidently reading
 * "Updated Invalid Date" or "Updated 56 years ago". A deploy from a tarball, a shallow
 * clone with no history, or an image without git all produce empty strings here.
 *
 * The split by role is deliberate. Everybody sees *when*, because "is what I am looking
 * at current" is a fair question for any user. Only an admin sees *which commit*, and
 * *when it was built* as distinct from when it was written — those two are diagnostic,
 * they mean nothing without a repository to look them up in, and the pair is what
 * answers "did my deploy actually run" when the commit date is old but the build is
 * minutes old.
 */

declare const __BUILD_COMMIT__: string
declare const __BUILD_COMMIT_DATE__: string
declare const __BUILD_TIME__: string

/** What the build knew about itself. Any field may be an empty string. */
export interface BuildInfo {
  commit: string
  commitDate: string
  builtAt: string
}

/** The values this bundle was compiled with. */
export function buildInfo(): BuildInfo {
  return {
    commit: __BUILD_COMMIT__,
    commitDate: __BUILD_COMMIT_DATE__,
    builtAt: __BUILD_TIME__,
  }
}

/** A timestamp only if it is one. Guards against `new Date('')` — an Invalid Date. */
export function parseStamp(raw: string): Date | null {
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

/** What the footer prints, by role. `null` means print nothing at all. */
export interface BuildLine {
  /** The headline, e.g. `Updated 3 Aug 2026, 17:42`. */
  updated: string
  /** Full timestamp for the tooltip, or `null` when there is no date to show. */
  exact: string | null
  /**
   * The admin-only tail: the commit, and the build time when it differs from the
   * commit date by more than a rebuild's worth. `null` for a non-admin, and for an
   * admin when the build knew nothing worth adding.
   */
  detail: string | null
}

/**
 * How far apart the commit and the build have to be before saying both.
 *
 * Building a commit minutes after making it is the normal case and printing both
 * would be noise. An hour apart means the build lagged the code, which is exactly what
 * somebody checking a deploy wants to see.
 */
export const BUILD_LAG_WORTH_SHOWING_MS = 60 * 60 * 1000

/**
 * The footer's line, or `null` when the build knew nothing.
 *
 * Returning `null` rather than "Updated unknown" is the point: a footer that admits it
 * cannot tell you is fine, but one that says something vacuous in the same place a real
 * date goes trains people to stop reading it. An admin still gets the commit if there is
 * one, because a hash with no date is useful and a date with no hash is too.
 */
export function buildLine(
  info: BuildInfo,
  isAdmin: boolean,
  format: (date: Date) => string,
  formatExact: (date: Date) => string = (date) => date.toLocaleString(),
): BuildLine | null {
  const committed = parseStamp(info.commitDate)
  const built = parseStamp(info.builtAt)

  const detail: string[] = []
  if (isAdmin) {
    if (info.commit) detail.push(info.commit)
    if (
      built &&
      (!committed || Math.abs(built.getTime() - committed.getTime()) > BUILD_LAG_WORTH_SHOWING_MS)
    ) {
      detail.push(`built ${format(built)}`)
    }
  }

  if (!committed) {
    // No usable date. An admin with a commit still gets something worth having.
    if (detail.length === 0) return null
    return { updated: 'Build', exact: null, detail: detail.join(' · ') }
  }

  return {
    updated: `Updated ${format(committed)}`,
    exact: formatExact(committed),
    detail: detail.length > 0 ? detail.join(' · ') : null,
  }
}
