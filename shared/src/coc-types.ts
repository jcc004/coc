/**
 * Hand-written types for the subset of https://api.clashofclans.com/v1 this app
 * uses. Fields the API only sometimes returns are marked optional — the docs
 * are not reliable about which those are, so treat anything optional as
 * genuinely absent-able.
 */

export interface BadgeUrls {
  small: string
  medium: string
  large: string
}

export interface IconUrls {
  tiny?: string
  small: string
  medium?: string
  large?: string
}

export interface League {
  id: number
  name: string
  iconUrls: IconUrls
}

export interface Label {
  id: number
  name: string
  iconUrls: IconUrls
}

export interface Location {
  id: number
  name: string
  isCountry: boolean
  countryCode?: string
}

/** The API returns `admin` for what the game calls Elder. */
export type ClanRole = 'member' | 'admin' | 'coLeader' | 'leader'

export type WarPreference = 'in' | 'out'

export type Village = 'home' | 'builderBase' | 'clanCapital'

export interface PlayerClanSummary {
  tag: string
  name: string
  clanLevel: number
  badgeUrls: BadgeUrls
}

export interface PlayerItemLevel {
  name: string
  level: number
  maxLevel: number
  village: Village
  superTroopIsActive?: boolean
  /** Hero equipment currently slotted on a hero. */
  equipment?: PlayerItemLevel[]
}

export interface Achievement {
  name: string
  stars: number
  value: number
  target: number
  info: string
  completionInfo: string | null
  village: Village
}

export interface PlayerHouseElement {
  type: string
  id: number
}

export interface Player {
  tag: string
  name: string
  townHallLevel: number
  townHallWeaponLevel?: number
  expLevel: number
  trophies: number
  bestTrophies: number
  warStars: number
  attackWins: number
  defenseWins: number
  builderHallLevel?: number
  builderBaseTrophies?: number
  bestBuilderBaseTrophies?: number
  role?: ClanRole
  warPreference?: WarPreference
  donations: number
  donationsReceived: number
  clanCapitalContributions: number
  clan?: PlayerClanSummary
  league?: League
  builderBaseLeague?: { id: number; name: string }
  legendStatistics?: {
    legendTrophies: number
    bestSeason?: { id: string; rank: number; trophies: number }
    currentSeason?: { rank?: number; trophies: number }
    previousSeason?: { id: string; rank: number; trophies: number }
  }
  achievements: Achievement[]
  labels: Label[]
  troops: PlayerItemLevel[]
  heroes: PlayerItemLevel[]
  heroEquipment?: PlayerItemLevel[]
  spells: PlayerItemLevel[]
  playerHouse?: { elements: PlayerHouseElement[] }
}

export interface ClanMember {
  tag: string
  name: string
  role: ClanRole
  townHallLevel: number
  expLevel: number
  league?: League
  trophies: number
  builderBaseTrophies?: number
  clanRank: number
  previousClanRank: number
  donations: number
  donationsReceived: number
  playerHouse?: { elements: PlayerHouseElement[] }
}

export interface ClanDistrict {
  id: number
  name: string
  districtHallLevel: number
}

export interface Clan {
  tag: string
  name: string
  type: 'open' | 'inviteOnly' | 'closed'
  description: string
  location?: Location
  isFamilyFriendly: boolean
  badgeUrls: BadgeUrls
  clanLevel: number
  clanPoints: number
  clanBuilderBasePoints: number
  clanCapitalPoints: number
  capitalLeague?: { id: number; name: string }
  requiredTrophies: number
  warFrequency: string
  warWinStreak: number
  warWins: number
  /** Only present when the war log is public. */
  warTies?: number
  warLosses?: number
  isWarLogPublic: boolean
  warLeague?: { id: number; name: string }
  members: number
  memberList: ClanMember[]
  labels: Label[]
  requiredBuilderBaseTrophies?: number
  requiredTownhallLevel?: number
  chatLanguage?: { id: number; name: string; languageCode: string }
  clanCapital?: {
    capitalHallLevel?: number
    districts?: ClanDistrict[]
  }
}

/* ---------- wars ---------- */

export type WarState = 'notInWar' | 'preparation' | 'inWar' | 'warEnded'

export interface WarAttack {
  attackerTag: string
  defenderTag: string
  stars: number
  destructionPercentage: number
  order: number
  /** Seconds spent on the attack. */
  duration: number
}

export interface WarMember {
  tag: string
  name: string
  /**
   * Lowercase `h` — the war payload spells this differently from the player
   * payload's `townHallLevel`. Verified against the live API; do not "fix" it.
   */
  townhallLevel: number
  mapPosition: number
  opponentAttacks: number
  attacks?: WarAttack[]
  bestOpponentAttack?: WarAttack
}

export interface WarClan {
  /**
   * Absent when `state` is `notInWar`: the API still returns both side objects,
   * but stubbed out with `clanLevel: 0` and no identity or members.
   */
  tag?: string
  name?: string
  badgeUrls: BadgeUrls
  clanLevel: number
  attacks: number
  stars: number
  destructionPercentage: number
  members?: WarMember[]
  /** War-log entries only. */
  expEarned?: number
}

export interface CurrentWar {
  state: WarState
  teamSize?: number
  attacksPerMember?: number
  battleModifier?: string
  /** Supercell's own basic-format timestamps — parse with `parseCocTimestamp`. */
  preparationStartTime?: string
  startTime?: string
  endTime?: string
  clan: WarClan
  opponent: WarClan
}

export interface WarLogEntry {
  /** `null` for Clan War League entries, which have no head-to-head result. */
  result: 'win' | 'lose' | 'tie' | null
  endTime: string
  teamSize: number
  attacksPerMember?: number
  battleModifier?: string
  clan: WarClan
  opponent: WarClan
}

export interface WarLogResponse {
  items: WarLogEntry[]
  paging?: { cursors: { after?: string; before?: string } }
}

/* ---------- capital raid weekends ---------- */

export type CapitalRaidState = 'ongoing' | 'ended'

export interface CapitalRaidMember {
  tag: string
  name: string
  /**
   * Attacks used, which routinely *exceeds* `attackLimit` — the base limit and
   * the bonus are reported separately, so the usable total is
   * `attackLimit + bonusAttackLimit`.
   */
  attacks: number
  attackLimit: number
  bonusAttackLimit: number
  capitalResourcesLooted: number
}

export interface CapitalRaidDistrictAttack {
  attacker: { tag: string; name: string }
  destructionPercent: number
  stars: number
}

export interface CapitalRaidDistrict {
  id: number
  name: string
  districtHallLevel: number
  destructionPercent: number
  stars: number
  attackCount: number
  totalLooted: number
  /** Absent on an untouched district, and on every district of an ended weekend. */
  attacks?: CapitalRaidDistrictAttack[]
}

export interface CapitalRaidClanSummary {
  tag: string
  name: string
  /** Clan level. Spelled `level` here, not `clanLevel` as everywhere else. */
  level: number
  badgeUrls: BadgeUrls
}

interface CapitalRaidLogEntry {
  attackCount: number
  districtCount: number
  districtsDestroyed: number
  districts: CapitalRaidDistrict[]
}

/** One clan this clan raided. */
export interface CapitalRaidAttackLogEntry extends CapitalRaidLogEntry {
  defender: CapitalRaidClanSummary
}

/** One clan that raided this clan. */
export interface CapitalRaidDefenseLogEntry extends CapitalRaidLogEntry {
  attacker: CapitalRaidClanSummary
}

export interface CapitalRaidSeason {
  state: CapitalRaidState
  /** Basic-format timestamps again — parse with `parseCocTimestamp`. */
  startTime: string
  endTime: string
  capitalTotalLoot: number
  raidsCompleted: number
  totalAttacks: number
  enemyDistrictsDestroyed: number
  offensiveReward: number
  defensiveReward: number
  /**
   * Only present while `state` is `ongoing` — verified live against two clans,
   * where every `ended` weekend omitted `members` entirely (not an empty array).
   * Past weekends therefore give totals but no per-member attribution at all.
   */
  members?: CapitalRaidMember[]
  attackLog: CapitalRaidAttackLogEntry[]
  /** An empty array, not absent, for a clan nobody raided. */
  defenseLog: CapitalRaidDefenseLogEntry[]
}

export interface CapitalRaidSeasonsResponse {
  items: CapitalRaidSeason[]
  paging?: { cursors: { after?: string; before?: string } }
}

/** Shape of the error body the CoC API returns on a non-2xx response. */
export interface CocErrorBody {
  reason: string
  message?: string
  type?: string
  detail?: unknown
}

/** Error envelope this app's own API returns. */
export interface ApiErrorResponse {
  error: {
    status: number
    reason: string
    message: string
    /** Set when we can offer a concrete next step, e.g. an IP mismatch. */
    hint?: string
  }
}

export interface ClanSearchResponse {
  items: Clan[]
  paging?: { cursors: { after?: string; before?: string } }
}

export interface ClanMembersResponse {
  items: ClanMember[]
  paging?: { cursors: { after?: string; before?: string } }
}

export const ROLE_LABELS: Record<ClanRole, string> = {
  leader: 'Leader',
  coLeader: 'Co-leader',
  admin: 'Elder',
  member: 'Member',
}
