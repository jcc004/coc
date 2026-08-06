import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildColumnMap,
  classifyDatedSheets,
  columnLetterToIndex,
  extractRowCells,
  extractSheetRows,
  indexToColumnLetter,
  NICKNAME_TO_TAG,
  parseDataRow,
  parseSharedStrings,
  parseWorkbookRels,
  parseWorkbookSheetOrder,
  resolveCellNumber,
  resolveCellText,
  scanDataRows,
  type ParsedDataRow,
} from './backfill-history.ts'

/*
 * Fixtures below are the *actual* row 4/5/6 XML pulled from three real
 * spreadsheets spanning the layout's known changes — Sept 2025 (no
 * `Buildings` `Left` column, single sheet, 5-level wall span), Jan 2026's
 * "Current" sheet (`Left` present, 6-level wall span, no `DD`/`R`), Jan
 * 2026's "jcc4coc" sheet (a completely different, narrower wall range on the
 * same date range — the "lower-TH sheet" the task's brief calls out), and
 * Jul 2026 (`DD` and `R` both present, a `Notes`-labeled pair of trailing
 * columns, formula cells in the wall span). Copied verbatim rather than
 * hand-written, since the whole point of a fixture here is to pin the parser
 * against real shapes, not shapes convenient to write.
 */

const SEPT_2025_SHARED_STRINGS = parseSharedStrings(`
<sst><si><t>Clashy</t></si><si><t>nc</t></si><si><t>iv</t></si><si><t>__</t></si>
<si><t>00</t></si><si><t>**</t></si><si><t>@@</t></si><si><t>BK</t></si><si><t>AQ</t></si>
<si><t>MP</t></si><si><t>GW</t></si><si><t>RC</t></si><si><t>oo</t></si><si><t>..</t></si>
<si><t>$$</t></si><si><t>Heroes</t></si><si><t>TH</t></si><si><t>Buildings</t></si>
<si><t>All</t></si><si><t>Playa</t></si><si><t>Walls</t></si><si><t>Max</t></si>
<si><t>Pets</t></si><si><t>L</t></si><si><t>O</t></si><si><t>Y</t></si><si><t>U</t></si>
<si><t>F</t></si><si><t>D</t></si><si><t>PL</t></si><si><t>PH</t></si><si><t>SF</t></si>
<si><t>AJ</t></si><si><t>S</t></si><si><t>x</t></si></sst>
`)

const SEPT_2025_ROW4 = extractRowCells(
  '<c r="A4" s="4" t="s"><v>19</v></c><c r="B4" s="4" t="s"><v>16</v></c><c r="C4" s="7" t="s"><v>15</v></c><c r="D4" s="7"/><c r="E4" s="7"/><c r="F4" s="7"/><c r="G4" s="7"/><c r="H4" s="4" t="s"><v>17</v></c><c r="I4" s="7" t="s"><v>20</v></c><c r="J4" s="7"/><c r="K4" s="7"/><c r="L4" s="7"/><c r="M4" s="7"/><c r="N4" s="7"/><c r="O4" s="7" t="s"><v>22</v></c><c r="P4" s="7"/><c r="Q4" s="7"/><c r="R4" s="7"/><c r="S4" s="7"/><c r="T4" s="7"/><c r="U4" s="7"/><c r="V4" s="7"/><c r="W4" s="7"/><c r="X4" s="7"/><c r="Y4" s="7"/>',
)
const SEPT_2025_ROW5 = extractRowCells(
  '<c r="C5" s="4" t="s"><v>7</v></c><c r="D5" s="4" t="s"><v>8</v></c><c r="E5" s="4" t="s"><v>9</v></c><c r="F5" s="4" t="s"><v>10</v></c><c r="G5" s="4" t="s"><v>11</v></c><c r="I5" s="4" t="s"><v>21</v></c><c r="J5" s="4"><v>18</v></c><c r="K5" s="4"><v>17</v></c><c r="L5" s="4"><v>16</v></c><c r="M5" s="4"><v>15</v></c><c r="N5" s="4"><v>14</v></c><c r="O5" s="4" t="s"><v>23</v></c><c r="P5" s="4" t="s"><v>24</v></c><c r="Q5" s="4" t="s"><v>25</v></c><c r="R5" s="4" t="s"><v>26</v></c><c r="S5" s="4" t="s"><v>27</v></c><c r="T5" s="4" t="s"><v>28</v></c><c r="U5" s="4" t="s"><v>29</v></c><c r="V5" s="4" t="s"><v>30</v></c><c r="W5" s="4" t="s"><v>31</v></c><c r="X5" s="4" t="s"><v>32</v></c><c r="Y5" s="4" t="s"><v>33</v></c>',
)
const SEPT_2025_ROW6 = extractRowCells(
  '<c r="A6" s="1" t="s"><v>1</v></c><c r="B6" s="1"><v>17</v></c><c r="C6" s="1"><v>90</v></c><c r="D6" s="2"><v>100</v></c><c r="E6" s="2"><v>90</v></c><c r="F6" s="2"><v>75</v></c><c r="G6" s="2"><v>50</v></c><c r="I6" s="1"><v>19</v></c><c r="K6" s="1"><v>1</v></c><c r="L6" s="1"><v>180</v></c><c r="M6" s="1"><v>144</v></c><c r="O6" s="1"><v>6</v></c><c r="P6" s="1"><v>11</v></c><c r="Q6" s="2"><v>15</v></c><c r="R6" s="1"><v>10</v></c><c r="S6" s="1"><v>10</v></c><c r="T6" s="2"><v>10</v></c><c r="U6" s="2"><v>10</v></c><c r="V6" s="2"><v>10</v></c><c r="W6" s="2"><v>10</v></c><c r="X6" s="1"><v>5</v></c><c r="Y6" s="1"><v>4</v></c>',
)

describe('buildColumnMap against the Sept 2025 layout (no Buildings/Left, 5-level walls)', () => {
  const map = buildColumnMap(SEPT_2025_ROW4, SEPT_2025_ROW5, SEPT_2025_SHARED_STRINGS)

  it('places Playa, TH and Buildings by category alone, no sub-label needed', () => {
    assert.equal(map.playaCol, 'A')
    assert.equal(map.thCol, 'B')
    assert.equal(map.buildingsLeftCol, 'H')
  })

  it('maps every hero column present, and no Dragon Duke column yet', () => {
    assert.deepEqual(map.heroCols, {
      'Barbarian King': 'C',
      'Archer Queen': 'D',
      'Minion Prince': 'E',
      'Grand Warden': 'F',
      'Royal Champion': 'G',
    })
  })

  it('excludes the non-numeric "Max" sub-column from the wall levels without warning about it (it is expected)', () => {
    assert.deepEqual(map.wallCols, { '18': 'J', '17': 'K', '16': 'L', '15': 'M', '14': 'N' })
    assert.equal(
      map.warnings.some((w) => w.includes('Max')),
      false,
    )
  })

  it('maps all 11 pet columns of this era (no Greedy Raven yet)', () => {
    assert.deepEqual(map.petCols, {
      'L.A.S.S.I': 'O',
      'Electro Owl': 'P',
      'Mighty Yak': 'Q',
      Unicorn: 'R',
      Frosty: 'S',
      Diggy: 'T',
      'Poison Lizard': 'U',
      Phoenix: 'V',
      'Spirit Fox': 'W',
      'Angry Jelly': 'X',
      Sneezy: 'Y',
    })
  })
})

describe('parseDataRow against a real Sept 2025 data row', () => {
  const map = buildColumnMap(SEPT_2025_ROW4, SEPT_2025_ROW5, SEPT_2025_SHARED_STRINGS)
  const row = parseDataRow(SEPT_2025_ROW6, map, SEPT_2025_SHARED_STRINGS)

  it('reads the Playa nickname and Town Hall level', () => {
    assert.ok(row)
    assert.equal(row.playa, 'nc')
    assert.equal(row.thLevel, 17)
  })

  it('reads every present hero level', () => {
    assert.ok(row)
    assert.deepEqual(
      [...row.heroes].sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'Archer Queen', level: 100 },
        { name: 'Barbarian King', level: 90 },
        { name: 'Grand Warden', level: 75 },
        { name: 'Minion Prince', level: 90 },
        { name: 'Royal Champion', level: 50 },
      ],
    )
  })

  it('leaves a blank wall-level cell out of the walls map entirely, sparse not zero', () => {
    assert.ok(row)
    // Column J (level 18) had no <v> in the fixture row — must be absent, not 0.
    assert.equal(row.walls['18'], undefined)
    assert.equal(row.walls['17'], 1)
    assert.equal(row.walls['16'], 180)
  })

  it('has no Buildings-left value at all this week — not captured, not zero', () => {
    assert.ok(row)
    assert.equal(row.buildingsLeft, undefined)
  })

  it('has no trailing notes columns in this era', () => {
    assert.ok(row)
    assert.equal(row.notes, undefined)
  })
})

// ---------------------------------------------------------------------------
// Jan 2026 "Current" sheet — Buildings/Left present, 6-level wall span
// (19..14), still no DD/R. Two trailing, unlabeled Notes columns.
// ---------------------------------------------------------------------------

const JAN_2026_SHARED_STRINGS = parseSharedStrings(`
<sst><si><t>Clashy</t></si><si><t>nc</t></si><si><t>iv</t></si><si><t>__</t></si>
<si><t>00</t></si><si><t>**</t></si><si><t>@@</t></si><si><t>BK</t></si><si><t>AQ</t></si>
<si><t>MP</t></si><si><t>GW</t></si><si><t>RC</t></si><si><t>oo</t></si><si><t>..</t></si>
<si><t>$$</t></si><si><t>Heroes</t></si><si><t>TH</t></si><si><t>Buildings</t></si>
<si><t>Playa</t></si><si><t>Walls</t></si><si><t>Max</t></si><si><t>Pets</t></si>
<si><t>L</t></si><si><t>O</t></si><si><t>Y</t></si><si><t>U</t></si><si><t>F</t></si>
<si><t>D</t></si><si><t>PL</t></si><si><t>PH</t></si><si><t>SF</t></si><si><t>AJ</t></si>
<si><t>S</t></si><si><t>Left</t></si><si><t>Most Important Pets</t></si>
<si><t>Max Level for TH</t></si><si><t>L.A.S.S.I.</t></si><si><t>Electro Owl</t></si>
<si><t>Mighty Yak</t></si><si><t>Unicorn</t></si><si><t>Frosty</t></si><si><t>Diggy</t></si>
<si><t>Poison Lizard</t></si><si><t>Phoenix</t></si><si><t>Spirit Fox</t></si>
<si><t>Angry Jelly</t></si><si><t>Sneezy</t></si><si><t>Max by TH / Pet House Level</t></si>
<si><t>Max Hero Level by TH</t></si><si><t>Lots</t></si><si><t>TH 17 week of 2025-11-01</t></si>
<si><t>TH 16 week of 2025-11-01</t></si><si><t>jcc4coc</t></si><si><t>TH 18 hammered 11/17</t></si>
<si><t>TH 18 finished 12/2</t></si><si><t>TH 18 finished 11/24?</t></si><si><t>TH 18 hammered 11/23</t></si>
<si><t>PL goes to 15 starting 2025-11</t></si><si><t>Gold pass 2025-12</t></si><si><t>Gold pass 2025-11</t></si>
<si><t>Wall Segments Available</t></si><si><t>QTY</t></si>
<si><t>12/19 - Half done w Walls!!</t></si></sst>
`)

const JAN_2026_ROW4 = extractRowCells(
  '<c r="A4" s="12" t="s"><v>18</v></c><c r="B4" s="12" t="s"><v>16</v></c><c r="C4" s="32" t="s"><v>15</v></c><c r="D4" s="33"/><c r="E4" s="33"/><c r="F4" s="33"/><c r="G4" s="34"/><c r="H4" s="12" t="s"><v>17</v></c><c r="I4" s="32" t="s"><v>19</v></c><c r="J4" s="33"/><c r="K4" s="33"/><c r="L4" s="33"/><c r="M4" s="33"/><c r="N4" s="33"/><c r="O4" s="34"/><c r="P4" s="32" t="s"><v>21</v></c><c r="Q4" s="33"/><c r="R4" s="33"/><c r="S4" s="33"/><c r="T4" s="33"/><c r="U4" s="33"/><c r="V4" s="33"/><c r="W4" s="33"/><c r="X4" s="33"/><c r="Y4" s="33"/><c r="Z4" s="34"/>',
)
const JAN_2026_ROW5 = extractRowCells(
  '<c r="A5" s="16"/><c r="B5" s="19"/><c r="C5" s="9" t="s"><v>7</v></c><c r="D5" s="10" t="s"><v>8</v></c><c r="E5" s="10" t="s"><v>9</v></c><c r="F5" s="10" t="s"><v>10</v></c><c r="G5" s="11" t="s"><v>11</v></c><c r="H5" s="21" t="s"><v>33</v></c><c r="I5" s="9" t="s"><v>20</v></c><c r="J5" s="10"><v>19</v></c><c r="K5" s="10"><v>18</v></c><c r="L5" s="10"><v>17</v></c><c r="M5" s="10"><v>16</v></c><c r="N5" s="10"><v>15</v></c><c r="O5" s="11"><v>14</v></c><c r="P5" s="9" t="s"><v>22</v></c><c r="Q5" s="10" t="s"><v>23</v></c><c r="R5" s="10" t="s"><v>24</v></c><c r="S5" s="22" t="s"><v>25</v></c><c r="T5" s="22" t="s"><v>26</v></c><c r="U5" s="10" t="s"><v>27</v></c><c r="V5" s="10" t="s"><v>28</v></c><c r="W5" s="22" t="s"><v>29</v></c><c r="X5" s="22" t="s"><v>30</v></c><c r="Y5" s="10" t="s"><v>31</v></c><c r="Z5" s="23" t="s"><v>32</v></c>',
)
const JAN_2026_ROW6 = extractRowCells(
  '<c r="A6" s="17" t="s"><v>1</v></c><c r="B6" s="13"><v>18</v></c><c r="C6" s="3"><v>100</v></c><c r="D6" s="1"><v>100</v></c><c r="E6" s="1"><v>92</v></c><c r="F6" s="8"><v>80</v></c><c r="G6" s="14"><v>55</v></c><c r="H6" s="17"><v>47</v></c><c r="I6" s="3"><v>18</v></c><c r="J6" s="1"/><c r="K6" s="1"><v>6</v></c><c r="L6" s="1"><v>91</v></c><c r="M6" s="1"><v>228</v></c><c r="O6" s="4"/><c r="P6" s="3"><v>7</v></c><c r="Q6" s="1"><v>14</v></c><c r="R6" s="8"><v>15</v></c><c r="S6" s="8"><v>15</v></c><c r="T6" s="8"><v>15</v></c><c r="U6" s="8"><v>10</v></c><c r="V6" s="8"><v>15</v></c><c r="W6" s="8"><v>10</v></c><c r="X6" s="8"><v>10</v></c><c r="Y6" s="1"><v>5</v></c><c r="Z6" s="14"><v>10</v></c><c r="AA6" t="s"><v>56</v></c><c r="AB6" t="s"><v>58</v></c>',
)

describe('buildColumnMap against the Jan 2026 "Current" layout (Left present, 6-level walls)', () => {
  const map = buildColumnMap(JAN_2026_ROW4, JAN_2026_ROW5, JAN_2026_SHARED_STRINGS)

  it('finds the Buildings/Left column', () => {
    assert.equal(map.buildingsLeftCol, 'H')
  })

  it('maps a 6-level wall span, still excluding "Max"', () => {
    assert.deepEqual(map.wallCols, {
      '19': 'J',
      '18': 'K',
      '17': 'L',
      '16': 'M',
      '15': 'N',
      '14': 'O',
    })
  })

  it('has no Dragon Duke or Greedy Raven column yet', () => {
    assert.equal(map.heroCols['Dragon Duke'], undefined)
    assert.equal(map.petCols['Greedy Raven'], undefined)
  })
})

describe('parseDataRow against a real Jan 2026 data row', () => {
  const map = buildColumnMap(JAN_2026_ROW4, JAN_2026_ROW5, JAN_2026_SHARED_STRINGS)
  const row = parseDataRow(JAN_2026_ROW6, map, JAN_2026_SHARED_STRINGS)

  it('reads the Buildings-left count', () => {
    assert.ok(row)
    assert.equal(row.buildingsLeft, '47')
  })

  it('joins the two unlabeled trailing notes columns in column order', () => {
    assert.ok(row)
    assert.equal(row.notes, 'TH 18 hammered 11/23; Gold pass 2025-12')
  })
})

describe('parseDataRow stops at the first row with a blank Playa cell', () => {
  it('returns null for a row with no data at all', () => {
    const map = buildColumnMap(JAN_2026_ROW4, JAN_2026_ROW5, JAN_2026_SHARED_STRINGS)
    const blankRow = extractRowCells('<c r="C15" s="8"/><c r="D15" s="25" t="s"><v>35</v></c>')
    assert.equal(parseDataRow(blankRow, map, JAN_2026_SHARED_STRINGS), null)
  })

  it('returns null for a row that is entirely absent from the sheet', () => {
    const map = buildColumnMap(JAN_2026_ROW4, JAN_2026_ROW5, JAN_2026_SHARED_STRINGS)
    assert.equal(parseDataRow([], map, JAN_2026_SHARED_STRINGS), null)
  })
})

// ---------------------------------------------------------------------------
// Jan 2026 "jcc4coc" sheet — same file, a completely independent wall range
// (14, 13 rather than 19..14) and a single data row. This is the
// "lower-TH sheet" the task's brief calls out: column position and even span
// width are not shared across a file's two sheets.
// ---------------------------------------------------------------------------

const JCC4COC_ROW4 = extractRowCells(
  '<c r="A4" s="12" t="s"><v>18</v></c><c r="B4" s="12" t="s"><v>16</v></c><c r="C4" s="32" t="s"><v>15</v></c><c r="D4" s="33"/><c r="E4" s="33"/><c r="F4" s="33"/><c r="G4" s="34"/><c r="H4" s="12" t="s"><v>17</v></c><c r="I4" s="32" t="s"><v>19</v></c><c r="J4" s="33"/><c r="K4" s="34"/><c r="L4" s="32" t="s"><v>21</v></c><c r="M4" s="33"/><c r="N4" s="33"/><c r="O4" s="33"/><c r="P4" s="33"/><c r="Q4" s="33"/><c r="R4" s="33"/><c r="S4" s="33"/><c r="T4" s="33"/><c r="U4" s="33"/><c r="V4" s="34"/>',
)
const JCC4COC_ROW5 = extractRowCells(
  '<c r="A5" s="16"/><c r="B5" s="19"/><c r="C5" s="9" t="s"><v>7</v></c><c r="D5" s="10" t="s"><v>8</v></c><c r="E5" s="10" t="s"><v>9</v></c><c r="F5" s="10" t="s"><v>10</v></c><c r="G5" s="11" t="s"><v>11</v></c><c r="H5" s="21" t="s"><v>33</v></c><c r="I5" s="9" t="s"><v>20</v></c><c r="J5" s="10"><v>14</v></c><c r="K5" s="11"><v>13</v></c><c r="L5" s="9" t="s"><v>22</v></c><c r="M5" s="10" t="s"><v>23</v></c><c r="N5" s="10" t="s"><v>24</v></c><c r="O5" s="22" t="s"><v>25</v></c><c r="P5" s="22" t="s"><v>26</v></c><c r="Q5" s="10" t="s"><v>27</v></c><c r="R5" s="10" t="s"><v>28</v></c><c r="S5" s="22" t="s"><v>29</v></c><c r="T5" s="22" t="s"><v>30</v></c><c r="U5" s="10" t="s"><v>31</v></c><c r="V5" s="23" t="s"><v>32</v></c>',
)
const JCC4COC_ROW6 = extractRowCells(
  '<c r="A6" s="19" t="s"><v>52</v></c><c r="B6" s="19"><v>13</v></c><c r="C6" s="15"><v>75</v></c><c r="D6" s="15"><v>75</v></c><c r="E6" s="6"><v>48</v></c><c r="F6" s="15"><v>50</v></c><c r="G6" s="7"><v>22</v></c><c r="H6" s="19"><v>48</v></c><c r="I6" s="5"><v>14</v></c><c r="J6" s="15"><f>300-K6</f><v>222</v></c><c r="K6" s="7"><v>78</v></c><c r="L6" s="6"/><c r="M6" s="6"/><c r="N6" s="6"/><c r="O6" s="6"/><c r="P6" s="6"/><c r="Q6" s="6"/><c r="R6" s="6"/><c r="S6" s="6"/><c r="T6" s="6"/><c r="U6" s="6"/><c r="V6" s="7"/>',
)

describe("buildColumnMap against the jcc4coc sheet's own, independent wall range", () => {
  const map = buildColumnMap(JCC4COC_ROW4, JCC4COC_ROW5, JAN_2026_SHARED_STRINGS)

  it('maps a completely different wall span than the Current sheet in the same file', () => {
    assert.deepEqual(map.wallCols, { '14': 'J', '13': 'K' })
  })

  it('reads the identity from the Playa column, resolving to "jcc4coc" not a nickname', () => {
    const row = parseDataRow(JCC4COC_ROW6, map, JAN_2026_SHARED_STRINGS)
    assert.ok(row)
    assert.equal(row.playa, 'jcc4coc')
  })
})

describe('parseDataRow reads a formula cell by its cached <v>, ignoring the <f>', () => {
  it('takes the cached value, not the formula text', () => {
    const map = buildColumnMap(JCC4COC_ROW4, JCC4COC_ROW5, JAN_2026_SHARED_STRINGS)
    const row = parseDataRow(JCC4COC_ROW6, map, JAN_2026_SHARED_STRINGS)
    assert.ok(row)
    // J6 holds <f>300-K6</f><v>222</v> — the wall-level-14 count must be 222.
    assert.equal(row.walls['14'], 222)
  })
})

// ---------------------------------------------------------------------------
// Jul 2026 — Dragon Duke and Greedy Raven columns both present, and this
// era's row 5 does label the two trailing columns "Notes" explicitly.
// ---------------------------------------------------------------------------

// The real file's first 68 shared strings (indices 0-67), verbatim — this is
// what `H5`'s `v=62`, `Z5`'s `v=61`, `AB5`'s `v=67` etc. below actually index into.
const JUL_2026_SHARED_STRINGS = parseSharedStrings(`
<sst><si><t>Clashy</t></si><si><t>nc</t></si><si><t>iv</t></si><si><t>__</t></si>
<si><t>00</t></si><si><t>**</t></si><si><t>@@</t></si><si><t>BK</t></si><si><t>AQ</t></si>
<si><t>MP</t></si><si><t>GW</t></si><si><t>RC</t></si><si><t>oo</t></si><si><t>..</t></si>
<si><t>$$</t></si><si><t>Heroes</t></si><si><t>TH</t></si><si><t>Buildings</t></si>
<si><t>Playa</t></si><si><t>Walls</t></si><si><t>Max</t></si><si><t>Pets</t></si>
<si><t>L</t></si><si><t>O</t></si><si><t>Y</t></si><si><t>U</t></si><si><t>F</t></si>
<si><t>D</t></si><si><t>PL</t></si><si><t>PH</t></si><si><t>SF</t></si><si><t>AJ</t></si>
<si><t>S</t></si><si><t>Left</t></si><si><t>Most Important Pets</t></si>
<si><t>Max Level for TH</t></si><si><t>L.A.S.S.I.</t></si><si><t>Electro Owl</t></si>
<si><t>Mighty Yak</t></si><si><t>Unicorn</t></si><si><t>Frosty</t></si><si><t>Diggy</t></si>
<si><t>Poison Lizard</t></si><si><t>Phoenix</t></si><si><t>Spirit Fox</t></si>
<si><t>Angry Jelly</t></si><si><t>Sneezy</t></si><si><t>Max by TH / Pet House Level</t></si>
<si><t>Max Hero Level by TH</t></si><si><t>TH 17 week of 2025-11-01</t></si>
<si><t>TH 16 week of 2025-11-01</t></si><si><t>jcc4coc</t></si>
<si><t>TH 18 hammered 11/17</t></si><si><t>TH 18 finished 12/2</t></si>
<si><t>TH 18 finished 11/24?</t></si><si><t>TH 18 hammered 11/23</t></si>
<si><t>PL goes to 15 starting 2025-11</t></si><si><t>Gold pass 2025-12</t></si>
<si><t>Gold pass 2025-11</t></si><si><t>QTY</t></si><si><t>Gold pass 25-12, 26-01</t></si>
<si><t>R</t></si><si><t>DD</t></si><si><t>Greedy Raven</t></si>
<si><t>GR added 2023-02-23</t></si><si><t>Wall Segments</t></si><si><t>DONE!</t></si>
<si><t>Notes</t></si></sst>
`)

const JUL_2026_ROW4 = extractRowCells(
  '<c r="A4" s="12" t="s"><v>18</v></c><c r="B4" s="22" t="s"><v>16</v></c><c r="C4" s="60" t="s"><v>15</v></c><c r="D4" s="61"/><c r="E4" s="61"/><c r="F4" s="61"/><c r="G4" s="61"/><c r="H4" s="62"/><c r="I4" s="24" t="s"><v>17</v></c><c r="J4" s="60" t="s"><v>19</v></c><c r="K4" s="61"/><c r="L4" s="61"/><c r="M4" s="61"/><c r="N4" s="61"/><c r="O4" s="66" t="s"><v>21</v></c><c r="P4" s="67"/><c r="Q4" s="67"/><c r="R4" s="67"/><c r="S4" s="67"/><c r="T4" s="67"/><c r="U4" s="67"/><c r="V4" s="67"/><c r="W4" s="67"/><c r="X4" s="67"/><c r="Y4" s="67"/><c r="Z4" s="68"/><c r="AB4" s="21"/><c r="AC4" s="21"/><c r="AD4" s="21"/>',
)
const JUL_2026_ROW5 = extractRowCells(
  '<c r="A5" s="14"/><c r="B5" s="5"/><c r="C5" s="36" t="s"><v>7</v></c><c r="D5" s="21" t="s"><v>8</v></c><c r="E5" s="21" t="s"><v>9</v></c><c r="F5" s="21" t="s"><v>10</v></c><c r="G5" s="21" t="s"><v>11</v></c><c r="H5" s="37" t="s"><v>62</v></c><c r="I5" s="11" t="s"><v>33</v></c><c r="J5" s="9" t="s"><v>20</v></c><c r="K5" s="10"><v>19</v></c><c r="L5" s="10"><v>18</v></c><c r="M5" s="10"><v>17</v></c><c r="N5" s="10"><v>16</v></c><c r="O5" s="28" t="s"><v>22</v></c><c r="P5" s="48" t="s"><v>23</v></c><c r="Q5" s="29" t="s"><v>24</v></c><c r="R5" s="48" t="s"><v>25</v></c><c r="S5" s="30" t="s"><v>26</v></c><c r="T5" s="48" t="s"><v>27</v></c><c r="U5" s="29" t="s"><v>28</v></c><c r="V5" s="30" t="s"><v>29</v></c><c r="W5" s="30" t="s"><v>30</v></c><c r="X5" s="29" t="s"><v>31</v></c><c r="Y5" s="31" t="s"><v>32</v></c><c r="Z5" s="56" t="s"><v>61</v></c><c r="AB5" s="21" t="s"><v>67</v></c><c r="AC5" s="21" t="s"><v>67</v></c><c r="AD5"/>',
)
const JUL_2026_ROW6 = extractRowCells(
  '<c r="A6" s="15" t="s"><v>1</v></c><c r="B6" s="33"><v>18</v></c><c r="C6" s="3"><v>106</v></c><c r="D6" s="8"><v>110</v></c><c r="E6" s="8"><v>95</v></c><c r="F6" s="8"><v>85</v></c><c r="G6" s="8"><v>55</v></c><c r="H6" s="46"><v>25</v></c><c r="I6" s="4"><v>5</v></c><c r="J6" s="3"><v>19</v></c><c r="K6" s="8"><f>325-L6-M6-N6</f><v>0</v></c><c r="L6" s="1"><f t="shared" ref="L6:L14" si="0">325-M6-N6</f><v>8</v></c><c r="M6" s="1"><v>152</v></c><c r="N6" s="1"><v>165</v></c><c r="O6" s="33"><v>15</v></c><c r="P6" s="8"><v>15</v></c><c r="Q6" s="8"><v>15</v></c><c r="R6" s="8"><v>15</v></c><c r="S6" s="8"><v>15</v></c><c r="T6" s="8"><v>10</v></c><c r="U6" s="8"><v>15</v></c><c r="V6" s="8"><v>10</v></c><c r="W6" s="8"><v>10</v></c><c r="X6" s="8"><v>10</v></c><c r="Y6" s="8"><v>10</v></c><c r="Z6" s="46"><v>10</v></c><c r="AB6" t="s"><v>52</v></c><c r="AC6" t="s"><v>60</v></c><c r="AD6"/>',
)

describe('buildColumnMap against the Jul 2026 layout (DD, R, and Notes-labeled trailing columns)', () => {
  const map = buildColumnMap(JUL_2026_ROW4, JUL_2026_ROW5, JUL_2026_SHARED_STRINGS)

  it('has picked up the Dragon Duke and Greedy Raven columns', () => {
    assert.equal(map.heroCols['Dragon Duke'], 'H')
    assert.equal(map.petCols['Greedy Raven'], 'Z')
  })

  it('maps a 4-level wall span (this era has shrunk to K..N)', () => {
    assert.deepEqual(map.wallCols, { '19': 'K', '18': 'L', '17': 'M', '16': 'N' })
  })
})

describe('parseDataRow against a real Jul 2026 data row', () => {
  const map = buildColumnMap(JUL_2026_ROW4, JUL_2026_ROW5, JUL_2026_SHARED_STRINGS)
  const row = parseDataRow(JUL_2026_ROW6, map, JUL_2026_SHARED_STRINGS)

  it('reads the Dragon Duke level', () => {
    assert.ok(row)
    assert.equal(row.heroes.find((h) => h.name === 'Dragon Duke')?.level, 25)
  })

  it('reads a shared-formula wall cell (si="0", no repeated <f> text) by its cached value', () => {
    assert.ok(row)
    assert.equal(row.walls['18'], 8)
  })

  it('still finds the two trailing notes columns even though row 5 now labels them "Notes"', () => {
    assert.ok(row)
    assert.equal(row.notes, 'TH 18 hammered 11/17; Gold pass 25-12, 26-01')
  })
})

// ---------------------------------------------------------------------------
// Small XML-plumbing pieces, tested directly rather than only through the
// bigger fixtures above.
// ---------------------------------------------------------------------------

describe('columnLetterToIndex', () => {
  it('orders single and double letters correctly', () => {
    assert.equal(columnLetterToIndex('A'), 1)
    assert.equal(columnLetterToIndex('Z'), 26)
    assert.equal(columnLetterToIndex('AA'), 27)
    assert.equal(columnLetterToIndex('AB'), 28)
  })
})

describe('resolveCellText / resolveCellNumber', () => {
  it('resolves a shared-string cell through the string table', () => {
    const cells = extractRowCells('<c r="A1" t="s"><v>2</v></c>')
    assert.equal(resolveCellText(cells[0], ['zero', 'one', 'two']), 'two')
  })

  it('reads a plain numeric cell as text and as a number', () => {
    const cells = extractRowCells('<c r="B1"><v>47</v></c>')
    assert.equal(resolveCellText(cells[0], []), '47')
    assert.equal(resolveCellNumber(cells[0]), 47)
  })

  it('treats a truly blank cell (no <v> at all) as absent, not zero', () => {
    const cells = extractRowCells('<c r="C1" s="4"/>')
    assert.equal(resolveCellText(cells[0], []), undefined)
    assert.equal(resolveCellNumber(cells[0]), undefined)
  })

  it('decodes an inline string cell without a shared-string lookup', () => {
    const cells = extractRowCells('<c r="D1" t="inlineStr"><is><t>hand-typed</t></is></c>')
    assert.equal(resolveCellText(cells[0], []), 'hand-typed')
  })
})

describe('extractSheetRows', () => {
  it('keys rows by number and leaves omitted rows absent from the map', () => {
    const rows = extractSheetRows(
      '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="4"><c r="A4"/></row>',
    )
    assert.ok(rows.has(1))
    assert.ok(rows.has(4))
    assert.equal(rows.has(2), false)
    assert.equal(rows.has(3), false)
  })
})

describe('parseWorkbookSheetOrder and parseWorkbookRels', () => {
  it('pairs each sheet name with its worksheet target through the shared r:id', () => {
    const workbookXml =
      '<workbook><sheets><sheet name="Current" sheetId="2" r:id="rId1"/><sheet name="jcc4coc" sheetId="4" r:id="rId2"/></sheets></workbook>'
    const relsXml =
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'

    const order = parseWorkbookSheetOrder(workbookXml)
    const targets = parseWorkbookRels(relsXml)

    assert.deepEqual(order, [
      { name: 'Current', rId: 'rId1' },
      { name: 'jcc4coc', rId: 'rId2' },
    ])
    assert.equal(targets.get('rId1'), 'worksheets/sheet1.xml')
    assert.equal(targets.get('rId2'), 'worksheets/sheet2.xml')
    // The non-worksheet relationship (sharedStrings) must not leak in.
    assert.equal(targets.has('rId5'), false)
  })
})

// ---------------------------------------------------------------------------
// Regression: Clashy_2025-09-10.xlsx (and three siblings from the same week,
// 09-12/09-18/09-25) has a row 4 with NO merge and NO continuation cells at
// all — "Heroes", "Buildings", "Walls", "Pets" sit squeezed into four
// consecutive columns (C, D, E, F) regardless of where their real data
// actually lives. An earlier version of this parser trusted row 4's column
// position here and mis-read the Archer Queen, Minion Prince and Grand
// Warden hero columns as Buildings/Walls/Pets. Content-based classification
// of row 5 alone must get this right.
// ---------------------------------------------------------------------------

const SEPT_10_SHARED_STRINGS = parseSharedStrings(`
<sst><si><t>Clashy</t></si><si><t>Playa</t></si><si><t>TH</t></si><si><t>Heroes</t></si>
<si><t>Buildings</t></si><si><t>Walls</t></si><si><t>Pets</t></si><si><t>BK</t></si>
<si><t>AQ</t></si><si><t>MP</t></si><si><t>GW</t></si><si><t>RC</t></si><si><t>Max</t></si>
<si><t>L</t></si><si><t>O</t></si><si><t>Y</t></si><si><t>U</t></si><si><t>F</t></si>
<si><t>D</t></si><si><t>PL</t></si><si><t>PH</t></si><si><t>SF</t></si><si><t>AJ</t></si>
<si><t>S</t></si><si><t>nc</t></si><si><t>iv</t></si><si><t>__</t></si><si><t>All</t></si>
<si><t>**</t></si><si><t>@@</t></si><si><t>oo</t></si><si><t>..</t></si><si><t>$$</t></si>
</sst>
`)

const SEPT_10_ROW4 = extractRowCells(
  '<c r="A4" s="2" t="s"><v>1</v></c><c r="B4" s="2" t="s"><v>2</v></c><c r="C4" s="2" t="s"><v>3</v></c><c r="D4" s="2" t="s"><v>4</v></c><c r="E4" s="2" t="s"><v>5</v></c><c r="F4" s="2" t="s"><v>6</v></c>',
)
const SEPT_10_ROW5 = extractRowCells(
  '<c r="A5" s="3"/><c r="B5" s="3"/><c r="C5" s="2" t="s"><v>7</v></c><c r="D5" s="2" t="s"><v>8</v></c><c r="E5" s="2" t="s"><v>9</v></c><c r="F5" s="2" t="s"><v>10</v></c><c r="G5" s="2" t="s"><v>11</v></c><c r="H5" s="3"/><c r="I5" s="2" t="s"><v>12</v></c><c r="J5" s="2"><v>18</v></c><c r="K5" s="2"><v>17</v></c><c r="L5" s="2"><v>16</v></c><c r="M5" s="2"><v>15</v></c><c r="N5" s="2"><v>14</v></c><c r="O5" s="2" t="s"><v>13</v></c><c r="P5" s="2" t="s"><v>14</v></c><c r="Q5" s="2" t="s"><v>15</v></c><c r="R5" s="2" t="s"><v>16</v></c><c r="S5" s="2" t="s"><v>17</v></c><c r="T5" s="2" t="s"><v>18</v></c><c r="U5" s="2" t="s"><v>19</v></c><c r="V5" s="2" t="s"><v>20</v></c><c r="W5" s="2" t="s"><v>21</v></c><c r="X5" s="2" t="s"><v>22</v></c><c r="Y5" s="2" t="s"><v>23</v></c>',
)
const SEPT_10_ROW6 = extractRowCells(
  '<c r="A6" s="3" t="s"><v>24</v></c><c r="B6" s="3"><v>17</v></c><c r="C6" s="3"><v>92</v></c><c r="D6" s="3"><v>100</v></c><c r="E6" s="3"><v>90</v></c><c r="F6" s="3"><v>75</v></c><c r="G6" s="3"><v>50</v></c><c r="H6" s="3"/><c r="I6" s="3"><v>19</v></c><c r="J6" s="3"/><c r="K6" s="3"><v>1</v></c><c r="L6" s="3"><v>189</v></c><c r="M6" s="3"><v>135</v></c><c r="N6" s="3"/><c r="O6" s="3"><v>6</v></c><c r="P6" s="3"><v>11</v></c><c r="Q6" s="3"><v>15</v></c><c r="R6" s="3"><v>10</v></c><c r="S6" s="3"><v>11</v></c><c r="T6" s="3"><v>10</v></c><c r="U6" s="3"><v>10</v></c><c r="V6" s="3"><v>10</v></c><c r="W6" s="3"><v>10</v></c><c r="X6" s="3"><v>5</v></c><c r="Y6" s="3"><v>5</v></c>',
)
// A different base's row, whose Playa cell Excel stored as the bare number 0
// rather than the shared-string text "00" — see `NICKNAME_TO_TAG`'s comment
// on the '0' alias.
const SEPT_10_ROW9 = extractRowCells(
  '<c r="A9" s="3"><v>0</v></c><c r="B9" s="3"><v>17</v></c><c r="C9" s="3"><v>96</v></c><c r="D9" s="3"><v>100</v></c><c r="E9" s="3"><v>90</v></c><c r="F9" s="3"><v>75</v></c><c r="G9" s="3"><v>50</v></c><c r="H9" s="3" t="s"><v>27</v></c><c r="I9" s="3"><v>19</v></c>',
)

describe("buildColumnMap is not fooled by Clashy_2025-09-10.xlsx's flat, unmerged row 4", () => {
  const map = buildColumnMap(SEPT_10_ROW4, SEPT_10_ROW5, SEPT_10_SHARED_STRINGS)

  it('still finds all 5 hero columns by row 5 content, even though row 4 labels columns D/E/F "Buildings"/"Walls"/"Pets"', () => {
    assert.deepEqual(map.heroCols, {
      'Barbarian King': 'C',
      'Archer Queen': 'D',
      'Minion Prince': 'E',
      'Grand Warden': 'F',
      'Royal Champion': 'G',
    })
  })

  it('still finds Buildings/Left by the Heroes-to-Walls gap, even with no label at all in row 4 or row 5', () => {
    assert.equal(map.buildingsLeftCol, 'H')
  })

  it('still finds the wall levels and pet columns in their row-5 positions', () => {
    assert.deepEqual(map.wallCols, { '18': 'J', '17': 'K', '16': 'L', '15': 'M', '14': 'N' })
    assert.deepEqual(map.petCols, {
      'L.A.S.S.I': 'O',
      'Electro Owl': 'P',
      'Mighty Yak': 'Q',
      Unicorn: 'R',
      Frosty: 'S',
      Diggy: 'T',
      'Poison Lizard': 'U',
      Phoenix: 'V',
      'Spirit Fox': 'W',
      'Angry Jelly': 'X',
      Sneezy: 'Y',
    })
  })
})

describe('parseDataRow reads real hero levels from Clashy_2025-09-10.xlsx despite the flat row 4', () => {
  const map = buildColumnMap(SEPT_10_ROW4, SEPT_10_ROW5, SEPT_10_SHARED_STRINGS)
  const row = parseDataRow(SEPT_10_ROW6, map, SEPT_10_SHARED_STRINGS)

  it('reads Archer Queen (column D) as a hero level, not a Buildings/Left value', () => {
    assert.ok(row)
    assert.equal(row.heroes.find((h) => h.name === 'Archer Queen')?.level, 100)
  })
})

describe("NICKNAME_TO_TAG's '0' alias resolves to the same tag as '00'", () => {
  it('maps the bare-zero cell to the same real tag', () => {
    assert.equal(NICKNAME_TO_TAG['0'], NICKNAME_TO_TAG['00'])
  })

  it('parseDataRow reads the bare-zero Playa cell as text "0", ready for that alias lookup', () => {
    const map = buildColumnMap(SEPT_10_ROW4, SEPT_10_ROW5, SEPT_10_SHARED_STRINGS)
    const row = parseDataRow(SEPT_10_ROW9, map, SEPT_10_SHARED_STRINGS)
    assert.ok(row)
    assert.equal(row.playa, '0')
  })
})

// ---------------------------------------------------------------------------
// Regression: Clashy_2025-09-12.xlsx has a genuinely blank row (row 9, every
// cell either absent or valueless) sandwiched between two real data rows —
// six more real bases follow it. Stopping at the first blank Playa cell
// unconditionally would silently drop those six rows. `scanDataRows` must
// tolerate this one gap and keep going, using the known-nickname list on the
// very next row as the signal that this is not the table's real end.
// ---------------------------------------------------------------------------

const SEPT_12_ROW9 = extractRowCells(
  '<c r="A9" s="5"/><c r="B9" s="5"/><c r="C9" s="5"/><c r="D9" s="5"/><c r="E9" s="3" t="s"><v>33</v></c><c r="F9" s="5"/><c r="G9" s="5"/><c r="H9" s="5"/><c r="I9" s="5"/><c r="J9" s="5"/><c r="K9" s="5"/><c r="L9" s="5"/><c r="M9" s="5"/><c r="N9" s="5"/><c r="O9" s="5"/><c r="P9" s="5"/><c r="Q9" s="5"/><c r="R9" s="5"/><c r="S9" s="5"/><c r="T9" s="5"/><c r="U9" s="5"/><c r="V9" s="5"/><c r="W9" s="5"/><c r="X9" s="5"/><c r="Y9" s="5"/>',
)
const SEPT_12_ROW10 = extractRowCells(
  '<c r="A10" s="3"><v>0</v></c><c r="B10" s="3"><v>17</v></c><c r="C10" s="3"><v>96</v></c><c r="D10" s="3"><v>100</v></c><c r="E10" s="3"><v>90</v></c><c r="F10" s="3"><v>75</v></c><c r="G10" s="3"><v>50</v></c><c r="H10" s="3"><v>0</v></c><c r="I10" s="3"><v>19</v></c>',
)
const SEPT_12_ROW11 = extractRowCells(
  '<c r="A11" s="3" t="s"><v>27</v></c><c r="B11" s="3"><v>16</v></c><c r="C11" s="3"><v>79</v></c><c r="D11" s="3"><v>89</v></c><c r="E11" s="3"><v>80</v></c><c r="F11" s="3"><v>70</v></c><c r="G11" s="3"><v>45</v></c><c r="H11" s="3"><v>0</v></c><c r="I11" s="3"><v>18</v></c>',
)
// Same shared-string table shape as 09-10, plus index 27 for the '__' nickname
// on row 11 and index 33 for the stray note text left in row 9's column E.
const SEPT_12_SHARED_STRINGS = parseSharedStrings(`
<sst><si><t>Clashy</t></si><si><t>Playa</t></si><si><t>TH</t></si><si><t>Heroes</t></si>
<si><t>Buildings</t></si><si><t>Walls</t></si><si><t>Pets</t></si><si><t>BK</t></si>
<si><t>AQ</t></si><si><t>MP</t></si><si><t>GW</t></si><si><t>RC</t></si><si><t>Max</t></si>
<si><t>L</t></si><si><t>O</t></si><si><t>Y</t></si><si><t>U</t></si><si><t>F</t></si>
<si><t>D</t></si><si><t>PL</t></si><si><t>PH</t></si><si><t>SF</t></si><si><t>AJ</t></si>
<si><t>S</t></si><si><t>nc</t></si><si><t>iv</t></si><si><t>_x_</t></si><si><t>__</t></si>
<si><t>**</t></si><si><t>@@</t></si><si><t>oo</t></si><si><t>..</t></si><si><t>$$</t></si>
<si><t>stray note</t></si>
</sst>
`)

describe('scanDataRows tolerates the genuinely blank row 9 in Clashy_2025-09-12.xlsx', () => {
  const map = buildColumnMap(SEPT_10_ROW4, SEPT_10_ROW5, SEPT_12_SHARED_STRINGS)
  const rows = new Map([
    [9, SEPT_12_ROW9],
    [10, SEPT_12_ROW10],
    [11, SEPT_12_ROW11],
  ])
  const knownNicknames = new Set(['0', '__'])

  it('does not stop at the blank row when the next row is a known nickname', () => {
    const result = scanDataRows(rows, 9, map, SEPT_12_SHARED_STRINGS, knownNicknames)
    assert.deepEqual(result.gapRows, [9])
    assert.equal(result.rows.length, 2)
    assert.equal(result.rows[0]?.playa, '0')
    assert.equal(result.rows[1]?.playa, '__')
  })

  it('does stop at a blank row when the next row is not a known nickname (the real boundary case)', () => {
    const rowsWithRealBoundary = new Map([
      [9, SEPT_12_ROW9],
      [10, SEPT_12_ROW9], // reuse the same all-blank shape to stand in for a reference table's own row
    ])
    const result = scanDataRows(rowsWithRealBoundary, 9, map, SEPT_12_SHARED_STRINGS, knownNicknames)
    assert.deepEqual(result.rows, [])
    assert.deepEqual(result.gapRows, [])
  })
})

// ---------------------------------------------------------------------------
// Regression: Clashy_2026-04-24.xlsx (and every later file through the end of
// the range) embeds a "Walls Calculation" / "Hero Calculation" side table
// sharing row 5 with the real headers — columns labeled "Walls", "Walls +"
// and "Heroes" holding a weeks-to-upgrade estimate, immediately followed by
// the two real, "Notes"-labeled columns. A purely positional "everything past
// the last real column is Notes" rule would concatenate those calculated
// numbers into the notes text. `excludedCols` must keep them out.
// ---------------------------------------------------------------------------

const APR_24_SHARED_STRINGS = parseSharedStrings(`
<sst><si><t>Clashy</t></si><si><t>nc</t></si><si><t>iv</t></si><si><t>__</t></si>
<si><t>00</t></si><si><t>**</t></si><si><t>@@</t></si><si><t>BK</t></si><si><t>AQ</t></si>
<si><t>MP</t></si><si><t>GW</t></si><si><t>RC</t></si><si><t>oo</t></si><si><t>..</t></si>
<si><t>$$</t></si><si><t>Heroes</t></si><si><t>TH</t></si><si><t>Buildings</t></si>
<si><t>Playa</t></si><si><t>Walls</t></si><si><t>Max</t></si><si><t>Pets</t></si>
<si><t>L</t></si><si><t>O</t></si><si><t>Y</t></si><si><t>U</t></si><si><t>F</t></si>
<si><t>D</t></si><si><t>PL</t></si><si><t>PH</t></si><si><t>SF</t></si><si><t>AJ</t></si>
<si><t>S</t></si><si><t>Left</t></si><si><t>Most Important Pets</t></si>
<si><t>Max Level for TH</t></si><si><t>L.A.S.S.I.</t></si><si><t>Electro Owl</t></si>
<si><t>Mighty Yak</t></si><si><t>Unicorn</t></si><si><t>Frosty</t></si><si><t>Diggy</t></si>
<si><t>Poison Lizard</t></si><si><t>Phoenix</t></si><si><t>Spirit Fox</t></si>
<si><t>Angry Jelly</t></si><si><t>Sneezy</t></si><si><t>Max by TH / Pet House Level</t></si>
<si><t>Max Hero Level by TH</t></si><si><t>TH 17 week of 2025-11-01</t></si>
<si><t>TH 16 week of 2025-11-01</t></si><si><t>jcc4coc</t></si>
<si><t>TH 18 hammered 11/17</t></si><si><t>TH 18 finished 12/2</t></si>
<si><t>TH 18 finished 11/24?</t></si><si><t>TH 18 hammered 11/23</t></si>
<si><t>PL goes to 15 starting 2025-11</t></si><si><t>Gold pass 2025-12</t></si>
<si><t>Gold pass 2025-11</t></si><si><t>QTY</t></si><si><t>Gold pass 25-12, 26-01</t></si>
<si><t>TH 14 Week of 2026-01-26</t></si><si><t>R</t></si>
<si><t>2026-02-23 Update added a bunch of building levels and a new Pet.  New Hero soon!</t></si>
<si><t>DD</t></si><si><t>Greedy Raven</t></si><si><t>GR added 2023-02-23</t></si>
<si><t>Wall Segments</t></si><si><t>DONE!</t></si>
<si><t>weeks to ug walls at current rate</t></si><si><t>weeks to max heroes at current rate</t></si>
<si><t>Notes</t></si><si><t>Walls +</t></si><si><t>Walls Calculation</t></si>
<si><t>Avg</t></si><si><t>Diff</t></si><si><t>Wks</t></si><si><t>Wks - Walls +</t></si>
<si><t>Hero Calculation</t></si></sst>
`)

const APR_24_ROW5 = extractRowCells(
  '<c r="A5" s="14"/><c r="B5" s="5"/><c r="C5" s="36" t="s"><v>7</v></c><c r="D5" s="21" t="s"><v>8</v></c><c r="E5" s="21" t="s"><v>9</v></c><c r="F5" s="21" t="s"><v>10</v></c><c r="G5" s="11" t="s"><v>11</v></c><c r="H5" s="37" t="s"><v>64</v></c><c r="I5" s="11" t="s"><v>33</v></c><c r="J5" s="9" t="s"><v>20</v></c><c r="K5" s="10"><v>19</v></c><c r="L5" s="10"><v>18</v></c><c r="M5" s="10"><v>17</v></c><c r="N5" s="10"><v>16</v></c><c r="O5" s="10"><v>15</v></c><c r="P5" s="11"><v>14</v></c><c r="Q5" s="28" t="s"><v>22</v></c><c r="R5" s="29" t="s"><v>23</v></c><c r="S5" s="29" t="s"><v>24</v></c><c r="T5" s="30" t="s"><v>25</v></c><c r="U5" s="30" t="s"><v>26</v></c><c r="V5" s="29" t="s"><v>27</v></c><c r="W5" s="29" t="s"><v>28</v></c><c r="X5" s="30" t="s"><v>29</v></c><c r="Y5" s="30" t="s"><v>30</v></c><c r="Z5" s="29" t="s"><v>31</v></c><c r="AA5" s="31" t="s"><v>32</v></c><c r="AB5" s="24" t="s"><v>62</v></c><c r="AC5" s="21" t="s"><v>19</v></c><c r="AD5" s="21" t="s"><v>72</v></c><c r="AE5" s="21" t="s"><v>15</v></c><c r="AF5" s="21" t="s"><v>71</v></c><c r="AG5" s="21" t="s"><v>71</v></c>',
)
const APR_24_ROW4 = extractRowCells(
  '<c r="A4" s="12" t="s"><v>18</v></c><c r="B4" s="22" t="s"><v>16</v></c><c r="C4" s="54" t="s"><v>15</v></c><c r="D4" s="55"/><c r="E4" s="55"/><c r="F4" s="55"/><c r="G4" s="55"/><c r="H4" s="56"/><c r="I4" s="24" t="s"><v>17</v></c><c r="J4" s="54" t="s"><v>19</v></c><c r="K4" s="55"/><c r="L4" s="55"/><c r="M4" s="55"/><c r="N4" s="55"/><c r="O4" s="55"/><c r="P4" s="56"/><c r="Q4" s="54" t="s"><v>21</v></c><c r="R4" s="55"/><c r="S4" s="55"/><c r="T4" s="55"/><c r="U4" s="55"/><c r="V4" s="55"/><c r="W4" s="55"/><c r="X4" s="55"/><c r="Y4" s="55"/><c r="Z4" s="55"/><c r="AA4" s="55"/><c r="AB4" s="56"/><c r="AC4" s="21"/><c r="AD4" s="21"/><c r="AE4" s="21"/>',
)
const APR_24_ROW6 = extractRowCells(
  '<c r="A6" s="15" t="s"><v>1</v></c><c r="B6" s="33"><v>18</v></c><c r="C6" s="33"><v>105</v></c><c r="D6" s="8"><v>105</v></c><c r="E6" s="8"><v>95</v></c><c r="F6" s="8"><v>80</v></c><c r="G6" s="8"><v>55</v></c><c r="H6" s="4"><v>16</v></c><c r="I6" s="4"><v>14</v></c><c r="J6" s="3"><v>18</v></c><c r="K6" s="8"/><c r="L6" s="1"><v>7</v></c><c r="M6" s="1"><v>128</v></c><c r="N6" s="1"><v>190</v></c><c r="P6" s="4"/><c r="Q6" s="3"><v>7</v></c><c r="R6" s="8"><v>15</v></c><c r="S6" s="8"><v>15</v></c><c r="T6" s="8"><v>15</v></c><c r="U6" s="8"><v>15</v></c><c r="V6" s="8"><v>10</v></c><c r="W6" s="8"><v>15</v></c><c r="X6" s="8"><v>10</v></c><c r="Y6" s="8"><v>10</v></c><c r="Z6" s="1"><v>9</v></c><c r="AA6" s="8"><v>10</v></c><c r="AB6" s="4"><v>7</v></c><c r="AF6" t="s"><v>52</v></c><c r="AG6" t="s"><v>60</v></c>',
)
// Row 11 is where the "weeks to upgrade" calculation columns actually hold
// numbers (row 6 leaves AC-AE blank for this base).
const APR_24_ROW11 = extractRowCells(
  '<c r="A11" s="16" t="s"><v>6</v></c><c r="B11" s="34"><v>16</v></c><c r="C11" s="3"><v>93</v></c><c r="D11" s="8"><v>95</v></c><c r="E11" s="8"><v>80</v></c><c r="F11" s="8"><v>70</v></c><c r="G11" s="8"><v>45</v></c><c r="H11" s="46"><v>15</v></c><c r="I11" s="46" t="s"><v>68</v></c><c r="J11" s="3"><v>16</v></c><c r="K11" s="1"/><c r="M11" s="8"><v>1</v></c><c r="N11" s="1"><v>259</v></c><c r="O11" s="1"><v>65</v></c><c r="P11" s="4"/><c r="Q11" s="3"><v>1</v></c><c r="R11" s="8"><v>15</v></c><c r="S11" s="1"><v>3</v></c><c r="T11" s="8"><v>10</v></c><c r="U11" s="8"><v>10</v></c><c r="V11" s="8"><v>10</v></c><c r="W11" s="1"><v>1</v></c><c r="X11" s="8"><v>10</v></c><c r="Y11" s="8"><v>10</v></c><c r="Z11" s="1"><v>3</v></c><c r="AB11" s="4"/><c r="AC11" s="50"><v>2.2807017543859649</v></c><c r="AD11" s="50"><v>15.2046783625731</v></c><c r="AE11" s="50"><v>2</v></c><c r="AF11" t="s"><v>50</v></c>',
)

describe('buildColumnMap excludes the "Walls Calculation" / "Hero Calculation" side table in Clashy_2026-04-24.xlsx', () => {
  const map = buildColumnMap(APR_24_ROW4, APR_24_ROW5, APR_24_SHARED_STRINGS)

  it('recognizes the real Pets columns through Greedy Raven (column AB)', () => {
    assert.equal(map.petCols['Greedy Raven'], 'AB')
  })

  it('excludes the calc columns (AC "Walls", AD "Walls +", AE "Heroes") rather than reading them as more Pets or Walls data', () => {
    assert.ok(map.excludedCols.has('AC'))
    assert.ok(map.excludedCols.has('AD'))
    assert.ok(map.excludedCols.has('AE'))
    // The real wall-level-19 column is K, from row 5's own numeric label —
    // the calc column's literal text "Walls" never parses as an integer, so
    // it was never a candidate to overwrite this regardless.
    assert.equal(map.wallCols['19'], 'K')
  })

  it('leaves the two "Notes"-labeled columns (AF, AG) out of excludedCols', () => {
    assert.equal(map.excludedCols.has('AF'), false)
    assert.equal(map.excludedCols.has('AG'), false)
  })
})

describe('parseDataRow keeps the calc columns out of notes even when they hold real numbers', () => {
  const map = buildColumnMap(APR_24_ROW4, APR_24_ROW5, APR_24_SHARED_STRINGS)

  it("row 6 (calc columns blank that week) reads only the real notes", () => {
    const row = parseDataRow(APR_24_ROW6, map, APR_24_SHARED_STRINGS)
    assert.ok(row)
    assert.equal(row.notes, 'TH 18 hammered 11/17; Gold pass 25-12, 26-01')
  })

  it('row 11 (calc columns populated with real weeks-to-upgrade numbers) still excludes them from notes', () => {
    const row = parseDataRow(APR_24_ROW11, map, APR_24_SHARED_STRINGS)
    assert.ok(row)
    assert.equal(row.notes, 'TH 16 week of 2025-11-01')
  })
})

describe('indexToColumnLetter', () => {
  it('inverts columnLetterToIndex', () => {
    assert.equal(indexToColumnLetter(1), 'A')
    assert.equal(indexToColumnLetter(26), 'Z')
    assert.equal(indexToColumnLetter(27), 'AA')
    assert.equal(indexToColumnLetter(28), 'AB')
  })
})

// ---------------------------------------------------------------------------
// Regression: Clashy_2025-10-09/10-21/10-30.xlsx each carry two sheets named
// after a literal date — "2025-10-10" and "2025-10-03" — rather than
// "Current". Direct inspection of all three files showed the "2025-10-03"
// sheet is byte-identical every time (a frozen, copy-forward snapshot whose
// tab name really is its week) while "2025-10-10" holds different real hero
// and wall data in every file (a live-edited sheet whose tab name is stale —
// the file it was actually saved under is the real week, same as any
// undated sheet). `classifyDatedSheets` is what tells these apart.
// ---------------------------------------------------------------------------

function row(playa: string, thLevel: number): ParsedDataRow {
  return { playa, thLevel, heroes: [], pets: [], walls: {}, buildingsLeft: undefined, notes: undefined }
}

describe('classifyDatedSheets', () => {
  it('classifies a dated sheet name as frozen when every occurrence has identical rows', () => {
    const occurrences = [
      { file: 'Clashy_2025-10-09.xlsx', sheetName: '2025-10-03', rows: [row('nc', 17)] },
      { file: 'Clashy_2025-10-21.xlsx', sheetName: '2025-10-03', rows: [row('nc', 17)] },
      { file: 'Clashy_2025-10-30.xlsx', sheetName: '2025-10-03', rows: [row('nc', 17)] },
    ]
    assert.equal(classifyDatedSheets(occurrences).get('2025-10-03'), 'frozen')
  })

  it('classifies a dated sheet name as live when its rows actually change between files', () => {
    const occurrences = [
      { file: 'Clashy_2025-10-09.xlsx', sheetName: '2025-10-10', rows: [row('nc', 17)] },
      { file: 'Clashy_2025-10-21.xlsx', sheetName: '2025-10-10', rows: [row('nc', 18)] },
      { file: 'Clashy_2025-10-30.xlsx', sheetName: '2025-10-10', rows: [row('nc', 18)] },
    ]
    assert.equal(classifyDatedSheets(occurrences).get('2025-10-10'), 'live')
  })

  it('defaults a dated sheet name seen only once to live, the safer default', () => {
    const occurrences = [{ file: 'Clashy_2025-10-09.xlsx', sheetName: '2025-10-10', rows: [row('nc', 17)] }]
    assert.equal(classifyDatedSheets(occurrences).get('2025-10-10'), 'live')
  })

  it('ignores sheet names that are not a literal YYYY-MM-DD date', () => {
    const occurrences = [
      { file: 'Clashy_2025-11-07.xlsx', sheetName: 'Current', rows: [row('nc', 17)] },
      { file: 'Clashy_2025-11-14.xlsx', sheetName: 'Current', rows: [row('nc', 18)] },
    ]
    assert.equal(classifyDatedSheets(occurrences).size, 0)
  })

  it("does not confuse two different bases' rows for a coincidental byte-identical match", () => {
    // Same shape, different row order — the signature must not depend on it.
    const occurrences = [
      { file: 'a.xlsx', sheetName: '2025-10-03', rows: [row('nc', 17), row('iv', 16)] },
      { file: 'b.xlsx', sheetName: '2025-10-03', rows: [row('iv', 16), row('nc', 17)] },
    ]
    assert.equal(classifyDatedSheets(occurrences).get('2025-10-03'), 'frozen')
  })
})
