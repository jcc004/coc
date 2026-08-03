# Game art and the Fan Content Policy

The UI wears a Clash-themed skin — parchment and stone by day, dark wood by night,
gold-bevelled panels and pressed buttons. All of that is CSS: gradients and bevels,
no image assets, so it costs nothing to load and works in both themes.

The actual game art is a different matter, and it arrives from two different places.

## What the API gives you

Three things come from Supercell's CDN via the API, and only these three:

| Asset | Source | Vendored? |
|---|---|---|
| League badges | `league.iconUrls` | yes — 23 files |
| Clan / player label icons | `labels[].iconUrls` | yes — 36 files |
| Clan badges | `clan.badgeUrls` | no — one per clan, unbounded |

`npm run assets:coc` downloads the two finite sets into `web/public/coc` and
regenerates `web/src/coc-assets.ts` with the ids that landed. Vendoring them means
the app is not hotlinking `api-assets.clashofclans.com`, so it survives offline and
under a strict CSP.

That is the whole list. The API returns **no** imagery for troops, spells, heroes,
hero equipment, Town Halls or resources — those arrays carry only `name`, `level`,
`maxLevel` and `village`, which is why the progression section was level meters with
no pictures.

## What the wiki gives you

`npm run assets:wiki` fills that gap from the community
[Clash of Clans Wiki](https://clashofclans.fandom.com/), via its MediaWiki API —
`action=query&prop=imageinfo`, never HTML scraping.

| Asset | Count | Wiki file convention |
|---|---|---|
| Heroes | 8 | `File:<Name> info.png` |
| Hero equipment | 41 | `File:<Name>.png` |
| Troops (home + builder base) | 81 | `File:<Name> info.png` |
| Spells | 18 | `File:<Name> info.png` |
| Town Halls 1–18 | 18 | `File:Town Hall<n>.png`, or `File:Town Hall <n> info.png` for TH17 |

166 files, ~3.2 MiB on disk, against a 3 MiB cap the script reports against. It stays
manageable because `iiurlwidth`/`iiurlheight` make MediaWiki render the thumbnail
server-side, so the app asks for art at the size it displays instead of pulling a
4000×4000 original and needing an image library to shrink it. There is no `sharp`
here and there should not be.

`THUMB` is **256px**. It was sized for the card grid, which used to draw these files; the card art is
now its own purpose-made set (see [The tiles are framed whole](cards.md#the-tiles-are-framed-whole)), so the
biggest remaining consumer is the 32px `.art-icon` slot, which simply downscales. (The 28px
thumbnails in the trade table are the *card* PNGs, not these.) Raising a rendered size past what `THUMB`
supplies makes the art soft; raise `THUMB` to match, and re-run with **`REFETCH=1`**, because the
ordinary run skips anything already on disk and would otherwise keep the old, smaller files.

It is polite by construction: existence checks batch 50 titles per request,
downloads run serially with a 300ms delay, anything already on disk is skipped
(unless `REFETCH=1`), and the `User-Agent` names the tool (override the contact via
`WIKI_CONTACT`).

**Names are resolved by convention, never by fuzzy matching.** The script derives
candidate file titles from the API's own `name` string and takes the first that
exists; a name that matches nothing stays unmapped and is listed in the coverage
report the script prints. That matters because a confidently wrong troop icon is
worse than a missing one — `"Super Goblin"` must not borrow the Goblin's picture.
Coverage is currently 166/166. `web/src/wiki-art.ts` holds the normalisation and
lookup (case-, punctuation- and accent-insensitive, so `P.E.K.K.A` → `pekka`) and is
unit tested in `web/src/wiki-art.test.ts`; `web/src/wiki-art.generated.ts` holds only
the machine-written map.

Per-file provenance lives in `web/public/coc/wiki/manifest.json` — every entry records
the API name, the exact wiki file title it came from and a link to that file's page,
so attribution is traceable rather than folklore.

## Absent art is the normal case, not an error

`web/public/coc/` is **gitignored** — the art is Supercell's, not ours to redistribute
through this repo. So a fresh clone, and any host that has not run the asset scripts,
has the ids and paths but none of the files. Both layers degrade rather than break:

- **League and label icons** fall back to the CDN URL the API supplied, so they still
  render.
- **Wiki unit art has no fallback on purpose** — hotlinking the wiki would be rude and
  fragile. `GameIcon` called without a `fallback` removes itself on error instead, so
  the row reads exactly as it did before the art existed: name, meter, level. Verified
  in a browser, not assumed: a meter row measures 49.0px with art, with a 404, and with
  no art at all, and a roster row with no art is 38.0px — the same as before this
  change.

Never a broken image, never a reserved empty slot, never a reflowed table.

## Licensing, and why it matters more now

Supercell's [Fan Content Policy](https://supercell.com/en/fan-content-policy/) permits
their assets in fan projects on conditions. **This app is going to public hosting**,
which turns those conditions from theoretical into binding — private local use is one
thing, publishing is another. So, plainly:

- **Keep it non-commercial.** No ads, no payments, no selling access.
- **Keep the disclaimer.** The unofficial-and-not-endorsed notice is rendered in the
  page footer (`.site-footer` in `App.tsx`), which is where the policy wants it rather
  than buried in this file. **Do not remove it** while the app shows their art.
- **Do not use Supercell's art as branding.** Not as a logo, favicon, app icon, social
  card or wordmark. It labels game data inside the app; that is all.
- **The repo redistributes nothing.** Keeping `web/public/coc/` gitignored is a
  licensing decision, not a housekeeping one. Do not commit the art to make deployment
  easier — run the fetch scripts on the host instead.

One thing to be clear about: Fandom's text is CC BY-SA, and **that licence does not
extend to these images**. They are user-uploaded game rips. Crediting the wiki as the
source (the footer does) is honest attribution; it is not a licence, and no licence is
available — the art is Supercell's, used under their fan policy or not at all.

## Not covered

- **Capital district art does not exist on the wiki.** Checked: there is no per-district
  image for Wizard Valley, Balloon Lagoon, Golem Quarry and the rest, only a generic
  `District_Hall<n>.png` by level. Mapping that generic building onto district names
  would show the same picture for every district, which is worse than no picture, so
  `CapitalRaidsCard` has none.
- **Resource and achievement icons** are not fetched. Nothing in the UI is keyed to a
  resource type by name, so there is nowhere to put them.
