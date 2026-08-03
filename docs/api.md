# The API, and what the upstream really returns

## API

The server exposes a thin, cached layer over the upstream API. Tags may be passed with or
without the leading `#` (URL-encode it as `%23` if you include it).

**Every route below requires a session** — see [Authentication](authentication.md#authentication). The one
exception is `/api/health`, which stays open for a host's liveness probe but answers a bare
`{ ok: true }` to an anonymous caller and only adds `cachedEntries` for an authenticated one.

| Route | Returns |
|---|---|
| `GET /api/health` | `{ ok: true }`, plus cache size when authenticated |
| `GET /api/players/:tag` | full player profile |
| `GET /api/clans/:tag` | clan detail including `memberList` |
| `GET /api/clans/:tag/members` | clan roster only |
| `GET /api/clans/:tag/currentwar` | live war, both rosters (20s cache) |
| `GET /api/clans/:tag/warlog` | past wars, newest first |
| `GET /api/clans/:tag/capitalraidseasons` | capital raid weekends, newest first (`?limit=`) |
| `GET /api/clans?name=…` | clan search by name (min 3 chars) |

Errors come back as `{ error: { status, reason, message, hint? } }`.

### Caching

Successful upstream responses are cached in memory for `CACHE_TTL_SECONDS` (default 60) and
identical concurrent requests are coalesced into one upstream call. Both exist to stay well
under Supercell's per-token rate limit while clicking around a roster. The cache is
per-process and disappears on restart — that is deliberate for a personal tool.

## What the API exposes per player tag

Verified against the live API, not the docs. **Only two endpoints take a player tag:**

| Endpoint | Notes |
|---|---|
| `GET /players/{playerTag}` | the full profile — troops, heroes, achievements, clan summary |
| `POST /players/{playerTag}/verifytoken` | confirms a player owns the account, using the in-game API token from Settings → More Settings. Returns `{tag, token, status}` |

`/players/{tag}/wars`, `/players/{tag}/clan`, and a `/players` list do **not** exist — all
404. Everything else worth having hangs off `player.clan.tag`, which the profile gives you:

| Endpoint | Returns |
|---|---|
| `GET /clans/{clanTag}` | clan detail incl. `memberList` |
| `GET /clans/{clanTag}/members` | roster only |
| `GET /clans/{clanTag}/currentwar` | live war — `state`, `clan`, `opponent`, per-member attacks |
| `GET /clans/{clanTag}/warlog` | past wars (only when the war log is public) |
| `GET /clans/{clanTag}/currentwar/leaguegroup` | CWL group — `state`, `season`, `clans`, `rounds` |
| `GET /clanwarleagues/wars/{warTag}` | an individual CWL war, from a round's war tags |
| `GET /clans/{clanTag}/capitalraidseasons` | Capital raid weekends |

Players also appear inside `/locations/{id}/rankings/players`,
`/locations/{id}/rankings/players-builder-base`, and Legend League season rankings — but
those are keyed by location or league, not by tag, so you cannot ask "where does this
player rank" directly. You would page the leaderboard and match on tag.

### There is no cards endpoint. Probed, not assumed.

The card event's counts are typed in by hand, and that is not a workaround for something
we did not look for. Probed against the live API from the droplet, every candidate
returns **404 `notFound`**:

```
/cards                      404
/cards/                     404
/players/{tag}/cards        404
/clans/{tag}/cards          404
/events                     404
/seasons                    404
```

So there is nothing to sync from and nothing to poll. Hand entry is the design, not a
stopgap, and the parts built around it — `updated_at` per base, save-on-blur, the
shared-counts model, the trade suggestions computed from what people typed — are load
bearing rather than temporary.

Worth re-running if Supercell ever ships an inventory API, because it would make most of
that unnecessary. The check is a loop over those paths with the token loaded; note that a
`403 accessDenied.invalidIp` tells you nothing about the path, only that you ran it from
the wrong host.

### One important caveat on tags

The API returns a flat `404 notFound` for a malformed tag *and* for a tag that simply does
not exist — `#!!!!`, `#IIIIIII`, and a plausible-but-unknown tag are indistinguishable in
its response. So client-side alphabet validation cannot be trusted to gate a lookup:
`normalizeTag` enforces only structure (3–12 alphanumerics), and
`usesCanonicalAlphabet` is advisory, surfaced as a warning while the lookup proceeds.

## Notes on the data

- The API returns `admin` for the role the game calls **Elder**. `ROLE_LABELS` in
  `shared/` maps the four roles to their in-game names.
- Tags never contain the letter `O` — that character is always a zero. `normalizeTag`
  corrects it, so a tag copied off a screenshot usually works.
- `warTies` and `warLosses` are only present when the clan's war log is public;
  `warWins` is always returned.
- **A private war log returns 403 on `/currentwar` too**, not just `/warlog` — so a 403 is
  not automatically an IP-binding problem. `describeFailure` in `server/src/coc-client.ts`
  branches on the path to give the right hint; the war one also tells you how to tell the
  two cases apart.
- **`/capitalraidseasons` is *not* gated on the war log.** Verified against four clans whose
  `/warlog` returns 403: all four answered 200 with full raid history. So the capital path is
  deliberately absent from that 403 branch — a 403 there really is the IP binding.
- **Capital raid `members` only appears while a weekend is `ongoing`.** Ended weekends omit
  the key, so `CapitalRaidSeason.members` is optional and past weekends carry no per-member
  attribution. Their `districts[].attacks` are dropped too.
- Capital raid `attacks` can exceed `attackLimit`: the bonus attack is reported separately as
  `bonusAttackLimit`, so the usable total is the sum. A raid clan summary spells its level
  `level`, not `clanLevel`.
- **War members use `townhallLevel`** (lowercase `h`), while player profiles use
  `townHallLevel`. Both spellings are correct for their own payload. Verified live.
- **Timestamps are ISO 8601 *basic* format** — `20260802T045542.000Z` — which `new Date()`
  parses as `Invalid Date`. Everything time-related must go through `parseCocTimestamp`.
- When `state` is `notInWar`, the API still returns `clan` and `opponent` objects, stubbed
  with `clanLevel: 0` and no `name`, `tag`, or `members`. Hence those fields are optional on
  `WarClan`.
- War-log `result` is `null` for Clan War League entries, and equal star counts can still be
  a win — destruction breaks the tie, so the table shows both sides' percentages.
