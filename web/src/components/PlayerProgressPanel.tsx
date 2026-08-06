import { useMemo, useState, type FormEvent } from 'react'
import type {
  MaxLevelReferenceRow,
  ProgressSnapshot,
  SessionUser,
  UnitCategory,
  UnitLevel,
  WallReferenceRow,
} from '@coc/shared'
import { formatBuildingsLeft, parseBuildingsLeft, type BuildingsLeftValue } from '../buildings-left.ts'
import { baseOwnerOf, cardEntryAccess } from '../card-entry.ts'
import { describe } from '../api.ts'
import { formatDate } from '../format.ts'
import { ownerRecordFor, useOwners } from '../owners.ts'
import { combineSnapshotNotes } from '../progress-diff.ts'
import { percentToMax, wallProgress } from '../progress-percent.ts'
import { saveProgressManual, useProgressHistory, useProgressReference } from '../progress.ts'
import { excludeSuperTroops } from '../super-troops.ts'
import { artKindFor, isMaxed, unitFraction } from '../unit-display.ts'
import { isWallLevelInRange, wallCapFor, wallsTotal } from '../wall-entry.ts'
import { artFor } from '../wiki-art.ts'
import { ErrorPanel, GameIcon, Loading, TownHallBadge } from './primitives.tsx'

/**
 * This base's weekly progress: Town Hall, heroes, pets, equipment and walls, newest
 * week first — the hand-typed half of the spreadsheet this feature replaces.
 *
 * Structured after `PlayerCardPanel`: a `<details className="group">` so a base
 * nobody has captured yet costs one collapsed line, not an empty form thrust in
 * front of every stat on the page. Unlike the card grid there are no plaques kept
 * outside the disclosure — a handful of weekly rows is not sixty tiles, and there is
 * no second reason (a trade to notice) to surface anything before it is opened.
 *
 * **Ownership is the same question `BaseCardEditor` already answers**, not a second
 * copy of it: `server/src/progress/routes.ts` gates the manual-save route with the
 * exact `mayWriteBaseCounts` the card grid uses, "not a second copy of it" in its own
 * words, so the client mirrors that decision the same way — `cardEntryAccess` and
 * `baseOwnerOf`, imported from `card-entry.ts` rather than reimplemented here. A
 * refusal is still handled defensively on submit (an admin can reassign a base while
 * this tab is open), which is why a 403's message — naming the real owner — is what
 * the failure notice below shows verbatim.
 */

const CATEGORY_TITLES: Record<UnitCategory, string> = {
  hero: 'Heroes',
  pet: 'Pets',
  troop: 'Troops',
  spell: 'Spells',
  equipment: 'Equipment',
}

/**
 * One auto-captured category's units for one week, read-only.
 *
 * A Super Troop's level is derived from its base troop's, not tracked on its
 * own, so it is filtered out before scoring — showing it as a second row
 * would just repeat the base troop's row under a different name.
 *
 * A unit at its TH-relative cap renders compact: icon, its name as hover
 * text, and the number — no meter, no repeated level breakdown. Everything
 * else keeps the fuller row so partial progress is still visible. The TH
 * level itself is not restated per row; `WeekRow` says it once for the whole
 * week.
 */
function CategorySection({
  category,
  units,
  thLevel,
  reference,
}: {
  category: UnitCategory
  units: UnitLevel[]
  thLevel: number
  reference: MaxLevelReferenceRow[]
}) {
  const filtered = useMemo(
    () => (category === 'troop' ? excludeSuperTroops(units) : units),
    [units, category],
  )
  const scored = useMemo(
    () => percentToMax(filtered, category, thLevel, reference),
    [filtered, category, thLevel, reference],
  )
  if (filtered.length === 0) return null

  return (
    <div className="progress-category">
      <h4 className="progress-category__title">{CATEGORY_TITLES[category]}</h4>
      <ul className="progress-category__units">
        {scored.units.map((unit) => {
          const art = artFor(artKindFor(category), unit.name)
          const maxed = isMaxed(unit)
          const label = maxed ? '100%' : unitFraction(unit)
          return (
            <li
              key={unit.name}
              className={maxed ? 'progress-unit progress-unit--maxed' : undefined}
            >
              {art ? <GameIcon src={art} className="art-icon" /> : null}
              <span>{unit.name}</span>
              <span>{label}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** This week's walls, read-only, against whatever cap `wallProgress` can find. */
function WallsSection({
  walls,
  thLevel,
  reference,
}: {
  walls: Record<string, number>
  thLevel: number
  reference: WallReferenceRow[]
}) {
  const progress = useMemo(() => wallProgress(walls, thLevel, reference), [walls, thLevel, reference])
  const levels = [...progress.levels].sort((a, b) => Number(b.level) - Number(a.level))

  return (
    <div className="progress-category">
      <h4 className="progress-category__title">Walls</h4>
      <p className="card-meta">
        {progress.percent === null
          ? `${progress.totalHeld} recorded`
          : `${progress.atMax}/${progress.reference?.totalWallCount} at max — ${Math.round(progress.percent)}%`}
      </p>
      <ul className="progress-category__units">
        {levels.map((level) => (
          <li key={level.level}>
            <span>Level {level.level}</span>
            <span>{level.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One captured week, read-only. The edit form above targets the newest of these. */
function WeekRow({
  snapshot,
  maxLevels,
  walls: wallReference,
}: {
  snapshot: ProgressSnapshot
  maxLevels: MaxLevelReferenceRow[]
  walls: WallReferenceRow[]
}) {
  const notes = combineSnapshotNotes(snapshot)

  return (
    <div className="progress-week">
      <div className="progress-week__header">
        <span className="progress-week__date">{formatDate(snapshot.weekStart)}</span>
        {snapshot.thLevel === null ? (
          <span className="card-meta">Town Hall not yet auto-captured</span>
        ) : (
          <TownHallBadge level={snapshot.thLevel} text={`TH ${snapshot.thLevel}`} />
        )}
      </div>

      {/* Said once per week rather than once per row below — a base's TH can
          differ from one week's snapshot to the next, so this belongs here,
          not once for the whole panel. */}
      {snapshot.thLevel !== null ? (
        <p className="card-meta">Levels shown are relative to TH{snapshot.thLevel}.</p>
      ) : null}

      {snapshot.thLevel !== null && snapshot.heroes ? (
        <CategorySection
          category="hero"
          units={snapshot.heroes}
          thLevel={snapshot.thLevel}
          reference={maxLevels}
        />
      ) : null}
      {snapshot.thLevel !== null && snapshot.pets ? (
        <CategorySection
          category="pet"
          units={snapshot.pets}
          thLevel={snapshot.thLevel}
          reference={maxLevels}
        />
      ) : null}
      {snapshot.thLevel !== null && snapshot.troops ? (
        <CategorySection
          category="troop"
          units={snapshot.troops}
          thLevel={snapshot.thLevel}
          reference={maxLevels}
        />
      ) : null}
      {snapshot.thLevel !== null && snapshot.spells ? (
        <CategorySection
          category="spell"
          units={snapshot.spells}
          thLevel={snapshot.thLevel}
          reference={maxLevels}
        />
      ) : null}
      {snapshot.thLevel !== null && snapshot.equipment ? (
        <CategorySection
          category="equipment"
          units={snapshot.equipment}
          thLevel={snapshot.thLevel}
          reference={maxLevels}
        />
      ) : null}
      {snapshot.walls && snapshot.thLevel !== null ? (
        <WallsSection walls={snapshot.walls} thLevel={snapshot.thLevel} reference={wallReference} />
      ) : null}

      <p className="card-meta">
        Buildings left: {snapshot.buildingsLeft ?? 'Not recorded'}
      </p>
      {notes.hasContent ? <p className="progress-week__notes">{notes.combined}</p> : null}
    </div>
  )
}

/** One row of the sparse `walls` map, mid-edit — a level and a count, both as text. */
interface WallRow {
  key: string
  level: string
  count: string
}

function wallsToRows(walls: Record<string, number> | null): WallRow[] {
  const entries = Object.entries(walls ?? {})
  if (entries.length === 0) return [{ key: crypto.randomUUID(), level: '', count: '' }]
  return entries
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, count]) => ({ key: crypto.randomUUID(), level, count: String(count) }))
}

/**
 * Rows to the sparse wire shape. A row with no level, or one that is not a whole
 * non-negative number, is dropped rather than sent — the same "whole request or
 * nothing coherent" stance `parseManualCapture` takes server-side, applied to one
 * row instead of the whole payload so an editor mid-typed-row does not block the
 * levels already finished.
 */
function rowsToWalls(rows: WallRow[]): Record<string, number> {
  const walls: Record<string, number> = {}
  for (const row of rows) {
    const level = row.level.trim()
    const count = Number(row.count)
    if (!/^\d+$/.test(level) || !Number.isFinite(count) || count < 0) continue
    walls[level] = Math.max(0, Math.trunc(count))
  }
  return walls
}

/**
 * "How many buildings are left" as a mode plus a count, not a bare text field. A
 * text field inviting `'LOTS'` or `'DONE!'` verbatim would need exact casing to be
 * accepted and would 400 on `'lots of upgrades'` with no clue why — a toggle between
 * the two literals and a number makes the three-way shape the only shape reachable,
 * which is what `buildings-left.ts` then serializes.
 */
function BuildingsLeftInput({
  value,
  onChange,
  disabled,
}: {
  value: BuildingsLeftValue
  onChange: (next: BuildingsLeftValue) => void
  disabled: boolean
}) {
  return (
    <div className="buildings-left" role="radiogroup" aria-label="Buildings left to upgrade">
      <label className="buildings-left__option">
        <input
          type="radio"
          name="buildingsLeftMode"
          checked={value.mode === 'count'}
          disabled={disabled}
          onChange={() => onChange({ mode: 'count', count: value.count })}
        />
        Count
      </label>
      {value.mode === 'count' ? (
        <input
          type="number"
          min={0}
          value={value.count}
          disabled={disabled}
          aria-label="How many buildings are left"
          onChange={(event) =>
            onChange({ mode: 'count', count: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })
          }
        />
      ) : null}
      <label className="buildings-left__option">
        <input
          type="radio"
          name="buildingsLeftMode"
          checked={value.mode === 'lots'}
          disabled={disabled}
          onChange={() => onChange({ mode: 'lots', count: 0 })}
        />
        Lots
      </label>
      <label className="buildings-left__option">
        <input
          type="radio"
          name="buildingsLeftMode"
          checked={value.mode === 'done'}
          disabled={disabled}
          onChange={() => onChange({ mode: 'done', count: 0 })}
        />
        Done!
      </label>
    </div>
  )
}

/**
 * The manual fields for the current week — walls, buildings left, notes — seeded
 * from the newest captured week so a running total (walls held, buildings still to
 * go) starts from where it last stood rather than from blank. Submitting always
 * writes into *this* week (the server decides which, from its own clock — see
 * `currentWeekStart`), merging field by field with whatever that week already holds.
 */
function ManualCaptureForm({
  tag,
  latest,
  wallReference,
  onSaved,
}: {
  tag: string
  latest: ProgressSnapshot | null
  /** The whole wall reference table — narrowed to this base's own TH below. */
  wallReference: WallReferenceRow[]
  onSaved: (snapshot: ProgressSnapshot) => void
}) {
  const [rows, setRows] = useState<WallRow[]>(() => wallsToRows(latest?.walls ?? null))
  const [buildingsLeft, setBuildingsLeft] = useState<BuildingsLeftValue>(() =>
    parseBuildingsLeft(latest?.buildingsLeft),
  )
  const [notes, setNotes] = useState(latest?.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  /*
   * This base's own wall cap, from the newest week's Town Hall — the same
   * signal the server validates against (`getLatestThLevel`). `null` when this
   * base has never been auto-captured, or the wiki refresh has not covered its
   * TH yet; either way there is nothing to bound the editor by, so it falls
   * back to the original unconstrained behavior rather than blocking entry on
   * data the server itself does not have.
   */
  const cap = useMemo(() => wallCapFor(latest?.thLevel ?? null, wallReference), [latest, wallReference])
  const total = useMemo(() => wallsTotal(rows.map((row) => row.count)), [rows])
  /*
   * Same figure the read-only weeks below show via `WallsSection` — reused
   * rather than re-derived, so "fully entered" and "fully at max" can never
   * disagree between the draft and what gets saved.
   */
  const draftProgress = useMemo(
    () =>
      typeof latest?.thLevel === 'number'
        ? wallProgress(rowsToWalls(rows), latest.thLevel, wallReference)
        : null,
    [rows, latest, wallReference],
  )
  const overCap = cap !== null && total > cap.totalWallCount
  const anyLevelOutOfRange = useMemo(
    () => rows.some((row) => !isWallLevelInRange(row.level, cap)),
    [rows, cap],
  )

  function updateRow(key: string, patch: Partial<Pick<WallRow, 'level' | 'count'>>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting || overCap || anyLevelOutOfRange) return

    setSubmitting(true)
    setProblem(null)
    try {
      const snapshot = await saveProgressManual(tag, {
        walls: rowsToWalls(rows),
        buildingsLeft: formatBuildingsLeft(buildingsLeft),
        notes,
      })
      onSaved(snapshot)
    } catch (cause) {
      // The server's own sentence, verbatim — a 403 here names the real owner
      // (`mayWriteBaseCounts`), which is more useful than any wording of our own.
      setProblem(describe(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="progress-form" onSubmit={(event) => void submit(event)}>
      <div className="progress-form__field">
        <span className="progress-form__label">Buildings left</span>
        <BuildingsLeftInput value={buildingsLeft} onChange={setBuildingsLeft} disabled={submitting} />
      </div>

      <div className="progress-form__field">
        <span className="progress-form__label">
          Walls at each level
          {cap ? (
            <span className="card-meta">
              {' · '}
              {draftProgress?.percent === 100
                ? `${draftProgress.atMax}/${cap.totalWallCount} at max — 100%`
                : `${total}/${cap.totalWallCount} walls entered`}
            </span>
          ) : null}
        </span>
        <div className="progress-walls-editor">
          {rows.map((row) => {
            const levelValid = isWallLevelInRange(row.level, cap)
            return (
              <div className="progress-walls-editor__row" key={row.key}>
                <input
                  type="number"
                  min={1}
                  max={cap?.maxWallLevel}
                  placeholder="Level"
                  value={row.level}
                  disabled={submitting}
                  aria-label="Wall level"
                  aria-invalid={levelValid ? undefined : true}
                  onChange={(event) => updateRow(row.key, { level: event.target.value })}
                />
                <input
                  type="number"
                  min={0}
                  placeholder="Count"
                  value={row.count}
                  disabled={submitting}
                  aria-label="Walls at this level"
                  onChange={(event) => updateRow(row.key, { count: event.target.value })}
                />
                <button
                  type="button"
                  className="icon-button"
                  disabled={submitting}
                  aria-label="Remove this wall level"
                  onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
                >
                  Remove
                </button>
                {!levelValid && cap ? (
                  <span className="card-meta">Max wall level for TH{cap.thLevel} is {cap.maxWallLevel}</span>
                ) : null}
              </div>
            )
          })}
          <button
            type="button"
            className="icon-button"
            disabled={submitting}
            onClick={() => setRows((current) => [...current, { key: crypto.randomUUID(), level: '', count: '' }])}
          >
            + Add wall level
          </button>
        </div>
        {overCap && cap ? (
          <div className="notice notice--error">
            <p className="notice__body">
              {total} walls entered, above the {cap.totalWallCount} TH{cap.thLevel} can hold.
            </p>
          </div>
        ) : null}
      </div>

      <label className="progress-form__field">
        <span className="progress-form__label">Notes</span>
        <textarea
          className="progress-form__notes"
          value={notes}
          disabled={submitting}
          rows={3}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>

      {problem ? (
        <div className="notice notice--error">
          <p className="notice__title">Nothing was saved</p>
          <p className="notice__body">{problem}</p>
        </div>
      ) : null}

      <button type="submit" disabled={submitting || overCap || anyLevelOutOfRange}>
        {submitting ? 'Saving…' : 'Save this week'}
      </button>
    </form>
  )
}

export function PlayerProgressPanel({
  tag,
  name,
  user,
}: {
  tag: string
  name: string
  /** Only a base's owner, or an admin, may enter this week's manual fields. */
  user: SessionUser
}) {
  /* Subscribed rather than read once, so an admin reassigning this base flips the
     form between offered and read-only without a reload — the same reactivity
     `PlayerCardPanel` gets from the same store. */
  const owners = useOwners()
  const access = useMemo(
    () => cardEntryAccess(user, baseOwnerOf(ownerRecordFor(owners, tag)), tag),
    [user, owners, tag],
  )

  /* Bumped after a successful save to force `useProgressHistory` to refetch — see
     the note on that hook for why a dependency-array bump is the mechanism rather
     than a second store. */
  const [reloadToken, setReloadToken] = useState(0)
  const state = useProgressHistory(tag, reloadToken)

  /* The reference tables, cached at module scope — see `useProgressReference` in
     `progress.ts`. A load still under way, or one that failed, is not a reason to
     hide the history: `percentToMax` and `wallProgress` already treat an empty
     reference as an ordinary answer, so every week below falls back to the bare
     captured level exactly as it did before this route existed. */
  const reference = useProgressReference()

  return (
    <section className="card">
      <h2 className="section-title">Weekly progress</h2>

      {state.status === 'loading' || state.status === 'idle' ? (
        <Loading what={`${name}'s progress history`} />
      ) : state.status === 'error' ? (
        <ErrorPanel error={state.error} />
      ) : (
        <details className="group">
          <summary>
            {access.writable ? "This week's update" : 'Progress history'}
            {state.data.length === 0 ? (
              <span className="card-meta">
                {' · '}
                Nothing recorded yet{access.writable ? ' — open to enter this week’s update' : ''}
              </span>
            ) : (
              <span className="card-meta">
                {' · '}
                {state.data.length} week{state.data.length === 1 ? '' : 's'} recorded
              </span>
            )}
          </summary>

          <div className="group__body">
            {access.writable ? (
              <ManualCaptureForm
                tag={tag}
                latest={state.data[0] ?? null}
                wallReference={reference.walls}
                onSaved={() => setReloadToken((count) => count + 1)}
              />
            ) : (
              <div className="notice">
                <p className="notice__title">Read-only</p>
                <p className="notice__body">{access.message}</p>
              </div>
            )}

            {state.data.map((snapshot) => (
              <WeekRow
                key={snapshot.weekStart}
                snapshot={snapshot}
                maxLevels={reference.maxLevels}
                walls={reference.walls}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  )
}
