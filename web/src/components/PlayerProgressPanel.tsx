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
import { seriesStyle, wallLevelColor } from '../chart-colors.ts'
import { formatDate } from '../format.ts'
import { ownerRecordFor, useOwners } from '../owners.ts'
import { combineSnapshotNotes } from '../progress-diff.ts'
import {
  buildCategorySeries,
  buildThUpgrades,
  buildTroopHeatmap,
  buildTroopPercentSeries,
  buildWallsSeries,
} from '../progress-history.ts'
import { percentToMax, wallProgress, type WallProgress } from '../progress-percent.ts'
import { saveProgressManual, useProgressHistory, useProgressReference } from '../progress.ts'
import { excludeSuperTroops } from '../super-troops.ts'
import { artKindFor, isMaxed, unitFraction } from '../unit-display.ts'
import { isWallLevelInRange, wallCapFor, wallsTotal } from '../wall-entry.ts'
import { rowsToWalls, useWallRows, type WallRow } from '../wall-rows.ts'
import { artFor } from '../wiki-art.ts'
import { LineChart, TroopHeatmap, type ChartSeries } from './charts.tsx'
import { ProgressCapRules } from './help-copy.tsx'
import { ErrorPanel, GameIcon, HelpLink, Loading, TownHallBadge } from './primitives.tsx'

/**
 * This base's weekly progress. Three things, top to bottom inside the
 * disclosure: the manual-entry form for *this* week, this week's full
 * detailed snapshot (every hero/pet/troop/spell/equipment level and every
 * wall, with icons — {@link CurrentWeekDetail}), and the historical charts
 * for the trend across every captured week. A collapsed disclosure for
 * correcting an older week's walls sits last, below everything else.
 *
 * **`CurrentWeekDetail` is a return, not new.** The very first version of this
 * panel printed every captured week as this same full block, newest first —
 * readable for a handful of weeks, an unreadable wall of text for months of
 * them, and no trend at all, which is what the chart rewrite (`charts.tsx`,
 * `progress-history.ts`) replaced it with. Live review asked for the detailed
 * block back, but only for the single newest week: a chart answers "what's
 * the trend," but "is this hero maxed right now" is what a reader actually
 * opens this panel to check day to day, and a raw-level line does not answer
 * that as directly as an icon and a fraction do. So the shape here is
 * **current status, then trend** — `CurrentWeekDetail` for the newest week,
 * `HistoryCharts` for everything captured, `WeekSummaryRow` for the
 * buildings-left/notes half of every *older* week (charts don't cover free
 * text or a plain count, same as before).
 *
 * **Bringing the detailed block back is also why the charts no longer mark a
 * "maxed" point.** An earlier round threaded a reference table into the
 * heroes chart so a maxed hero's marker switched color; the icon/fraction
 * block above the charts now says "maxed" in the same way it always used
 * to, so the chart carrying that signal too was a second copy of the same
 * fact for no reported second need — see `charts.tsx`'s doc comment for the
 * point-marker removal this rode along with.
 *
 * **Category order is heroes, pets, walls, spells, troops** for the charts
 * (troops last — its aggregate-line-plus-heatmap pairing is the biggest
 * block, so it reads naturally as the final section) and **heroes, pets,
 * troops, spells, equipment, walls** for `CurrentWeekDetail` — the order the
 * pre-chart version used, kept as-is on the restore rather than reordered to
 * match the charts, since nothing about bringing it back changed what order
 * made sense there.
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
 * the failure notice below shows verbatim. The past-week correction form at the
 * bottom is gated by the exact same `access.writable`, not a looser or separate check.
 */

const CATEGORY_TITLES: Record<UnitCategory, string> = {
  hero: 'Heroes',
  pet: 'Pets',
  troop: 'Troops',
  spell: 'Spells',
  equipment: 'Equipment',
}

/**
 * One auto-captured category's units for one week, read-only — the body of
 * {@link CurrentWeekDetail}.
 *
 * A Super Troop's level is derived from its base troop's, not tracked on its
 * own, so it is filtered out before scoring — showing it as a second row
 * would just repeat the base troop's row under a different name.
 *
 * A unit at its TH-relative cap renders compact: icon, its name as hover
 * text, and the number — no meter, no repeated level breakdown. Everything
 * else keeps the fuller row so partial progress is still visible. The TH
 * level itself is not restated per row; `CurrentWeekDetail` says it once for
 * the whole week.
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
            <li key={unit.name} className={maxed ? 'progress-unit progress-unit--maxed' : undefined}>
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

/** This week's walls, read-only, against whatever cap `wallProgress` can find — the other half of {@link CurrentWeekDetail}. */
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

/**
 * The single newest captured week, in full — see this file's module doc for
 * why this is a restore rather than something new, and why it is scoped to
 * one week rather than every week the way it used to be.
 */
function CurrentWeekDetail({
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
        <CategorySection category="hero" units={snapshot.heroes} thLevel={snapshot.thLevel} reference={maxLevels} />
      ) : null}
      {snapshot.thLevel !== null && snapshot.pets ? (
        <CategorySection category="pet" units={snapshot.pets} thLevel={snapshot.thLevel} reference={maxLevels} />
      ) : null}
      {snapshot.thLevel !== null && snapshot.troops ? (
        <CategorySection category="troop" units={snapshot.troops} thLevel={snapshot.thLevel} reference={maxLevels} />
      ) : null}
      {snapshot.thLevel !== null && snapshot.spells ? (
        <CategorySection category="spell" units={snapshot.spells} thLevel={snapshot.thLevel} reference={maxLevels} />
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

      <p className="card-meta">Buildings left: {snapshot.buildingsLeft ?? 'Not recorded'}</p>
      {notes.hasContent ? <p className="progress-week__notes">{notes.combined}</p> : null}
    </div>
  )
}

/** One category's raw-level line chart — heroes, pets or spells. */
function CategoryChart({
  category,
  title,
  history,
}: {
  category: 'hero' | 'pet' | 'spell'
  title: string
  history: ProgressSnapshot[]
}) {
  const { weeks, series } = useMemo(() => buildCategorySeries(history, category), [history, category])
  if (weeks.length === 0) return null

  const chartSeries: ChartSeries[] = series.map((entry, index) => ({
    id: entry.name,
    label: entry.name,
    points: entry.points,
    ...seriesStyle(index),
  }))

  return (
    <div className="progress-category">
      <h4 className="progress-category__title">{title}</h4>
      <LineChart weeks={weeks} series={chartSeries} ariaLabel={`${title} levels, by captured week`} />
    </div>
  )
}

/** One line per wall level the base has actually held — counts over time. */
function WallsChart({ history }: { history: ProgressSnapshot[] }) {
  const { weeks, series } = useMemo(() => buildWallsSeries(history), [history])
  if (weeks.length === 0) return null

  const chartSeries: ChartSeries[] = series.map((entry, index) => ({
    id: entry.name,
    label: `Level ${entry.name}`,
    points: entry.points,
    color: wallLevelColor(index, series.length),
  }))

  return (
    <div className="progress-category">
      <h4 className="progress-category__title">Walls</h4>
      <LineChart weeks={weeks} series={chartSeries} ariaLabel="Wall counts by level, by captured week" />
    </div>
  )
}

/**
 * Troops: too many (58 possible) for one raw-level line chart, so this is two
 * views instead — an aggregate percent-to-cap line (reusing `percentToMax`'s
 * `.percent`, the same figure the progress grid's "Walls at max" column
 * already trusts for a comparable reason) and the troop x week heatmap
 * drill-down underneath. Troops only started being captured for real in the
 * last few weeks, so both will often be sparse right now — see
 * `buildTroopPercentSeries`'s and `buildTroopHeatmap`'s own doc comments.
 */
function TroopsSection({
  history,
  reference,
}: {
  history: ProgressSnapshot[]
  reference: MaxLevelReferenceRow[]
}) {
  const percentSeries = useMemo(() => buildTroopPercentSeries(history, reference), [history, reference])
  const heatmap = useMemo(() => buildTroopHeatmap(history, reference), [history, reference])
  if (percentSeries.weeks.length === 0) return null

  return (
    <div className="progress-category">
      <h4 className="progress-category__title">Troops</h4>
      <LineChart
        weeks={percentSeries.weeks}
        series={[
          {
            id: 'troops-percent',
            label: 'Percent of troops maxed for this Town Hall',
            color: 'var(--series-1)',
            points: percentSeries.points,
          },
        ]}
        ariaLabel="Percent of troops maxed for this Town Hall, by captured week"
        yBounds={[0, 100]}
        yUnit="%"
        formatValue={(value) => String(Math.round(value))}
      />
      <TroopHeatmap
        weeks={heatmap.weeks}
        troopNames={heatmap.troopNames}
        matrix={heatmap.matrix}
        ariaLabel="Each troop's percent to cap, by captured week"
      />
    </div>
  )
}

/**
 * The always-visible Town Hall summary — see this file's module doc for why
 * TH gets a list instead of a chart, and why it sits outside `<details>`.
 * Shows the current level (from the newest week that actually captured one)
 * plus every captured upgrade, oldest first; a base with a TH capture but no
 * *upgrade* yet (a brand-new capture, or one that has only ever seen one
 * level) still shows the current level with an honest "no upgrades
 * captured yet" rather than an empty section.
 */
function OverallProgress({ history }: { history: ProgressSnapshot[] }) {
  const upgrades = useMemo(() => buildThUpgrades(history), [history])
  // `history` is newest-first (the server's order — see `HistoryCharts`'s own
  // note), so the first snapshot with a captured `thLevel` is the current one.
  const currentTh = history.find((snapshot) => snapshot.thLevel !== null)?.thLevel ?? null

  if (currentTh === null) return null

  return (
    <div className="progress-overview">
      <h3 className="progress-category__title">Overall progress</h3>
      <TownHallBadge level={currentTh} text={`Town Hall ${currentTh}`} />
      {upgrades.length === 0 ? (
        <p className="card-meta">No Town Hall upgrades captured yet.</p>
      ) : (
        <ul className="progress-th-upgrades">
          {upgrades.map((event) => (
            <li key={event.weekStart}>
              TH {event.from} → {event.to} — {formatDate(event.weekStart)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Every chart for one base's history — heroes, pets, walls, spells and
 * troops, in that order (see the module doc for why). `history` is handed
 * through as-is (newest-first, the server's order); every builder in
 * `progress-history.ts` re-sorts to oldest-first itself, so nothing here has
 * to. Town Hall is not among these — see {@link OverallProgress}, rendered
 * separately and outside `<details>` by `PlayerProgressPanel` below.
 */
function HistoryCharts({
  history,
  reference,
}: {
  history: ProgressSnapshot[]
  reference: { maxLevels: MaxLevelReferenceRow[] }
}) {
  return (
    <>
      <CategoryChart category="hero" title="Heroes" history={history} />
      <CategoryChart category="pet" title="Pets" history={history} />
      <WallsChart history={history} />
      <CategoryChart category="spell" title="Spells" history={history} />
      <TroopsSection history={history} reference={reference.maxLevels} />
    </>
  )
}

/**
 * One older captured week's hand-typed half, read-only — buildings left and
 * notes, the two fields a chart cannot show (free text, and a count with no
 * history worth trending on its own), plus the week's TH badge for quick
 * orientation. The newest week does not get one of these: it gets the full
 * {@link CurrentWeekDetail} instead, so `PlayerProgressPanel` only maps this
 * over `history.slice(1)` — showing both for the same week would say the
 * same buildings-left/notes twice.
 */
function WeekSummaryRow({ snapshot }: { snapshot: ProgressSnapshot }) {
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
      <p className="card-meta">Buildings left: {snapshot.buildingsLeft ?? 'Not recorded'}</p>
      {notes.hasContent ? <p className="progress-week__notes">{notes.combined}</p> : null}
    </div>
  )
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
 * The "walls at each level" field — row editor (add/remove, level+count inputs,
 * per-row range validation against `cap`) plus the running total, shared by
 * `ManualCaptureForm` (this week) and `PastWeekWallEditor` (a chosen earlier
 * week) below. `rows` and its mutators come from `useWallRows` (`wall-rows.ts`),
 * kept in the caller so each form owns its own edit session — this component
 * only renders what it's handed and reports edits back through the callbacks,
 * the same "component renders, caller owns state" split `progress-history.ts`'s
 * module doc describes for the charts.
 */
function WallsField({
  rows,
  onUpdateRow,
  onAddRow,
  onRemoveRow,
  cap,
  total,
  overCap,
  draftProgress,
  disabled,
}: {
  rows: WallRow[]
  onUpdateRow: (key: string, patch: Partial<Pick<WallRow, 'level' | 'count'>>) => void
  onAddRow: () => void
  onRemoveRow: (key: string) => void
  cap: WallReferenceRow | null
  total: number
  overCap: boolean
  /** `wallProgress`'s own figure against `cap`'s Town Hall — `null` when there is none to score against. */
  draftProgress: WallProgress | null
  disabled: boolean
}) {
  return (
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
                disabled={disabled}
                aria-label="Wall level"
                aria-invalid={levelValid ? undefined : true}
                onChange={(event) => onUpdateRow(row.key, { level: event.target.value })}
              />
              <input
                type="number"
                min={0}
                placeholder="Count"
                value={row.count}
                disabled={disabled}
                aria-label="Walls at this level"
                onChange={(event) => onUpdateRow(row.key, { count: event.target.value })}
              />
              <button
                type="button"
                className="icon-button"
                disabled={disabled}
                aria-label="Remove this wall level"
                onClick={() => onRemoveRow(row.key)}
              >
                Remove
              </button>
              {!levelValid && cap ? (
                <span className="card-meta">
                  Max wall level for TH{cap.thLevel} is {cap.maxWallLevel}
                </span>
              ) : null}
            </div>
          )
        })}
        <button type="button" className="icon-button" disabled={disabled} onClick={onAddRow}>
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
  const wallRows = useWallRows(latest?.walls ?? null)
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
  const total = useMemo(() => wallsTotal(wallRows.rows.map((row) => row.count)), [wallRows.rows])
  /*
   * Same figure `WallsSection` shows for the current week above — reused
   * rather than re-derived, so "fully entered" and "fully at max" can never
   * disagree between the draft and what gets saved.
   */
  const draftProgress = useMemo(
    () =>
      typeof latest?.thLevel === 'number'
        ? wallProgress(rowsToWalls(wallRows.rows), latest.thLevel, wallReference)
        : null,
    [wallRows.rows, latest, wallReference],
  )
  const overCap = cap !== null && total > cap.totalWallCount
  const anyLevelOutOfRange = useMemo(
    () => wallRows.rows.some((row) => !isWallLevelInRange(row.level, cap)),
    [wallRows.rows, cap],
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting || overCap || anyLevelOutOfRange) return

    setSubmitting(true)
    setProblem(null)
    try {
      const snapshot = await saveProgressManual(tag, {
        walls: rowsToWalls(wallRows.rows),
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

      <WallsField
        rows={wallRows.rows}
        onUpdateRow={wallRows.updateRow}
        onAddRow={wallRows.addRow}
        onRemoveRow={wallRows.removeRow}
        cap={cap}
        total={total}
        overCap={overCap}
        draftProgress={draftProgress}
        disabled={submitting}
      />

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

/**
 * One chosen week's wall-only correction, keyed by `weekStart` on
 * {@link PastWeekWallForm} so picking a different week remounts this with a
 * fresh edit session rather than carrying a half-typed row from the previous
 * choice into a new week's submit. Walls only — not buildings-left or notes —
 * on purpose: walls are the field this app's own history says gets mistyped
 * (`docs/progress-tracking.md`), and reusing {@link WallsField} rather than
 * building a second parallel editor is the point of factoring it out.
 *
 * Sends `weekStart` in the request body, which is what tells the server this
 * is a correction rather than an ordinary current-week save — see
 * `server/src/progress/routes.ts`'s `resolveTargetWeek`. The server appends
 * its own "corrected on" note to that week's `notes`; this form does not try
 * to preview or duplicate that text, since the server is the one place that
 * knows what actually landed.
 */
function PastWeekWallEditor({
  tag,
  snapshot,
  wallReference,
  onSaved,
}: {
  tag: string
  snapshot: ProgressSnapshot
  wallReference: WallReferenceRow[]
  onSaved: (snapshot: ProgressSnapshot) => void
}) {
  const wallRows = useWallRows(snapshot.walls)
  const [submitting, setSubmitting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // This week's *own* Town Hall, not the base's latest — the server scores the
  // same way (`resolveTargetWeek`'s doc comment explains why a since-upgraded
  // base must not have an old week's walls checked against today's cap).
  const cap = useMemo(() => wallCapFor(snapshot.thLevel, wallReference), [snapshot, wallReference])
  const total = useMemo(() => wallsTotal(wallRows.rows.map((row) => row.count)), [wallRows.rows])
  const draftProgress = useMemo(
    () =>
      typeof snapshot.thLevel === 'number'
        ? wallProgress(rowsToWalls(wallRows.rows), snapshot.thLevel, wallReference)
        : null,
    [wallRows.rows, snapshot, wallReference],
  )
  const overCap = cap !== null && total > cap.totalWallCount
  const anyLevelOutOfRange = useMemo(
    () => wallRows.rows.some((row) => !isWallLevelInRange(row.level, cap)),
    [wallRows.rows, cap],
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting || overCap || anyLevelOutOfRange) return

    setSubmitting(true)
    setProblem(null)
    setSaved(false)
    try {
      const next = await saveProgressManual(tag, {
        weekStart: snapshot.weekStart,
        walls: rowsToWalls(wallRows.rows),
      })
      setSaved(true)
      onSaved(next)
    } catch (cause) {
      setProblem(describe(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="progress-form" onSubmit={(event) => void submit(event)}>
      <WallsField
        rows={wallRows.rows}
        onUpdateRow={wallRows.updateRow}
        onAddRow={wallRows.addRow}
        onRemoveRow={wallRows.removeRow}
        cap={cap}
        total={total}
        overCap={overCap}
        draftProgress={draftProgress}
        disabled={submitting}
      />

      {problem ? (
        <div className="notice notice--error">
          <p className="notice__title">Nothing was saved</p>
          <p className="notice__body">{problem}</p>
        </div>
      ) : null}
      {saved && !problem ? (
        <p className="card-meta">Saved — {formatDate(snapshot.weekStart)}’s walls were corrected.</p>
      ) : null}

      <button type="submit" disabled={submitting || overCap || anyLevelOutOfRange}>
        {submitting ? 'Saving…' : `Save correction to ${formatDate(snapshot.weekStart)}`}
      </button>
    </form>
  )
}

/**
 * Correcting an already-captured week's walls, rather than entering this
 * week's — a real gap the panel had no answer for before: walls are
 * hand-typed and do get mistyped (`docs/progress-tracking.md`'s own history
 * section), and until now the only way back was asking someone to touch the
 * database directly. Its own nested `<details>`, tucked below everything
 * else on the panel — the same "administrative control stays collapsed"
 * precedent `TradeSuggestions`' "What makes a swap legal" disclosure sets
 * inside `PlayerCardPanel`'s own `<details>`: a person fixing a typo from
 * three weeks ago is not the common reason this panel gets opened.
 *
 * The week picker offers every week `useProgressHistory` already has
 * client-side (no second fetch) rather than only the ones "before today" —
 * the server's own clock is the one place that decides what the current week
 * even is (never the request, matching every other server-owned value in
 * this app), so this list does not try to duplicate that judgment just to
 * filter its own options. Picking the same week `ManualCaptureForm` above
 * already targets is harmless, if redundant: both routes merge into the same
 * row either way.
 */
function PastWeekWallForm({
  tag,
  history,
  wallReference,
  onSaved,
}: {
  tag: string
  history: ProgressSnapshot[]
  wallReference: WallReferenceRow[]
  onSaved: (snapshot: ProgressSnapshot) => void
}) {
  const [selectedWeek, setSelectedWeek] = useState('')
  const selected = history.find((snapshot) => snapshot.weekStart === selectedWeek) ?? null

  return (
    <details className="group">
      <summary>Correct a past week’s walls</summary>
      <div className="group__body">
        <label className="progress-form__field">
          <span className="progress-form__label">Week to correct</span>
          <select value={selectedWeek} onChange={(event) => setSelectedWeek(event.target.value)}>
            <option value="">Choose a week…</option>
            {history.map((snapshot) => (
              <option key={snapshot.weekStart} value={snapshot.weekStart}>
                {formatDate(snapshot.weekStart)}
              </option>
            ))}
          </select>
        </label>

        {selected ? (
          <PastWeekWallEditor
            key={selected.weekStart}
            tag={tag}
            snapshot={selected}
            wallReference={wallReference}
            onSaved={onSaved}
          />
        ) : null}
      </div>
    </details>
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
     than a second store. Shared by every write on this panel (this week's form and
     the past-week correction form both call it) since all of them change the same
     history this panel reads. */
  const [reloadToken, setReloadToken] = useState(0)
  const handleSaved = () => setReloadToken((count) => count + 1)
  const state = useProgressHistory(tag, reloadToken)

  /* The reference tables, cached at module scope — see `useProgressReference` in
     `progress.ts`. A load still under way, or one that failed, is not a reason to
     hide the history: `percentToMax` and `wallProgress` already treat an empty
     reference as an ordinary answer, so every week below falls back to the bare
     captured level exactly as it did before this route existed. */
  const reference = useProgressReference()

  return (
    <section className="card">
      <h2 className="section-title">
        Weekly progress{' '}
        <HelpLink section="progress" topic="what's captured automatically, and what you type in" />
      </h2>

      {state.status === 'loading' || state.status === 'idle' ? (
        <Loading what={`${name}'s progress history`} />
      ) : state.status === 'error' ? (
        <ErrorPanel error={state.error} />
      ) : (
        <>
          {/* Outside `<details>` on purpose — see the module doc's note on
              `OverallProgress` for why this stays visible even collapsed. */}
          <OverallProgress history={state.data} />

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
                  onSaved={handleSaved}
                />
              ) : (
                <div className="notice">
                  <p className="notice__title">Read-only</p>
                  <p className="notice__body">{access.message}</p>
                </div>
              )}

              {state.data[0] ? (
                <CurrentWeekDetail
                  snapshot={state.data[0]}
                  maxLevels={reference.maxLevels}
                  walls={reference.walls}
                />
              ) : null}

              {state.data.length > 0 ? (
                <>
                  <HistoryCharts history={state.data} reference={{ maxLevels: reference.maxLevels }} />
                  <details className="group">
                    <summary>Why some charts look empty, and what the percent means</summary>
                    <div className="group__body help-prose">
                      <ProgressCapRules />
                    </div>
                  </details>
                </>
              ) : null}

              {/* `slice(1)`: the newest week already got the full treatment above. */}
              {state.data.slice(1).map((snapshot) => (
                <WeekSummaryRow key={snapshot.weekStart} snapshot={snapshot} />
              ))}

              {access.writable && state.data.length > 0 ? (
                <PastWeekWallForm
                  tag={tag}
                  history={state.data}
                  wallReference={reference.walls}
                  onSaved={handleSaved}
                />
              ) : null}
            </div>
          </details>
        </>
      )}
    </section>
  )
}
