import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildMaxLevelReference,
  buildWallReference,
  cellLabel,
  parseHeroHallLevelCaps,
  parseLaboratoryUpgradeChart,
  parseLevelValue,
  parseTownHallBuildingLevels,
  parseWallReference,
  splitIntoTables,
  splitTableRows,
} from './wiki-tables.ts'

/*
 * Every fixture below is a trimmed but verbatim excerpt of wikitext actually
 * fetched from clashofclans.fandom.com's MediaWiki API (`action=parse&prop=
 * wikitext`) while building this parser — not hand-authored syntax. Trimmed to
 * a handful of rows/units for a readable fixture; never rewritten. Where a
 * page's real structure carried a hazard (a decoy table sharing a column name
 * with the wanted one; a Laboratory-level range that does not start at 1), the
 * fixture keeps enough of the page for the test to exercise it.
 */

describe('splitTableRows', () => {
  it('splits both one-cell-per-line and double-pipe same-line styles into the same shape', () => {
    const wikitext = `{|class="wikitable"
!scope="row"|TH Level
!scope="col"|Laboratory
|-
!scope="row" class="rowheader"|7
|6||9||5
|}`
    const rows = splitTableRows(wikitext)
    assert.deepEqual(rows, [
      ['scope="row"|TH Level', 'scope="col"|Laboratory'],
      ['scope="row" class="rowheader"|7', '6', '9', '5'],
    ])
  })
})

// parseLevelValue and cellLabel both operate on a cell *segment* the way
// splitTableRows hands them out — the line's own leading `|`/`!` marker
// already stripped, so these fixtures do not carry one either.

describe('parseLevelValue', () => {
  it('reads a plain integer', () => {
    assert.equal(parseLevelValue('13'), 13)
  })
  it('treats a dash as "nothing new this tier"', () => {
    assert.equal(parseLevelValue(' -'), null)
    assert.equal(parseLevelValue('-'), null)
  })
  it('takes the highest of a slash-delimited multi-upgrade cell', () => {
    assert.equal(parseLevelValue('2 / 3'), 3)
  })
  it('strips a cell attribute prefix before parsing', () => {
    assert.equal(parseLevelValue('class="GoldPass rCost"|16'), 16)
  })
})

describe('cellLabel', () => {
  it('reads a name out of the {{H|Name}} template', () => {
    assert.equal(cellLabel(' {{H|Barbarian}}'), 'Barbarian')
  })
  it('reads a name out of a plain wikilink', () => {
    assert.equal(cellLabel('[[Archer]]'), 'Archer')
  })
  it('falls back to cleaned plain text for a non-link header cell', () => {
    assert.equal(cellLabel('Total Levels'), 'Total Levels')
  })
})

describe('parseTownHallBuildingLevels', () => {
  // The "Army Buildings and Heroes" section's own tabber, real content: the
  // "Number Available=" tab (count of buildings — its own "Laboratory" column
  // holds "1", not a level) ahead of "Building Maximum Levels=" (the one this
  // function wants). A column-name search with no section narrowing would find
  // the first "Laboratory" column, which is the wrong table.
  const wikitext = `
===Army Buildings and Heroes===
<tabber>
Number Available=
Upgrading your Town Hall unlocks the following number of {{H|Army Buildings}}; see the page for each building for details.
{|class="wikitable mw-collapsible" id="townhall-max-buildings-table1" style="margin: 0px auto; width: 100%; text-align: center;" border="0" cellpadding="1" cellspacing="1"
|+Town Hall - Maximum Number of Buildings
|-
!scope="row" style="width:8%;" class="colheader"|<small>TH Level</small>
!scope="col" style="width:9%;" class="colheader"|<small>{{H|Army Camp}}</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Barracks]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Laboratory]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Spell Factory]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Dark Barracks]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Hero Hall]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Dark Spell Factory]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Blacksmith]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Workshop]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Pet House]]</small>
|-
!scope="row" class="rowheader"|7
|4||1||1||1||1||1|| -|| -|| -|| -
|}

See also: {{H|Army Buildings}}
|-|
Building Maximum Levels=
Upgrading your Town Hall allows the following {{H|Army Buildings}} to be upgraded to these levels; see the page for each structure to learn what each upgrade brings.
{|class="wikitable mw-collapsible" id="townhall-max-buildings-table1" style="margin: 0px auto; width: 100%; text-align: center;" border="0" cellpadding="1" cellspacing="1"
|+Town Hall - Building Max Level
|-
!scope="row" style="width:5%;" class="colheader"|<small>TH Level</small>
!scope="col" style="width:10%;" class="colheader"|<small>{{H|Army Camp}}</small>
!scope="col" style="width:10%;" class="colheader"|<small>[[Barracks]]</small>
!scope="col" style="width:10%;" class="colheader"|<small>[[Laboratory]]</small>
!scope="col" style="width:10%;" class="colheader"|<small>[[Spell Factory]]</small>
!scope="col" style="width:10%;" class="colheader"|<small>[[Dark Barracks]]</small>
!scope="col" style="width:9%;" class="colheader"|<small>[[Hero Hall]]</small>
!scope="col" style="width:10%;" class="colheader"|<small>[[Dark Spell Factory]]</small>
!scope="col" style="width:10%;" class="colheader"|<small>[[Blacksmith]]</small>
!scope="col" style="width:10%;" class="colheader"|<small>[[Workshop]]</small>
!scope="col" style="width:10%;" class="colheader"|<small>[[Pet House]]</small>
|-
!scope="row" class="rowheader"|1
|1||3|| -|| -|| -|| -|| -|| -|| -|| -
|-
!scope="row" class="rowheader"|7
|6||9||5||3||2||1|| -|| -|| -|| -
|-
!scope="row" class="rowheader"|18
|12||19||16||9||12||12||7||9||8||12
|}

See also: {{H|Army Buildings}}
</tabber>
`

  it('reads Laboratory and Hero Hall from the "Building Maximum Levels" tab, not "Number Available"', () => {
    const result = parseTownHallBuildingLevels(wikitext)
    assert.deepEqual(result.get(1), { laboratory: 0, heroHall: 0 })
    assert.deepEqual(result.get(7), { laboratory: 5, heroHall: 1 })
    assert.deepEqual(result.get(18), { laboratory: 16, heroHall: 12 })
  })
})

describe('parseLaboratoryUpgradeChart', () => {
  // Two of the page's three tables, real content: the Elixir table's Barbarian
  // row (dashes to skip, a running level to carry forward) and the Siege
  // Machines table's Wall Wrecker row, whose Laboratory Level columns start at
  // 10, not 1 — proof the parser reads each table's own header rather than
  // assuming a fixed 1..16 range.
  const wikitext = `
{{Res|RES=Elixir|SIZE=20}} <u>'''''[[Resources#Elixir|Elixir]]'''''</u> {{Res|RES=Elixir|SIZE=20}}
{| class="lab-table" border="1" cellpadding="1" cellspacing="1" style="width: 1150px; height: 100px; text-align: center; margin: 0px auto;"
! colspan="2" rowspan="2" scope="col" style="text-align: center; vertical-align: middle;" |''<span style="font-size:larger;">Upgrade Chart</span>''
! colspan="16" scope="col" style="text-align: center;" |'''Laboratory Level'''
|-
| scope="col" |1
| scope="col" |2
| scope="col" |3
| scope="col" |4
| scope="col" |5
| scope="col" |6
| scope="col" |7
| scope="col" |8
| scope="col" |9
| scope="col" |10
| scope="col" |11
| scope="col" |12
| scope="col" |13
| scope="col" |14
| scope="col" |15
|16
|-
! rowspan="3" class="rowheader" | {{H|Barbarian}}
| Level
| 2
| -
| 3
| -
| 4
| 5
| 6
| 7
| 8
| 9
| -
| 10
| 11
| 12
| -
|13
|-
| Cost
| class="GoldPass labRCost" | 10K
| -
| class="GoldPass labRCost" | 50K
| -
| class="GoldPass labRCost" | 130K
| class="GoldPass labRCost" | 300K
| class="GoldPass labRCost" | 800K
| class="GoldPass labRCost" | 1M
| class="GoldPass labRCost" | 1.5M
| class="GoldPass labRCost" | 2.5M
| -
| class="GoldPass labRCost" | 4.3M
| class="GoldPass labRCost" | 6M
| class="GoldPass labRCost" | 8M
| -
|24M
|-
| Time
| class="GoldPass labRTime" | 30m
| -
| class="GoldPass labRTime" | 1h
| -
| class="GoldPass labRTime" | 2h
| class="GoldPass labRTime" | 4h
| class="GoldPass labRTime" | 8h
| class="GoldPass labRTime" | 12h
| class="GoldPass labRTime" | 1d
| class="GoldPass labRTime" | 1d 12h
| -
| class="GoldPass labRTime" | 2d
| class="GoldPass labRTime" | 3d
| class="GoldPass labRTime" | 4d
| -
|12d 12h
|}

{{Res|RES=Elixir|SIZE=20}} <u>'''''[[Siege Machines]]'''''</u> {{Res|RES=Elixir|SIZE=20}}
{| class="lab-table" border="1" cellpadding="1" cellspacing="1" style="width: 100%; height: 100px; text-align: center;"
! colspan="2" rowspan="2" scope="col" style="text-align: center; vertical-align: middle;" |''<span style="font-size:larger;">Upgrade Chart</span>''
! colspan="7" scope="col" style="text-align: center;" |'''Laboratory Level'''
|-
! scope="col" | 10
! scope="col" | 11
! scope="col" | 12
! scope="col" | 13
! scope="col" | 14
! scope="col" | 15
!16
|-
! rowspan="3" class="rowheader" | [[Wall Wrecker]]
| Level
| 2 / 3
| 4
| -
| 5
| -
| -
|6
|-
| Cost
| class="GoldPass labRCost" | 2.5M / 3.5M
| class="GoldPass labRCost" | 6.5M
| -
| class="GoldPass labRCost" | 10M
| -
| -
|26M
|-
| Time
| class="GoldPass labRTime" | 2d / 3d
| class="GoldPass labRTime" | 7d
| -
| class="GoldPass labRTime" | 9d
| -
| -
|13d 12h
|}
`

  it('finds the two tables', () => {
    assert.equal(splitIntoTables(wikitext).length, 2)
  })

  it('reads Barbarian as a troop, carrying its level forward across dash columns', () => {
    const { units, warnings } = parseLaboratoryUpgradeChart(wikitext)
    assert.deepEqual(warnings, [])

    const barbarian = units.find((u) => u.name === 'Barbarian')
    assert.ok(barbarian)
    assert.equal(barbarian.category, 'troop')
    assert.deepEqual(
      [...barbarian.capAtLabLevel.entries()],
      [
        [1, 2],
        [2, 2],
        [3, 3],
        [4, 3],
        [5, 4],
        [6, 5],
        [7, 6],
        [8, 7],
        [9, 8],
        [10, 9],
        [11, 9],
        [12, 10],
        [13, 11],
        [14, 12],
        [15, 12],
        [16, 13],
      ],
    )
  })

  it('reads Wall Wrecker with its Laboratory Level columns starting at 10, and folds it into troop', () => {
    const { units } = parseLaboratoryUpgradeChart(wikitext)
    const wallWrecker = units.find((u) => u.name === 'Wall Wrecker')
    assert.ok(wallWrecker)
    assert.equal(wallWrecker.category, 'troop')
    assert.deepEqual(
      [...wallWrecker.capAtLabLevel.entries()],
      [
        [10, 3],
        [11, 4],
        [12, 4],
        [13, 5],
        [14, 5],
        [15, 5],
        [16, 6],
      ],
    )
  })

  it('classifies a spell by name, not by table', () => {
    const spellWikitext = `
{|
! colspan="2" rowspan="2"|x
! colspan="1"|Laboratory Level
|-
| scope="col" |1
|-
! rowspan="3" class="rowheader" | {{H|Lightning Spell}}
| Level
| 2
|-
| Cost
| -
|-
| Time
| -
|}`
    const { units } = parseLaboratoryUpgradeChart(spellWikitext)
    assert.equal(units.length, 1)
    assert.equal(units[0]?.category, 'spell')
  })
})

describe('parseHeroHallLevelCaps', () => {
  // Real content, trimmed to Hero Hall levels 1, 7 and 12 of the table's full
  // 1-12. Row 1 shows every hero but Barbarian King still dashed out (not yet
  // unlocked); row 7 introduces Dragon Duke as a dash too, for a hero added
  // later than the rest.
  const wikitext = `
===Hero Hall Level Caps===
Upgrading the Hero Hall allows the following Heroes to be upgraded to these levels; see the page for each Hero to learn what each upgrade brings.
{|class="wikitable" style="margin: 0px auto; width: 100%; text-align: center;" border="0" cellpadding="1" cellspacing="1"
!scope="row" style="width:20%;" class="colheader"|Hero Hall Level
!scope="col" style="width:10%;" class="colheader"|[[Barbarian King]]
!scope="col" style="width:10%;" class="colheader"|[[Archer Queen]]
!scope="col" style="width:10%;" class="colheader"|[[Minion Prince]]
!scope="col" style="width:10%;" class="colheader"|[[Grand Warden]]
!scope="col" style="width:10%;" class="colheader"|[[Royal Champion]]
!scope="col" style="width:10%;" class="colheader"|[[Dragon Duke]]
!scope="col" style="width:10%;" class="colheader"|Total Levels
|-
!scope="row" class="rowheader"|1
|10||-||-||-||-||-
!10
|-
!scope="row" class="rowheader"|7
|75||75||50||50||25||-
!275
|-
!scope="row" class="rowheader"|12
|110||110||95||85||55||25
!480
|}
`

  it('reads every hero from the header, keyed by Hero Hall level', () => {
    const heroes = parseHeroHallLevelCaps(wikitext)
    assert.deepEqual(
      [...heroes.keys()],
      ['Barbarian King', 'Archer Queen', 'Minion Prince', 'Grand Warden', 'Royal Champion', 'Dragon Duke'],
    )
    assert.deepEqual(
      [...(heroes.get('Barbarian King')?.entries() ?? [])],
      [
        [1, 10],
        [7, 75],
        [12, 110],
      ],
    )
    // Dashed out at Hero Hall 1 and 7 (not yet unlocked) — no entry for either.
    assert.deepEqual([...(heroes.get('Dragon Duke')?.entries() ?? [])], [[12, 25]])
  })
})

describe('parseWallReference', () => {
  // Real content: Wall/Home Village's Statistics table trimmed to levels 1-4
  // and 19, plus the {{NumberAvailable}} template call from the same section.
  const wikitext = `
{{NumberAvailable|width=750px;|tablestyle=margin:0px auto;||TH2=25||TH3=50||TH4=75||TH5=100||TH6=125||TH7=175||TH8=225||TH9=250||TH10=275||TH11=300||TH14=325}}
{{BuildingSize|1x1}}
{|class="wikitable" style="text-align: center; width: 100%;" cellspacing="1" cellpadding="1" border="0"
!Level<br/>{{Res|Level}}
!Hitpoints<br/>{{Res|Hitpoint}}
![[Resources#Gold|Cost]]<br/>{{Res|Gold}}
!Cumulative Cost<br/>{{Res|Gold}}
![[Resources#Elixir|Cost]]<br/>{{Res|Elixir}}
!Cumulative Cost<br/>{{Res|Elixir}}
![[Magic Items|Cost]]<br/>{{Res|Wall Ring}}
![[Town Hall]] Level Required<br/>{{Res|Town Hall}}
|-
|1
|100
|class="GoldPass bCost"|0
|class="GoldPass bCost"|0
|N/A
|N/A
|N/A
|2
|-
|2
|200
|class="GoldPass bCost"|1,000
|class="GoldPass bCost"|1,000
|N/A
|N/A
|1
|2
|-
|3
|400
|class="GoldPass bCost"|5,000
|class="GoldPass bCost"|6,000
|N/A
|N/A
|1
|class="change-highlight"|3
|-
|19
|14,000
|class="GoldPass bCost"|10,000,000
|class="GoldPass bCost"|34,491,000
|class="GoldPass bCost"|10,000,000
|class="GoldPass bCost"|34,475,000
|10
|18
|}
`

  it('reads the max wall level per Town Hall from the "Town Hall Level Required" column', () => {
    const { maxWallLevelByTh } = parseWallReference(wikitext)
    assert.equal(maxWallLevelByTh.get(1), undefined) // no wall level requires TH1 or less
    assert.equal(maxWallLevelByTh.get(2), 2)
    assert.equal(maxWallLevelByTh.get(3), 3)
    assert.equal(maxWallLevelByTh.get(17), 3) // level 19 (TH18) not reached yet
    assert.equal(maxWallLevelByTh.get(18), 19)
  })

  it('forward-fills the wall count between the step changes named in {{NumberAvailable}}', () => {
    const { totalWallCountByTh } = parseWallReference(wikitext)
    assert.equal(totalWallCountByTh.get(1), undefined)
    assert.equal(totalWallCountByTh.get(2), 25)
    assert.equal(totalWallCountByTh.get(11), 300)
    assert.equal(totalWallCountByTh.get(13), 300) // carried forward; no TH12/13 step
    assert.equal(totalWallCountByTh.get(14), 325)
    assert.equal(totalWallCountByTh.get(18), 325) // carried forward again; no step past TH14
  })

  it('buildWallReference only emits a Town Hall that has both a level and a count', () => {
    const rows = buildWallReference(parseWallReference(wikitext))
    assert.equal(rows.find((r) => r.thLevel === 1), undefined)
    assert.deepEqual(rows.find((r) => r.thLevel === 2), { thLevel: 2, maxWallLevel: 2, totalWallCount: 25 })
    assert.deepEqual(rows.find((r) => r.thLevel === 18), {
      thLevel: 18,
      maxWallLevel: 19,
      totalWallCount: 325,
    })
  })
})

describe('buildMaxLevelReference', () => {
  it('joins Town Hall building levels against unit and hero caps, skipping a Town Hall below the minimum requirement', () => {
    const thBuildings = new Map([
      [1, { laboratory: 0, heroHall: 0 }],
      [7, { laboratory: 5, heroHall: 1 }],
      [18, { laboratory: 16, heroHall: 12 }],
    ])
    const labUnits = [
      {
        name: 'Barbarian',
        category: 'troop' as const,
        capAtLabLevel: new Map([
          [1, 2],
          [5, 4],
          [16, 13],
        ]),
      },
      {
        name: 'Wall Wrecker',
        category: 'troop' as const,
        capAtLabLevel: new Map([
          [10, 3],
          [16, 6],
        ]),
      },
    ]
    const heroes = new Map([['Barbarian King', new Map([[1, 75]])]])

    const rows = buildMaxLevelReference(labUnits, heroes, thBuildings)

    // TH1: no Laboratory at all, so neither troop has a row.
    assert.equal(rows.some((r) => r.thLevel === 1 && r.name === 'Barbarian'), false)
    assert.equal(rows.some((r) => r.thLevel === 1 && r.name === 'Wall Wrecker'), false)

    // TH7: Laboratory 5 reaches Barbarian's cap-at-5 but not Wall Wrecker's minimum of 10.
    assert.deepEqual(rows.find((r) => r.thLevel === 7 && r.name === 'Barbarian'), {
      category: 'troop',
      name: 'Barbarian',
      thLevel: 7,
      maxLevel: 4,
    })
    assert.equal(rows.some((r) => r.thLevel === 7 && r.name === 'Wall Wrecker'), false)

    // TH18: Laboratory 16 reaches both units' full cap; Hero Hall 12 reaches the Barbarian King row.
    assert.deepEqual(rows.find((r) => r.thLevel === 18 && r.name === 'Barbarian'), {
      category: 'troop',
      name: 'Barbarian',
      thLevel: 18,
      maxLevel: 13,
    })
    assert.deepEqual(rows.find((r) => r.thLevel === 18 && r.name === 'Wall Wrecker'), {
      category: 'troop',
      name: 'Wall Wrecker',
      thLevel: 18,
      maxLevel: 6,
    })
    assert.deepEqual(rows.find((r) => r.thLevel === 18 && r.name === 'Barbarian King'), {
      category: 'hero',
      name: 'Barbarian King',
      thLevel: 18,
      maxLevel: 75,
    })
  })
})
