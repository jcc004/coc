# Setup, deployment and scripts

## Setup

Needs **Node ≥ 22.5** — that is where `node:sqlite` arrives, which is what stores the accounts.

```sh
npm install
cp .env.example .env      # then paste your token into COC_API_TOKEN

# First run only: create the admin account. Nothing can sign in without this.
# The credential is an email address — see "Email is the credential"
# in docs/authentication.md.
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long throwaway you will change' npm run dev
```

After that first start, drop `ADMIN_PASSWORD` again and just `npm run dev`. The API is on
<http://localhost:8787> and the UI on <http://localhost:5173>; Vite proxies `/api` to the
server, so open the Vite URL and sign in.

Get a token from <https://developer.clashofclans.com/#/account>.

### The Node version, and the divergence to fix

`.nvmrc` and `.github/workflows/verify.yml` both name **22.23.2**, exactly, not `22`. That is
tighter than anything else here is pinned, for one reason: `node:sqlite` is the whole persistence
layer, it is still flagged experimental, and its API has moved across Node 22, 23 and 24. It is
the single dependency with no fallback — every other choice in this repo has one. A major-only
pin means CI silently follows whatever 22.x shipped that week, so a runtime change arrives as a
test failure nobody asked for, on a commit that did not cause it. An exact pin makes the same
change a deliberate one-line bump that CI proves before the droplet ever sees it.

**Production and this working copy do not currently agree, and that is worth fixing before it
costs you an afternoon.** `deploy/README.md` installs Node from `deb.nodesource.com/setup_22.x`,
so the droplet is on 22; this checkout reports `v24.16.0`, which is what the test suite has been
passing under. Two different majors of the one runtime whose sqlite API is unstable. The failure
mode is not a version error — it is a database call that behaves one way locally and another way
on the host, so the suite is green here and the deploy is broken there, or the reverse, and
nothing in the symptom points at Node. Install the pinned version (`nvm install` in the repo root
reads `.nvmrc`; `fnm` and `asdf` read it too) and check `node --version` says `v22.23.2` before
trusting a green run. `package.json`'s `engines` floor of `>=22.5.0` is where `node:sqlite`
arrives; it is not a statement about what to develop on.

### The IP binding

Supercell binds each API key to the IP addresses you name when you create it. If requests
start failing with **403 `accessDenied.invalidIp`**, the address the app calls out from has
changed — mint a new key for the new one and update `.env`. The server surfaces this as a
hint in the error panel rather than leaving you to guess, because it is by far the most
common failure, and Supercell's own message names the address it saw.

**It is the *outbound* address, which is not always the one you reach the host on.** A host
behind a reserved, floating or elastic IP answers on that address but still makes its own
requests from its underlying public IP — and Supercell only ever sees the latter. This bit
production once: the key had been minted for the reserved IP the DNS points at, so every
lookup 403'd while the app itself was perfectly healthy. Ask the host what it looks like from
outside rather than assuming:

```bash
curl -s https://api.ipify.org
```

This is also the thing to solve before deploying anywhere: you need a static egress IP (a
small VPS, or a proxy with a fixed address), because most PaaS hosts rotate outbound IPs.
See [Deployment](#deployment).

## Deployment

What the host actually has to provide:

- **A persistent volume for the SQLite file.** Point `DATABASE_PATH` at an absolute path on it
  (`/data/coc.db`). On an ephemeral filesystem every restart wipes the accounts and the
  bootstrap runs again — which is also the one case where `ADMIN_PASSWORD` lingering in the
  environment would silently recreate the admin.
- **A static egress IP.** Supercell binds the API key to the IP addresses you name when you
  create it, so the app's *outbound* address must be fixed — and must be the address the key
  names. Most PaaS hosts rotate outbound IPs, which is why this wants a small VPS or a
  fixed-address proxy. Note that a reserved or floating IP is an *inbound* mapping and does
  not change where the host's own traffic comes from. Symptom of getting either wrong: every
  upstream call returns 403 `accessDenied.invalidIp`, naming the address that was seen.
- **HTTPS, and only HTTPS.** This is not optional. The app has real accounts, so on plain http
  the password and the session cookie both cross the network in clear text. `deploy/` is
  configured for TLS on 443 with port 80 doing nothing but redirecting and answering ACME
  challenges.
- **A hostname.** A browser-trusted certificate cannot be issued for a bare IP, so a name has
  to point at the host — a domain you own, or a free dynamic-DNS subdomain, both of which work
  with Let's Encrypt. The alternative, a self-signed certificate, means every user clicks
  through a TLS warning, which is a worse outcome than no TLS because it teaches them to.
- **`NODE_ENV=production`**, which marks the session cookie `Secure` (or `COOKIE_SECURE=true` if
  you terminate TLS but do not set `NODE_ENV`). Set it **after** the certificate works, never
  before: a browser will not return a `Secure` cookie over plain http, so the app appears to
  accept your login and then immediately forgets it, with nothing useful in the logs.
- **`ADMIN_EMAIL` / `ADMIN_PASSWORD` for exactly one boot**, then remove `ADMIN_PASSWORD`
  from the environment. Everything after that is created from the admin panel. Upgrading an
  existing deployment past the username→email change needs `ADMIN_EMAIL` set for one boot too,
  or nobody can sign in — see
  [the escape hatch](authentication.md#the-migration-and-the-escape-hatch).

The server runs under `tsx`; `npm start` is the whole command. Behind a reverse proxy, forward
`X-Forwarded-For` — it is what the login rate limiter keys its IP bucket on.

### Fetch the art as part of the build

`web/public/coc/` is gitignored, so **a deployed host has no game art until the asset scripts
run**. Neither is optional if you want the icons; both are safe to re-run, and both skip work
they have already done.

```sh
npm run assets:coc    # league + label icons, from the CoC API (needs COC_API_TOKEN)
npm run assets:wiki   # troop/spell/hero/equipment/Town Hall art, from the wiki (needs COC_API_TOKEN too)
npm run build         # must come after: Vite copies web/public into dist
```

Order matters — `vite build` copies `web/public` into `dist`, so anything fetched afterwards is
not in the bundle you shipped. Skip them entirely and the app still works: every icon is
optional and the UI falls back to the text-and-meter layout it had before the art existed.

**The card grid's pictures come from neither script.** They are a purpose-made set — sixty PNGs,
**256×320 portrait, each already cropped tight on its own subject** — sitting in
`web/public/coc/cards/` beside `manifest.json`, with per-file provenance in
`scripts/card-art-sources.csv`. No committed script produces either the art or the manifest, which
is why `web/src/cards.generated.ts` is committed: the card *list* is always correct on a host even
before any art arrives, and a host with no art shows sixty named, correctly sized, pictureless
tiles. An earlier set was derived from the `assets:wiki` thumbnails and cropped to a head in CSS;
that is no longer how a tile is framed — see [The tiles are framed whole](cards.md#the-tiles-are-framed-whole).

`assets:wiki` needs `COC_API_TOKEN` as well, because it asks the CoC API which units exist
before it goes looking for their pictures. It takes about a minute on a cold run (requests are
serialised and paced) and a few seconds when the files are already on disk.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | API + UI with reload |
| `npm test` | all three workspaces: `shared`'s own tests, the server's auth, card and trade suites (`app.request` against `createApp`, in-memory SQLite), and web unit tests for table sort, paging, owner-overwrite, `coc:saved` migration, wiki-art name lookup, the card list, the trade rules, the tracker's access and ordering rules, and the account menu. All three glob `src/**/*.test.ts`, so a new test file runs without being added to a list |
| `npm run typecheck` | `tsc --noEmit` across all three workspaces |
| `npm run build` | production bundle for the UI — run the two asset scripts *first* |
| `npm run assets:coc` | re-download the vendored league and label icons from the CoC API |
| `npm run assets:wiki` | re-download troop / spell / hero / equipment / Town Hall art from the wiki, and print a coverage report |
| `npm run cards:generate` | regenerate `web/src/cards.generated.ts` from the card manifest. Needs `web/public/coc/cards/manifest.json`, which is gitignored — so this only runs where the art tree exists, and the generated module is committed for everywhere else |
| `npm start` | API only, no watcher |

The server runs through `tsx` in both dev and production — there is no server build step.
