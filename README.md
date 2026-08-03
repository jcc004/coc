# coc

A Clash of Clans API explorer: look up player profiles, clan details, clan rosters, wars, and
capital raid weekends.

TypeScript throughout — [Hono](https://hono.dev) API on Node, React + Vite frontend, no
component library. The API token stays on the server; the browser only ever talks to `/api`.

## Setup

Needs **Node ≥ 22.5** — that is where `node:sqlite` arrives, which is what stores the accounts.

```sh
npm install
cp .env.example .env      # then paste your token into COC_API_TOKEN

# First run only: create the admin account. Nothing can sign in without this.
# The credential is an email address — see "Email is the credential" below.
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long throwaway you will change' npm run dev
```

After that first start, drop `ADMIN_PASSWORD` again and just `npm run dev`. The API is on
<http://localhost:8787> and the UI on <http://localhost:5173>; Vite proxies `/api` to the
server, so open the Vite URL and sign in.

Get a token from <https://developer.clashofclans.com/#/account>.

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

## Authentication

**Why it exists.** The Supercell token lives server-side and is rate-limited *per token*. An
open `/api/*` on the public internet is therefore a free proxy onto that budget — anyone who
finds the URL can spend it, and Supercell throttles the key, not the caller. Authentication
here is not a login form for decoration; it is what protects the token.

### The model

- **Server-side sessions, not JWT.** A session is a row in SQLite keyed by a 256-bit opaque
  token (32 random bytes, base64url) in an `HttpOnly` cookie. With ten users the row costs
  nothing and buys the thing a JWT cannot: **instant revocation**. Sign-out, a password
  change, and disabling an account all take effect on the next request, because the check is a
  lookup rather than a signature over a claim that stays valid until it expires. There is no
  refresh-token dance and no key rotation to get wrong.
- **Cookie**: `HttpOnly` (JavaScript cannot read the token, so an XSS bug cannot exfiltrate a
  session), `SameSite=Lax` (the browser withholds it on cross-site POSTs, which is the CSRF
  defence for every state-changing route), `Path=/`, and `Secure` whenever
  `NODE_ENV=production` or `COOKIE_SECURE=true` — conditional only so plain-http localhost
  still receives it.
- **Expiry** is 30 days, slid forward on every authenticated request. An expired session is
  rejected *and* deleted; a background sweep every hour keeps the table from growing.
- **Passwords**: `scryptSync` with a 16-byte per-user random salt, compared with
  `timingSafeEqual`. Cost is N = 2^15, r = 8, p = 1 (32 MiB, ~40 ms per hash on a laptop) and
  the parameters are stored inside the hash string, so N can be raised later without
  invalidating existing hashes. The reasoning for not using OWASP's N = 2^17 is in the comment
  at the top of `server/src/auth/passwords.ts`. No plaintext password is logged, returned, or
  stored.
- **No open registration.** A public signup form for a ten-person tool is a liability. The
  first admin comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, applied **only when the `users`
  table is empty** — which is what makes it idempotent: restart with the vars still set and it
  finds a user and does nothing, so it can never reset a password you have since changed. With
  no users *and* no credentials configured it logs a loud message and leaves the app unusable,
  rather than falling back to a default password that is by definition already public.
- **Failed login is not an oracle.** Unknown address, wrong password, disabled account, and
  an account whose email is null return the identical 401 body, and the unknown-address path
  hashes against a decoy record so it does the same scrypt work — otherwise the response time
  alone would tell an attacker which addresses exist.
- **Login is rate-limited** in memory (one process, ten users), with two independent buckets:
  5 failures per email and 30 per client IP, each locking for 15 minutes. There is
  deliberately no global counter — the worst failure mode for a tool with one admin is
  everybody being locked out at once. The IP bucket is the loose one because a whole household
  can share an address, and because behind an HTTPS terminator the address comes from
  `X-Forwarded-For`, which is spoofable by anyone reaching the app directly; the email
  bucket carries the real protection. With no usable address at all the IP bucket is skipped
  rather than pooling every caller under one key — a shared key *is* a whole-app lockout.

### Routes

`/api/*` is **deny-by-default**: `server/src/app.ts` names `/api/health`, `/api/auth/login`
and `/api/auth/logout` as the only public paths and requires a session for everything else, so
a route added later cannot become a hole by omission.

| Route | Who |
|---|---|
| `POST /api/auth/login` | anyone (rate-limited) |
| `POST /api/auth/logout` | anyone; idempotent, clears the cookie either way |
| `GET /api/auth/me` | signed in — the UI's boot probe |
| `POST /api/auth/password` | signed in; re-checks the current password, then revokes every *other* session |
| `GET /api/admin/users` | admin |
| `POST /api/admin/users` | admin — `{ email, displayName?, password, role }` |
| `POST /api/admin/users/:id/disable` | admin — `{ disabled }`, so it re-enables too |
| `PATCH /api/admin/users/:id/email` | admin — `{ email }`; corrects a login address |
| `POST /api/admin/users/:id/temp-password` | admin — no body; the server mints the password |

Disabling an account deletes its sessions immediately. Two guards sit in front of it: an admin
cannot disable **themselves**, and nobody can disable the **last active admin** — with zero
active admins there is no route back, only hand-editing SQLite. The two rules coincide today
(the only way to reach zero is via your own row) and are still stated separately, because the
self-check would stop protecting the install the moment a route existed that could change an
admin's role.

### Password recovery is admin-mediated, and there is deliberately no email reset

There is **no** `POST /api/auth/forgot-password`, no `password_reset_tokens` table, no SMTP
config and no mail provider. That is a decision, not a gap:

- **There is no mail infrastructure**, and adding it for a ten-person tool means a provider
  account, a domain with SPF/DKIM, deliverability to worry about, and one more credential in
  `.env` — all so that a link can do what a person saying a password out loud already does.
- **A public reset route would be the first hole in a deny-by-default API.** `/api/*` currently
  has exactly three public paths, all of which either return nothing interesting or are the
  login itself. A reset endpoint has to accept an unauthenticated body naming an account, which
  is a strictly larger attack surface than anything the app has today, plus a token lifecycle
  (single use, expiry, storage, revocation on use) that is a classic source of bugs.
- **It would also be an enumeration oracle.** Everything in this layer is built so that an
  outsider cannot tell which addresses exist — same 401 body for every failure, decoy scrypt
  work on the unknown-address path. A reset form answering "check your inbox" for a real address
  and anything else for an unknown one throws that away, and answering identically for both
  means a real user cannot tell a typo from a mail delay.

So the two routes above **are** the recovery story, and they need one human to vouch for
another, which is the right shape for a group that already knows each other.

**`PATCH /api/admin/users/:id/email`** — validates the shape with `shared/src/email.ts`, trims
and lowercases, and relies on the existing `COLLATE NOCASE UNIQUE` for uniqueness. A collision
is a **409**, caught from the index rather than escaping as a 500; a malformed address is a 400;
an unknown id is a 404. Changing the login identifier is a credential change, so it **revokes
that account's sessions** — except the caller's own, so that an admin fixing a typo in their own
address does not sign themselves out mid-task. That exception cannot spare anything it should
not: when the target is somebody else, the caller's session row has a different `user_id` and is
not in the set being deleted at all.

**`POST /api/admin/users/:id/temp-password`** — the body is ignored. The server generates the
password from `randomBytes`: 20 characters over a 57-symbol alphabet (~117 bits) with `l`, `1`,
`O`, `0` and `I` removed, because this gets read down a phone or copied by hand and a glyph
nobody can name is a support call. Sampling is by rejection rather than `byte % 57`, so the
distribution is exactly uniform. An admin-chosen password is not accepted either — it would be
human-memorable by construction, and a client-supplied one would turn this route into "set a
known password on any account".

The plaintext is **returned in that one response body and nowhere else**. There is no email, so
the body is the entire channel. It is never logged, never stored unhashed, never put in a URL,
and the UI shows it once with a copy button and says so. Lose it and the only remedy is issuing
another one. Issuing to yourself is supported and works.

The route also revokes the target's sessions — otherwise the old password would keep one alive —
sparing the caller's own for the self-issue case, since revoking the session that is *reading*
the one-time password would throw the value away. That spared session is not a way around the
change: it is gated exactly like any other flagged session, as below.

### The forced change is enforced, not cosmetic

`must_change_password` on `users` (migration **v3**) is set by the temp-password route and
cleared **only** by a successful `POST /api/auth/password`. While it is set,
`requirePasswordUpToDate` in `server/src/auth/middleware.ts` refuses every `/api/*` path except
`/api/health`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me` and `/api/auth/password`.
It is mounted **ahead of `requireAdmin`**, so a flagged admin is gated too — the role does not
exempt anyone from replacing a password somebody else picked for them.

The refusal is **403 `passwordChangeRequired`**, not 401. A 401 would trip the client's global
signed-out handler and bounce someone to a login screen they cannot get past, because the only
credential they hold is the temporary one and the change form lives behind the session they
already have.

`GET /api/auth/me` reports the flag, so the client renders the change screen instead of the app
shell. That screen is a courtesy, not the lock: navigating around it, or editing the React
state, yields an app whose every request 403s. The self-service change route still demands the
current password and still enforces the 12-character minimum — the flag is not a free pass to a
weak password, and it clears only on a change that actually succeeded.

### The UI

The app shell is not rendered until `GET /api/auth/me` answers; a 401 renders the login screen
*instead of* the shell, so no panel gets to fire a request and paint its own 401. A **global
401 handler** in `web/src/api.ts` (`setUnauthorizedHandler`, wired up by `web/src/session.ts`)
means a session expiring in an open tab drops you back to the login screen rather than
surfacing as a confusing error inside a data panel. The topbar carries an **account menu** behind a
silhouette (see [The account menu](#the-account-menu)); `#/account` shows your identity (display
name, email, guid — the guid is shown but not editable) and the password-change form, and `#/admin`
is the accounts page, for admins. No credential is kept in `localStorage`: the cookie is the whole
mechanism.

**`#/account` and `#/admin` are two pages on purpose.** They were one, with the user list as a third
card that members did not see — which put an admin's rarest and most consequential controls directly
beneath the form they use to change their own password, and made "the account page" mean two
different things depending on who opened it. A member who types `#/admin` is **refused on the
page**, not bounced home: a redirect leaves them wondering whether the page exists, whether they
mistyped, or whether something broke, and the refusal says which. It is only the screen — every
`/api/admin/*` route is gated by `requireAdmin` on the server, so a member reaching that URL has
been told no, not merely shown less.

**Every password field** in the app — login, change-password, the new-user form, the forced
change screen — is the one `PasswordField` component in `web/src/components/primitives.tsx`, so
the behaviour cannot drift between them. It defaults to `type="password"` and only the toggle
switches it to `text`; the toggle's accessible label names the action *and* the field and
changes with the state (`Show password` / `Hide password`), with `aria-pressed` carrying the
state itself. `autoComplete` is a required prop rather than an optional one, because the wrong
value is worse than none — a browser offering a saved password into a "new password" box is how
people re-set the password they were trying to replace. The revealed value is never persisted:
no `localStorage`, no query string, and nothing autofills the temporary password.

When `mustChangePassword` is set, `web/src/components/ForcedPasswordChange.tsx` replaces the
whole shell. It has exactly two exits — change the password, or sign out — and an admin who
flags an account mid-session pushes that tab onto the same screen, via a global
`passwordChangeRequired` handler in `web/src/api.ts` that mirrors the 401 one. In the admin
panel, a failed email change or temp-password issue is reported **at that row's own controls**,
never as a page-level message, and a failed request never reports success.

### Email is the credential (it used to be a username)

`users.username` is **gone**. In its place:

| Column | |
|---|---|
| `guid` | `crypto.randomUUID()`, unique, not null. A stable external handle: `id` stays the integer other rows FK to, while the guid is the one safe to show or quote, since it leaks neither how many accounts exist nor in what order they were made. Shown on the account page, not editable |
| `display_name` | Not null, free text, 1–64 characters. The human label — topbar, user list, and the attribution on every shared row. **Never a credential** |
| `email` | Unique, `COLLATE NOCASE` so both the constraint and every lookup are case-insensitive. Trimmed and lowercased on the way in. **Nullable — and a null email means that account cannot authenticate at all**, because `WHERE email = ?` matches no NULL for any value. That is enforced by the schema rather than merely documented, and it is asserted in the tests. An admin can correct it with `PATCH /api/admin/users/:id/email`, which revokes that account's sessions |
| `must_change_password` | Migration v3. `NOT NULL DEFAULT 0`. Set by `POST /api/admin/users/:id/temp-password`, cleared only by a successful `POST /api/auth/password`. While it is 1 the API refuses every route but `/api/auth/{me,password,logout}` and `/api/health` |

Validation of an address is deliberately minimal — non-empty, exactly one `@`, non-empty local
and domain parts, no whitespace (`shared/src/email.ts`, shared by the server and the login
form). Full RFC 5322 is not implementable in a regex, and every attempt rejects addresses that
actually deliver; the only real test of an address is sending to it, which this app never does.

### The migration, and the escape hatch

Schema changes are **versioned** with SQLite's `user_version` pragma rather than applied ad
hoc, so a step runs exactly once, in order, and a database already at the head does nothing on
boot. `server/src/db.ts` holds an array indexed by the version it upgrades *from*; each step
runs in its own transaction, with `foreign_keys` off for the duration (SQLite's own advice for
schema changes) because v2 has to drop and re-create `users`.

- **v1** — the original `users` / `sessions` / `chat_messages` tables, written `IF NOT EXISTS`
  because a database created before `user_version` was used already has them and still reports
  version 0. So v1 is a no-op for an old file and a create for a fresh one, and both then take
  the same path. `chat_messages` is **vestigial**: group chat was replaced by the Trade Tracker
  and no code reads or writes that table any more. It is deliberately not dropped — a migration
  that deletes somebody's messages to tidy up a schema is a bad trade, and an unused table costs
  nothing but a line in this list.
- **v2** — rebuilds `users` with the three new columns and creates the two shared tables. A
  rebuild rather than `ALTER TABLE` because SQLite cannot add a `UNIQUE` or `NOT NULL` column
  to a populated table, and all three are wanted; the rows are copied in JS rather than with
  one `INSERT…SELECT` because each needs its own fresh UUID, which SQL alone cannot produce.
- **v3** — `must_change_password INTEGER NOT NULL DEFAULT 0` on `users`, the flag behind an
  admin-issued temporary password. One `ALTER TABLE ADD COLUMN`, where v2 needed a whole
  rebuild: SQLite refuses a `UNIQUE` or bare `NOT NULL` column on a populated table, but
  `NOT NULL DEFAULT 0` is fine, and 0 is what every existing row wants — nobody who already
  knows their own password should meet a change-it-now screen because the schema moved under
  them. Existing rows, their passwords, their sessions and the shared data are all untouched.
  `ADD COLUMN` has no `IF NOT EXISTS`, so a second run would *throw* rather than no-op — which
  is precisely why `user_version` is the thing guarding it, and there is a test that boots the
  same file twice and checks a flag set on the first boot still reads back on the second.
- **v4** — `card_inventory`, the hand-entered card counts. See
  [The card-collecting event](#the-card-collecting-event). A plain `CREATE TABLE`, which would
  also throw on a second run — same guard, same two-boot test.
- **v5** — `card_base_updates`, one row per base recording when its counts were last edited and
  by whom, plus a backfill from the newest `card_inventory` row each base has. Needed because a
  stamp derived from sparse count rows disappears when a base is cleared to zero; see the same
  section. The backfill is inside the versioned step, so a second boot cannot re-run it over a
  stamp that has since moved on — there is a test for exactly that.
- **v6** — `owner_user_id` on `owner_assignments`, so a base belongs to an *account* rather than
  to a name somebody typed, plus a backfill matching the existing `owner` text against
  `display_name` (trimmed, case-insensitively). The text column is **kept**: an unmatched name
  is still the only record of whose base it is, and it now grants nothing. Most rows are
  expected not to resolve, which is not a failure. See
  [Migration v6, and what the backfill did](#migration-v6-and-what-the-backfill-did).
- **v7** — `trades`, the Trade Tracker's one table: a swap two bases have agreed to, which
  either party can then mark complete or declined. `base_a < base_b` with its card, the same
  orientation `suggestTrades` produces, so one agreement is one row however the two sides
  named themselves; `CHECK`s repeat the card-id range and forbid a base trading with itself or
  a card for itself; both user columns are `ON DELETE SET NULL`, because a resolved trade is the
  record of something that really happened and must outlive the account that resolved it. A
  **partial unique index** on the four swap columns `WHERE status = 'pending'` makes a duplicate
  live proposal impossible while leaving history alone. See
  [The Trade Tracker](#the-trade-tracker).

Backfill, per row:

- `guid` — a fresh v4 UUID. Nothing derived from the username, so it carries no information.
- `display_name` — the old username. It was the only human label there was.
- `email` — **the old username if it contains an `@`**, normalised; otherwise **null**.
  Somebody who signed up with their address should not have to re-enter it, and inventing one
  for everybody else would either be wrong or would hand a login credential to whoever guessed
  the pattern. (If two legacy usernames normalise to the same address, the first keeps it and
  the second is left null rather than aborting the migration on the UNIQUE index.)

**The escape hatch.** A row left with a null email cannot sign in — which, for a database whose
only account had a plain username, would mean locking its owner out of their own app. So
`bootstrapAdmin` gained a second job: if `users` is non-empty and the **oldest admin has no
email**, and `ADMIN_EMAIL` is set, it fills that address in **without touching the password**.
Sign in with the new address and the password you already had. It is idempotent — once the
address is set, the query that looks for a candidate returns nothing, so it can neither run
twice nor be used to *move* an address that is already set. `ADMIN_PASSWORD` is ignored on this
path, precisely so it can never reset a password that has since been changed.

If after all that no account has a usable email, the server logs a loud, specific message
naming the stranded account and the variable to set, and leaves the app unusable. It never
invents a credential: a guessable admin on the public internet is worse than an app nobody can
log into.

### Storage

One SQLite file, `DATABASE_PATH` (default `./data/coc.db`, resolved against the server
workspace's working directory, so `npm run dev` puts it at `server/data/coc.db` — gitignored).
The directory is created if missing. Eight tables — `users`, `sessions`, `chat_messages`,
`saved_clans`, `owner_assignments`, `card_inventory`, `card_base_updates`, `trades` — created and
migrated on boot by `user_version`, currently at **v7**. Seven of the eight are live;
`chat_messages` is kept but unused, as above.

`node:sqlite` is used rather than `better-sqlite3` because it is in the runtime from Node 22.5
on: no native module, nothing to compile on the host, nothing to rebuild when Node is
upgraded. The cost is an `ExperimentalWarning` on every start. If that ever becomes a real
problem — noisy logs, or a Node release changing the API — the swap is `better-sqlite3`, whose
synchronous API is the same shape, and only `server/src/db.ts` and the `prepare/run/get/all`
calls in `server/src/auth/store.ts` would change.

### New environment variables

All optional except the bootstrap pair on a fresh database. Full comments in `.env.example`.

| Variable | Default | Does |
|---|---|---|
| `DATABASE_PATH` | `./data/coc.db` | SQLite file for accounts and the shared data; directory created if absent |
| `ADMIN_EMAIL` | — | **Replaces `ADMIN_USERNAME`.** First admin's email when `users` is empty; *and* the escape hatch that fills in a missing email on an existing admin, without touching the password |
| `ADMIN_DISPLAY_NAME` | local part of `ADMIN_EMAIL` | Display name for the first admin, only while creating it. Never overwrites an existing account's name |
| `ADMIN_PASSWORD` | — | First admin's password, minimum 12 characters. Remove after the first boot. Ignored by the escape-hatch path |
| `COOKIE_SECURE` | off | Forces `Secure` on the session cookie when you terminate TLS but do not set `NODE_ENV` |
| `NODE_ENV` | — | `production` implies `COOKIE_SECURE` |

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
  or nobody can sign in — see the escape hatch above.

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
that is no longer how a tile is framed — see [The tiles are framed whole](#the-tiles-are-framed-whole).

`assets:wiki` needs `COC_API_TOKEN` as well, because it asks the CoC API which units exist
before it goes looking for their pictures. It takes about a minute on a cold run (requests are
serialised and paced) and a few seconds when the files are already on disk.

## Layout

```
shared/   types for the CoC API, the auth payloads and the shared data, + tag
          parsing, email normalisation and CARD_SEASON
server/   Hono API, upstream client, TTL cache, auth (src/auth/), the shared
          saved clans and owners (src/shared-data/), the card inventory
          (src/cards/), migrations (src/db.ts)
web/      Vite + React UI
```

Inside `server/src/auth/`: `passwords.ts` (scrypt), `store.ts` (the only code that touches
`users` and `sessions`), `middleware.ts` (cookie → context, plus the exported `requireAuth` /
`requireAdmin` / `requirePasswordUpToDate`), `rate-limit.ts`, `bootstrap.ts` (first admin and the
email escape hatch), `temp-password.ts` (the unambiguous alphabet and the rejection sampling),
and `routes.ts`. `server/src/shared-data/` is the same split for the shared rows: `store.ts` is the
only code touching `saved_clans` and `owner_assignments`, `routes.ts` mounts them. Migrations
live in `server/src/db.ts`.

`server/src/cards/` is the same split again: `store.ts` is the only code touching
`card_inventory`, `routes.ts` mounts `/api/cards/*`, and `cards.test.ts` drives both through the
whole app.

`createApp({ coc, cache, auth, sharedData, cards, trades })` stays dependency-injected, which is
what lets the test suite drive the whole app over an in-memory database and a stub upstream.

`shared` is consumed as TypeScript source through an npm workspace link — no build step,
so a type change is visible on both sides immediately.

Three modules in `web/src/` are machine-written and must not be hand-edited: `coc-assets.ts`
(which league and label ids are vendored), `wiki-art.generated.ts` (which unit names have wiki
art) and `cards.generated.ts` (the sixty event cards). Each has a hand-written half where the
tests point — `wiki-art.ts` for the second, `cards.ts` for the third.

Anything with rules in it is a pure module in `web/src/` with its own tests, never inline in a
component: `saved-table.ts` (sorting, paging), `base-names.ts` (how a base is written),
`card-trades.ts` (the four swap rules), `card-summary.ts` (per-deck counts and "is a trade
waiting"), `deck-progress.ts` (those counts as the four progress plaques),
`card-standings.ts` (the leaderboard's order, and the group's total of each card in the grid's
fixed order), `base-scope.ts` (the card page's Mine/All filter — what "mine" means, which way to
default, and where the selection goes when the filter drops it), `last-route.ts` (what to
restore, and which clan the topbar's Clan button opens).
Components that are shown in more than one place are shared rather than copied — `BaseCardEditor`
is the one 60-tile card grid, rendered by both the card page and a player page; `CardTile` is the
one card tile, rendered by that grid and by the card page's clan-totals grid; `TradeSuggestions` is
the one trade table, clan-wide on the card page and filtered to one base on a player page; and
`DeckPlaques` is the one set of deck bars, rendered by both pages as well. `useBaseLabels()` in
`base-labels.ts` is the one place a base tag becomes a name, for all of them.

## Phones and tablets first

This app is read mostly on a phone, so small screens are the design rather than a fallback.
All of it is hand-written CSS in `web/src/styles.css`; the responsive rules live in one block
at the **end** of that file, because a media query adds no specificity and the Clash chrome
section above re-declares several of the same selectors.

Two breakpoints, both authored as `max-width` so they cascade into each other and cannot leave
a gap in the middle:

| Band | What changes |
| --- | --- |
| **≤ 900px** (tablet and phone) | One column, lookup stacked above the content, footer forced last. **Every wide table becomes one card per row.** Gutters drop to `20px 16px`. |
| **≤ 600px** (phone) | Gutters drop again to `14px 12px`, every `.search` form goes one control per line, form controls go to 16px, the 60-card grid tightens to a 96px column floor, the four deck plaques go 2×2, and the hero and war blocks left-align. |
| **> 900px** (desktop) | Unchanged. |

600px is the line where a two-up control row stops fitting: phones in use run 320–430px and a
portrait tablet is 768px, so it falls in the empty space between the two. 900px was already the
point at which the layout gives up its second column.

Tables stack at **900px, not 600px**, and that is a measured decision — at 768px, a tablet in
portrait, four of the eight tables still wanted a sideways scroll, and the users table wanted
1124px against 694px of available content width.

**Tap targets** key off `@media (max-width: 900px), (pointer: coarse)` rather than width alone,
because a landscape tablet is 1024px wide and still driven by a thumb. Inside that block every
button, input, select and pill clears 44px. Checkboxes are the exception — `min-height` would
outrank their explicit `height` and stretch the box — so a roster checkbox is wrapped in a
`.select-hit` label, 24px on a desktop and 44px on a touch screen.

The 16px floor on phone form controls is not cosmetic: iOS Safari zooms the whole page whenever
a focused control is smaller than that.

### A new table has to take the stacked treatment

Otherwise it will scroll sideways on a phone. The recipe:

1. Put `roster--stack` on the table.
2. Give every cell a `data-label`; that is what the stacked card prints in place of the column
   head. The row's identity cell takes `class="stack-title"` and **no** label, so it reads as
   the card's heading instead — and if it holds a link, that link gets a 44px box. For the two
   sortable tables the label comes from `rosterColumnLabel()` / `clanColumnLabel()` in
   `saved-table.ts`, so a stacked label cannot drift from the column header it stands in for.
3. Add the ARIA. Changing `display` on a table strips its semantics from the accessibility tree
   in Chrome and Safari alike, so every element carries the role it would otherwise have had:
   `role="table"` / `rowgroup` / `row` / `columnheader` / `rowheader` / `cell`. The header row
   is hidden with the `.visually-hidden` recipe, never `display: none`, so a screen reader still
   reads real column headers — and its `aria-sort` — against real cells.
4. **If the table sorts, it needs a `SortControl`.** Stacked, there are no visible column heads
   to hang seven sort buttons off. Reflowing them into a strip above the cards was tried and
   read as a run of unexplained gold words, so instead `useStackedTables()` decides and the
   table renders *different DOM*: plain text in the `th`s plus one "Sort by" select and a
   direction button. Rendering both and hiding one in CSS would leave the hidden set in the
   accessibility tree as invisible duplicate tab stops. A column whose heading is an
   abbreviation (`#`, `TH`) needs a `long` label in its `TableColumn`, because the Sort menu has
   no column of numbers underneath to explain it.

A cell the row had nothing to put in is dropped (`td:empty`), so a blank line never appears.
The label is a **float**, not a flex or grid column, because a cell's value is arbitrary inline
content — a link, then text, then a pill — and any of those would be torn into separate flex
items by a flex or grid container.

The one table that does not stack is the account identity table. It is two columns at every
width, so it wears `roster--pairs`, which only lets its cells wrap — a 36-character guid does
not fit a 320px screen on one line.

## API

The server exposes a thin, cached layer over the upstream API. Tags may be passed with or
without the leading `#` (URL-encode it as `%23` if you include it).

**Every route below requires a session** — see [Authentication](#authentication). The one
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

## The topbar

A gold plate carrying the title, the Clan and Cards links, and the account menu. It wraps at
390px rather than scrolling sideways, so everything on it stays reachable on a phone (measured:
two rows, no horizontal overflow).

### The compass rosette

Left of the words **Clash of Clans Explorer** is a compass rosette: a ring around two four-point
stars, long and solid on the cardinals, shorter and at 45% opacity on the diagonals.

It is **inline SVG written by hand** in `web/src/App.tsx` — no dependency, no external file, no
icon font. Everything else drawn in this app is either game art from the API and the wiki or it
is CSS, and one 24-pixel glyph is not a reason to add a package. Both stars paint in
`currentColor`, so the mark takes whatever ink the plate uses (`--on-gold`, which differs between
the themes) and needs no colour of its own; `opacity` rather than a second colour is what
separates the two stars, for the same reason.

**It is inside the title's existing link, not beside it.** Two adjacent links to the same place
would be two tab stops reading as two destinations, and naming the icon "Home" would invent a
second one. So the icon takes `aria-hidden="true"` and the single link keeps the accessible name
**"Clash of Clans Explorer"** — verified from the computed accessibility tree, not from the
markup: `link` / `Clash of Clans Explorer`, with the `<svg>` itself `ignored` and `role: none`.
It navigates to the homepage, which is the saved-clans list.

### The Clan button

Labelled **Clan**, and it goes to **the last clan this account opened** — not to the saved-clans
list. Coming back to a clan is the common move, and it used to cost a trip through the list.

The tag is persisted per account under `coc:lastClan:<id>`, exactly as `coc:lastRoute:<id>`
already is, because a browser can be shared and handing one person another person's clan would be
worse than having no shortcut at all. It is written by `useLastClan` in `web/src/hooks.ts` on
every hash change, canonicalised on the way in, and only `#/clan/<tag>` counts — a war page is
*about* a clan but is not the clan.

**Before any clan has been opened it goes to the saved-clans list**, which is where you pick one.
That is the one thing it must never be: a dead control, or a link to nowhere. Its tooltip says
which of the two it is doing (`Back to #G88CYQP, the last clan you opened` /
`No clan opened yet — this opens the saved clans`). The decision is `clanTargetTag()` in
`web/src/last-route.ts`, pure and tested including the junk-in-storage case.

Like the Cards link, it is **absent where it would point at the page you are on** — on any clan
page (the last clan is the one you are looking at) and, with no clan yet, on the list itself. The
saved-clans list stays one click away on the title.

### The account menu

One silhouette button on the right, holding everything about *you*: the appearance switch, a link
to your password page, the **admin panel** if you are an admin, and **Sign out**.

It replaced three separate topbar controls — a theme cycler labelled with the current theme, the
display name as a link, and a Sign out button. At 390px those competed with Clan and Cards for a
bar barely wide enough for the title, and "my settings" is a thing people look for behind their own
avatar rather than spread across a toolbar.

**The button's accessible name is the display name and role** — `verify (admin) — account menu` —
because a silhouette says nothing about *who* is signed in, and on a shared browser that is the one
thing worth being able to check. The panel repeats it in words, with the email, for a sighted user
who cannot hear the label.

**The admin entry is absent for a member, not disabled.** A greyed-out "Admin panel" tells somebody
their account is lacking; an absent one says the feature is not theirs. `userMenuItems()` in
`web/src/user-menu.ts` decides it, pure and tested, and **Sign out is last** so it is never between
two navigation items where it can be pressed by accident.

**Appearance stays a cycler, not three radio items.** It is the only item pressed repeatedly, it has
to visit all three states, and as a cycler it can be pressed without the menu closing underneath it
— so the effect is visible while the control is still under the cursor. Every other item navigates
or signs out, and those close the menu. Read back in a browser: four presses gave
`◐ System → ☀ Light → ☾ Dark → ◐ System` with the panel still open, and `data-theme` following on
the root element.

`system` is **in** the cycle and is the default. Without it, anybody whose OS switches at dusk could
not get back to following it without clearing storage. An unrecognised stored value — an older
build's, or one somebody edited — lands on `system`, the one answer that is never wrong.

Hand-rolled ARIA, because there is no menu library here and one glyph is not worth a dependency:
`aria-haspopup="menu"` and `aria-expanded` on the button, `role="menu"` / `role="menuitem"` on the
panel and its items, **Escape closes it and returns focus to the button** (closing without moving
focus leaves a keyboard user at a control that no longer exists), and an outside press closes it —
bound on `pointerdown` rather than `click`, so a press that starts outside cannot land on an item
that has moved. All four verified in a browser, including `aria-controls` matching the panel's id.

The silhouette itself is inline SVG in `web/src/components/UserMenu.tsx`, a circle and a clipped
half-capsule in `currentColor`, for the same reason the rosette is.

## Looking a player or clan up

The two lookup forms sit **on the homepage, beneath the saved clans**, side by side in one row
that becomes one column on a phone. The layout is a **single column at every width**.

They used to live in a sticky 260px right-hand sidebar spanning every route. That was right when
they were the only thing on screen and wrong everywhere else: on a clan, player or card page they
were a permanent column of chrome beside the thing you had already found. The **Recent** chips came
with them, because they live *inside* the two lookup cards — each list under the box that produced
it — and because "where have I been" is the same question as "where do I go", asked on the same
page. The title navigates home from anywhere, so both are one click away from every route.

With the chat panel gone too (replaced by the Trade Tracker on the card pages) the sidebar had
nothing left to hold, and a second grid track would have been a dead gutter. Each card still stacks
its controls one per line, as it did at 260px: two narrow forms read better than two sprawling
ones, and it means the phone layout is the same shape as the desktop one rather than a second
arrangement to keep working.

There are two forms rather than one form with a mode select:

- **Find player** takes a player tag and opens `#/player/<tag>`.
- **Find clan** takes either a clan tag *or* a clan name. If the input parses as a tag it
  opens `#/clan/<tag>`; otherwise it is treated as a name and searched via
  `#/search/<name>`, which needs at least 3 characters to match the server's minimum.

Tag and name are genuinely ambiguous — `Reddit` is six alphanumeric characters, so it is a
structurally valid tag — so the clan form previews which branch will run ("Opens clan
#REDD1T" vs "Searches clan names for …") before you submit.

Both forms block submission only on **structural** invalidity. The canonical-alphabet check
is advisory: it prints a warning and performs the lookup anyway, because the API returns the
same flat 404 for a malformed tag as for an unknown one and is the only authority.

**Recent** chips sit below the two forms.

## Saved clans

The landing page carries one list: saved clans — tag, a display name you control, level,
members, points, and war league. Add a tag and the app fetches the clan to validate it and
prefill the in-game name. Clicking a row opens the clan and **War** opens its current war;
**Edit** renames (which marks the row `custom` so **Refresh all** stops overwriting the
label), and **Remove** deletes after a confirm. Any clan page also has a **★ Saved / ☆ Save**
toggle. The list is **shared** — everyone signed in sees and edits the same one, so removing a
clan removes it for everybody, which the confirm now says.

## The shared data model

Saved clans and owner assignments used to be `localStorage`, under `coc:savedClans` and
`coc:owners`. They are now rows on the server, and — the important part —
**shared across every account, not per user**.

That is the whole point of the exercise. Ten people looking at the same clan need *one*
canonical answer to "who owns this base"; per-user copies give ten answers and no way to
reconcile them, and the same person sees a different list on their phone. So there is one row
per clan tag and one per player tag for the install, and **every signed-in caller reads all of
them**. Reading is not filtered per user, and shared visibility is not what changed when
ownership became a permission — see
[Who may assign an owner, and who may write a base](#who-may-assign-an-owner-and-who-may-write-a-base).

```
saved_clans        clan_tag PK, name, custom, clan_level, members, clan_points,
                   war_league, updated_at, updated_by_user_id → users(id)
owner_assignments  player_tag PK, owner, owner_user_id → users(id) ON DELETE SET NULL,
                   updated_at, updated_by_user_id → users(id)
```

- **A base belongs to an account: `owner_user_id`** (migration **v6**). That is what makes "only
  the owner may edit this base's card counts" a question the server can answer at all — free
  text cannot be compared to a session, a user id can.
- **The `owner` text column stays beside it, and is not going away.** It is the label for a row
  that has never been matched to an account, which is most of them: these assignments predate
  accounts and name clan members who mostly have none. An unmatched name is still the only
  record of whose base it is in real life, so it is kept and shown — but it grants **nothing**.
  When a row does resolve, the stored text tracks that account's display name and the label the
  API returns comes from `users`, joined on read, so a rename cannot leave the two disagreeing.
- **`updated_by_user_id` is nullable, `ON DELETE SET NULL`.** The data outlives the account
  that entered it. Losing an attribution is acceptable; losing the assignment because somebody
  left the clan is not. **Disabling an account touches no row here at all** — disable is a
  timestamp on `users`, not a delete — and that is covered by a test.
- **Attribution is joined on read**, not copied onto the row, so renaming somebody does not
  leave old edits credited to a stale name. Every record carries `updatedAt` and `updatedBy`
  so the UI can say who last touched it.

All routes are authenticated; `/api/*` is deny-by-default, so they were protected before they
were written, and a test asserts each one 401s anonymously.

| Route | |
|---|---|
| `GET /api/saved/clans` | the shared list |
| `POST /api/saved/clans` | insert or refresh; an existing `custom` label survives |
| `PATCH /api/saved/clans/:tag` | rename, which marks the row `custom` |
| `DELETE /api/saved/clans/:tag` | remove, for everyone |
| `GET /api/owners` | every assignment, with `ownerUserId` — **everyone** |
| `PUT /api/owners/:tag` | assign one base to one account, `{ "userId": n }` — **admin only** |
| `DELETE /api/owners/:tag` | remove one — **admin only** |
| `POST /api/owners/bulk` | the conditional bulk apply, below — **admin only** |
| `POST /api/import` | the one-time browser hand-off, below; its owner half is admin only |

### Who may assign an owner, and who may write a base

Three rules, and they are the whole authorisation model:

1. **Everyone signed in reads everything.** Every base, every owner, every card count. That was
   the reason this data moved to the server and it has not changed.
2. **Only an admin writes the owner column** — the single set, the bulk apply, and the clear.
   Ownership decides who may edit a base's card counts, so a member who could reassign a base
   could grant themselves that write, which would make it not a permission at all. A member
   attempting one gets a 403 saying *an admin assigns ownership of a base*, not a bare denial.
3. **Only the owning account writes that base's card counts** —
   `PUT /api/cards/inventory/:tag`. A non-owner gets a 403 that **names the owner**
   ("`#2GCJ2QPU` belongs to Jared…"), because being told who to ask is the difference between a
   usable message and a wall.

Two decisions inside rule 3, both deliberate:

- **An admin may also write any base's counts.** An admin can reassign ownership to themselves
  in one request, so refusing them the direct write would stop nothing and would remove their
  only way to fix somebody else's mistake.
- **A base nobody's account owns is writable by admins only.** Nobody else has a claim to it.
  That covers a base with no assignment *and* a base whose assignment is an unresolved text
  label — the label is a note about a person, not a grant to a session. On this install that is
  22 of the 39 live assignments, so a member who finds a base refused should expect the fix to
  be an admin assigning it rather than anything they can do themselves.

The rule is **one pure function**, `mayWriteBaseCounts` in `server/src/cards/write-access.ts`,
with its own tests in `write-access.test.ts` — no database, no session, no HTTP. It is one
function rather than a check in each handler because spread out it would drift: one place would
forget the admin case, another would treat an unowned base as fair game, and nobody could state
the rule without reading three files. The route consults it *before* parsing the body, so a
refusal never depends on whether the payload happened to be well formed.

The owner routes are gated by middleware rather than by a check inside each handler, so a route
added later cannot become a hole by omission — the same reasoning as `/api/*` being
deny-by-default. `requireAdminFor(message)` in `server/src/auth/middleware.ts` takes the message
so each area can say what an admin actually does there.

### Migration v6, and what the backfill did

v6 adds `owner_user_id` and backfills it by matching the existing `owner` text against
`users.display_name`, **trimmed and case-insensitively** — that text was only ever meant for
human eyes, and `jared`, `Jared ` and `Jared` were the same person to whoever typed it. Notes:

- **Most rows do not resolve, and that is not a failure.** On this install the backfill linked
  **17 of 39** assignments and left **22** as text labels (`lisa_sweatt` ×9, `william` ×13 —
  neither matches an account's display name; note `lisa_sweatt` is *not* `lisa sweatt`). Nothing
  is deleted, nothing fails, and an unresolved row simply owns nothing until an admin reassigns
  it with `PUT /api/owners/:tag`.
- **The server says the split out loud at boot**, e.g.
  `→ owner assignments: 17 of 39 linked to an account, 22 still a text label (admin-writable only)`.
  It is read from the table on every boot rather than reported by the migration, so it stays true
  after an admin has reassigned a few.
- **It runs exactly once**, like every other step, because `PRAGMA user_version` is the marker.
  That matters more here than elsewhere: a backfill that ran again would read the stale text on a
  row an admin has since pointed somewhere else and silently put the old owner back. There is a
  test for precisely that.
- `LOWER` in SQLite is ASCII-only, so a display name needing Unicode case folding stays
  unresolved rather than resolving wrongly. Two accounts answering to one name resolve to the
  lowest id — arbitrary, but deterministic.
- Typing a name into the **bulk bar** goes through the same matching rule, so an admin typing a
  teammate's display name links the account rather than creating another label.

### Optimistic concurrency on the bulk owner apply

Shared data means two people can race on one row. `POST /api/owners/bulk` therefore takes, on
**every** row, the owner value the client *believed* was current — `""` meaning "I believe
nobody owns this". The server writes a row only if the stored value still matches, and returns
any mismatch as a conflict carrying the **real** current value, its timestamp and who set it.
Rows that did match are still applied: one stale row must not block the other nine.

`expectedOwner` is **required**, not defaulted. A missing one would read as `""`, which is
precisely the silent clobber the endpoint exists to prevent, so the request is refused with a
400 instead.

This maps onto the approval dialog that already existed in `ClanView`. `planOwnerChange` still
does the client-side partitioning — it is reused, not duplicated — and a row the *server*
rejects is appended to the very same list, now showing the real current value, for re-approval
against the truth. Approving is itself conditional on the value that was approved, so a row
that changes again while somebody is deciding comes back a second time rather than being
overwritten. Single-owner edits go through the same check, using whatever that tab believes.

### The one-time import of browser data

On the first sign-in after this change, whatever the browser still holds under `coc:owners`,
`coc:savedClans` (and the older `coc:saved`) is POSTed once to `/api/import`, and a
`coc:importedToServer` flag stops it happening again.

**It fills gaps only. It never overwrites a value already on the server.** With shared data and
several people importing their own copy, an overwriting import would mean whoever signed in
last silently won every disagreement. The insert is `ON CONFLICT DO NOTHING`, which also makes
the endpoint idempotent regardless of what the client does — the flag only saves a round trip,
the server is the real guard. The response counts what was applied against what was skipped,
and the UI shows that as a short, dismissible summary: quietly moving somebody's data without
saying what became of it is not on, least of all when some of it was skipped.

The `localStorage` keys are **read and never cleared**, so if the import turns out to have been
wrong the original data is still sitting there.

**The upload itself is not admin-only, but its owner half is.** A member's saved clans are
theirs to bring across and grant nobody anything; their owner rows would be a way straight
around the admin gate on `/api/owners`, so for a non-admin they are refused unexamined and
reported as `owners.refused` rather than silently dropped. The clans in the same request are
still applied.

### The client stores

`web/src/owners.ts` and `web/src/saved-clans.ts` keep the shape they had — `useOwners()`,
`useSavedClans()`, `setOwner`, `saveClan`, … — so the components barely changed. Both are built
on `web/src/server-store.ts`, one module-level external store over `useSyncExternalStore`, the
same mechanism as before, so the Save toggle on a clan page and the list on the landing page
still agree instantly.

What changed is that the snapshot is now a *cache of something another person can alter*, so
`status` and `error` are part of it: reads have a real loading state, and **a failed write is
made visible rather than dropped**. `mutate` records the error *and* rethrows, so the button
that was pressed can say the write did not happen — the UI never claims a change succeeded
when the request failed. Signing out empties both caches.

### Row counts and paging

The table has a **Rows** select, defaulting to 5 (5 / 10 / 20 / 50 / All). The choice persists
in `localStorage`, so it survives a reload.

A limit never silently hides rows. Whenever the list is longer than the limit, a footer says
`Showing 1–5 of 63` with **Previous** / **Next**. The page resets to 1 when the limit or the
sort changes, and is clamped if rows are removed underneath it, so the view can never land on
an empty page past the end.

The slicing is a pure function, `paginate(rows, limit, page)` in `web/src/saved-table.ts`,
returning `{ rows, page, pageCount, from, to, total }` where `'all'` (or `null`) means no
paging. The returned `page` is authoritative — that is where clamping happens, so a stale
page number in a component cannot produce a blank table.

Four lists share that machinery — `paginate()` and `parseRowLimit()` for the logic,
`RowLimitSelect` and `Pager` for the controls, `useRowLimit()` for the persistence. Their defaults
differ because the lists do:

| List | Default | Options | Stored at |
|---|---|---|---|
| Saved clans | 5 | 5 / 10 / 20 / 50 / All | `coc:savedClans:limit` |
| Clan roster | 10 | 5 / 10 / 20 / 50 | `coc:rosterLimit` |
| Trade suggestions | 5 | 5 / 10 / 20 / All | `coc:tradePairLimit` |
| Collection leaderboard | 5 | 5 / 10 / 20 / 50 | `coc:cardStandingLimit` |

The trade suggestions' select is labelled **Pairs**, not **Rows**, because that list pages by pair —
see [Row counts on the trade suggestions](#row-counts-on-the-trade-suggestions).

## Owners live on the clan page

There used to be a second landing-page table of saved *bases*: a curated list of player tags
with a display name, Town Hall, trophies, clan, and an **owner**. The clan page already shows
all of that for every member, so the table was redundant and is gone. The one thing worth
keeping is the owner, because it is the only field the API cannot supply.

Owner is keyed by player tag, stored on the server and **readable by everyone** (see
[The shared data model](#the-shared-data-model)), through `web/src/owners.ts`. The clan roster
joins it in as a sortable **Owner** column, so the place you assign an owner is the place you
can already see the Town Hall, trophies and rank you are deciding from.

It is no longer a bare annotation: an owner is an **account**, and **only an admin can set one**
(see [Who may assign an owner, and who may write a base](#who-may-assign-an-owner-and-who-may-write-a-base)).
The server enforces that on every owner-writing route. **The web UI has not caught up yet**: the
Owner column and the bulk bar still type a free-text name, which the server matches to an
account by display name where it can, and a member pressing them gets a 403 rather than a
disabled control. The outstanding UI work is the Owner cell becoming a picker over accounts,
the bulk bar being hidden from non-admins, and card entry being disabled for a base you do not
own.

Removing the bases table also removed the **Save** button from player profiles. Player pages
themselves stay, and the homepage still looks players up.

### Migrating `coc:saved` → `coc:owners` → the server

`migrateLegacySaved` parses the old `coc:saved` payload and carries over every entry with a
non-empty owner, discarding the name, stats and clan along with any entry that had no owner at
all. It now feeds the one-time import rather than a second `localStorage` key. **Neither key is
deleted** — both stay put, so nothing is destroyed by a migration that turns out to be wrong.

The migration is a pure exported function, `migrateLegacySaved(rawJson)`, precisely so it can
be tested against what a browser might really be holding: malformed JSON, a non-array, a
non-object entry, a missing or unparseable `tag`, a missing or blank `owner`, duplicate tags.
`web/src/owners.test.ts` covers all of those.

### Bulk owner assignment

Tick members and a bulk bar appears; the header checkbox goes indeterminate on a partial
selection. The game caps a clan at 50 members, so this table is never paged and the header
checkbox safely means the **whole roster** — every row it ticks is on screen, which is what
made a page-scoped select-all necessary in the old bases table.

Type an owner, press **Apply to selected**, and:

- members with **no owner** are written straight away — conditionally, asserting that belief,
  so the write still fails safely if somebody else got there first;
- members that **already have a different owner** are held back for approval, listed one per
  line with the old and new value, each unticked by default — nothing is overwritten until
  you tick it and press **Apply N approved**;
- members that already match are counted as unchanged and left alone;
- members the **server** refuses, because the value changed underneath this tab, join that
  same approval list showing the real current value. See
  [Optimistic concurrency](#optimistic-concurrency-on-the-bulk-owner-apply).

Clearing an owner (empty box) takes the same approval path, since it destroys information
just as much as replacing it. The owner input is backed by a `datalist` of owners already in
use, so repeat entries are one keystroke.

Every column of both tables sorts, and blank or unknown values stay at the bottom in **both**
directions — reversing a column should not bring a wall of dashes to the top. The two
comparators that do that are exported from `web/src/saved-table.ts` so each table shares the
one behaviour rather than reimplementing it.

Comparators, ordering, paging, and the approval partitioning all live in
`web/src/saved-table.ts`, apart from the components, and are covered by `npm test`.
`planOwnerChange` takes the minimal `{ tag, name, owner? }` shape, which is why a live clan
member satisfies it directly.

## The card-collecting event

Each base collects cards during August. `#/cards` is the page: a grid of all 60 cards per base,
manual entry of the counts, and the trades those counts make possible.

**There is no API for any of this.** Supercell exposes nothing about the event, so every number
is typed in by hand. That single fact shapes the rest of the design — there is nothing to
refresh from, so what is stored is whatever a person last entered, and the only defence against
a wrong number is that everyone can see it and see who entered it.

### The card list is generated and committed

`web/public/coc/cards/manifest.json` is the source of truth for which sixty cards exist —
**not** the spreadsheet at the repo root, which is the author's working notes. The manifest also
carries `collected` and `confidence`; both are notes about how each *picture* was sourced and
have nothing to do with inventory, so neither is carried across.

`npm run cards:generate` (`scripts/generate-cards.mjs`) reads it and writes
`web/src/cards.generated.ts` — id, category, name, image path — the same way
`scripts/fetch-wiki-art.mjs` writes `wiki-art.generated.ts`. It validates before it writes:
contiguous ids from 1, a known category on every card, a name and an image path. A structural
problem aborts and leaves the committed module alone, because a duplicate id or a bad category
would otherwise surface as a wrong picture weeks later.

**The generated module is tracked; the art it points at is not.** `web/public/coc/` is
gitignored, so a fresh clone has the sixty cards' ids, names and categories but none of their
pictures — and the manifest is inside that directory too, so a fresh clone cannot even re-run
the generator. That is exactly why the module is committed rather than generated at build time.

A missing picture is the **normal** case, not an error. The art is a hand-placed set under
`web/public/coc/cards/` and no committed script fetches it; without it, `GameIcon` removes the
`<img>` on error and the tile is an empty, correctly sized art box over its count — the tiles carry
no name of their own, so on such a checkout the number box's accessible name and the tile's `title`
are the only things that still say which card is which.
`.card-tile__frame` reserves the height rather than shrinking to its content, so the grid
neither collapses nor reflows. Never a broken-image glyph.

The **id** is the identity and the **name** is what the user reads; an image path is neither.
That was concrete under the old wiki art, where "Baby Dragon" and "Baby Dragon (Builder)" were one
file and two tiles were the same picture. The current set draws **all sixty separately** — card 11
is `elixir_11_baby_dragon.png`, card 38 is `builder_base_38_baby_dragon_builder.png`, and no two
cards share a file. `card-crops.test.ts` pins that: it groups all sixty by image path and asserts
no path is reused, naming the offenders if one ever is. Keying on the id anyway is what makes the
grid survive a set that *does* reuse a file.

### The tiles are framed whole

Every tile shows the **whole** of its picture. `.card-tile__frame` is `aspect-ratio: 4 / 5`
because the art is 4:5 — 256×320, all sixty — so `object-fit: contain` at the matching ratio
neither trims an edge nor leaves a letterbox bar. Read back off the DOM at 390, 600 and 1280px,
light and dark: all 120 frames on the card page have an `<img>` box **exactly** equal to the frame
box, offset 0,0. At 1280px that is a 107×134 frame showing a 256×320 file, so the art downscales —
sharper than any crop of it could be.

This replaced a per-card **crop table**. The art used to be whole figures standing on a patch of
grass, and `card-crops.ts` held three numbers per card (`x`, `y`, `zoom`) that CSS used to slide a
window over the head. The new art is already framed on its subject, so cropping it would zoom into
a face that already fills the frame. The frame was 3:4 while its shape was a free choice.

**The crop machinery is kept, not deleted.** The art may be regenerated unframed, and re-cropping
should stay a table of numbers rather than a rewrite:

- `cardFraming(id)` returns `WHOLE_FRAMING` unless the id appears in `FACE_CROPS`, which is
  **empty**. Whole is the default; a face crop is the exception, and `CardTile` sets
  `data-crop="face"` plus the three custom properties only for one.
- `faceCrop(x, y, zoom)` is exported and carries the clamp that keeps a window inside its picture.
  It is tested **directly**, because an empty table would make the old per-entry assertions pass
  vacuously — a crop at zoom 2 clamps to 25–75%, at zoom 4 to 12.5–87.5%, and at zoom 1 collapses
  to dead centre.
- the per-entry guard rails (ids must name real cards, windows must stay inside the picture, zoom
  in 1–3) are still there and still run, so the table cannot be refilled wrongly unnoticed.

**Roughly half the files carry transparency** (31 of 60 have fully transparent pixels; 29 are
opaque edge to edge — measured by decoding the PNGs properly, filters reconstructed, not by reading
raw scanlines). Where a background is transparent the tile's own `--surface` shows through:
parchment in light mode, dark wood in dark. Looked at on both themes and all four deck frames, that
reads as a cut-out figure on the card and matches the game's own treatment, so **no backing colour
is painted** — one would only re-introduce a box edge the art was cut out to avoid.

### The data model, and why inventory is shared

Cards are collected **per player**, so counts are keyed by base — one set of sixty per player
tag — and migrations **v4** and **v5** add two tables. Both are shared across every account for
exactly the reason `owner_assignments` is: how many Barbarian cards a base holds is a *fact
about the base*, not a private opinion, and trade suggestions only mean anything if everybody is
reading the same numbers. Ten private copies would produce ten disagreeing sets of suggestions.

```
card_inventory     (season, player_tag, card_id) PK, count,
                   updated_at, updated_by_user_id → users(id) ON DELETE SET NULL
                   CHECK (card_id BETWEEN 1 AND 60), CHECK (count BETWEEN 0 AND 10)

card_base_updates  (season, player_tag) PK, updated_at,
                   updated_by_user_id → users(id) ON DELETE SET NULL
```

- **Rows are sparse: absent means zero.** A base holding nine cards has nine rows, not sixty. A
  count of 0 deletes the row rather than storing a zero, so "does not hold it" has exactly one
  representation.
- **Both CHECKs restate what the route already validates**, on purpose. The route can be
  bypassed by a future caller; the database cannot. There are tests that insert past the route
  and assert the schema refuses. `count` still permits 0 because 0 is legal on the wire, even
  though no row ever stores one.
- **`updated_by_user_id` is nullable, `ON DELETE SET NULL`** — the counts outlive the account
  that typed them, and **disabling an account touches no row here**, which is covered by a test.
  Attribution is joined on read, so a rename never leaves old edits credited to a stale name.
- **The edit time is always captured, in its own table.** `card_base_updates` holds one row per
  base saying when its counts were last saved and by whom, written on **every** save inside the
  same transaction as the counts. It started out derived from `MAX(updated_at)` over the count
  rows, and that was wrong: because storage is sparse, a base cleared back to zero has no count
  rows left, so the derived stamp vanished for precisely the base most likely to prompt "when
  did we last check this one?". Saving a base with *nothing* on it is a real check and is
  recorded as one. v5 backfills each base from its newest surviving count row, so an install
  already at v4 keeps the attribution it had. One row per base, not per card — a base is saved
  whole, so a per-card stamp would be sixty copies of one fact.
- **An emptied base stays listed**, reporting zero cards and its stamp, rather than disappearing.

### The season constant

Every row is scoped to a season string, and there is exactly one:
`CARD_SEASON` in `shared/src/card-types.ts`, currently `'2026-08'`.

**One line to change next August.** Without it, next year's counts would merge silently into
this year's and the suggestions would be drawn from a mix of two events. There is deliberately
**no season-switching UI** — the constant is the switch, and the routes never take a season from
the request, so a client cannot write into a season nobody is looking at.

### Routes

All authenticated; `/api/*` is deny-by-default, so they were protected before they were written,
and a test asserts each one 401s anonymously. **Reading is open to every member; writing a base
belongs to that base's owner** (and to admins) — see
[Who may assign an owner, and who may write a base](#who-may-assign-an-owner-and-who-may-write-a-base).

| Route | |
|---|---|
| `GET /api/cards/inventory` | every base with cards recorded, each with `updatedAt` and the display name in `updatedBy` — **everyone** |
| `GET /api/cards/inventory/:tag` | one base; a base nobody has entered answers `{ counts: [] }`, not a 404 — **everyone** |
| `PUT /api/cards/inventory/:tag` | replaces that base's whole season in one request — **the owning account, or an admin** |

A caller who does not own the base gets a **403 naming the owner**, and an unowned base is
writable by admins alone. The decision is `mayWriteBaseCounts` in
`server/src/cards/write-access.ts`, checked before the body is parsed.

The write is **one request per base, never sixty per card** — the entry screen edits a base at a
time, and sixty requests to save one screen would be sixty chances to half-apply. Every id must
be 1–60 and every count 0–10; **one bad entry rejects the whole request** with a 400 and writes
nothing, because a partially applied save would leave a base holding a mixture of what was typed
and what was there before, with nothing on screen saying which took. A repeated `cardId` is
refused too, rather than letting the last one quietly win.

**Concurrency is last-write-wins per base**, deliberately unlike the owner flow's
expected-value handshake. A card count is a number somebody read off a screen a moment ago, not
a decision another person made, so the cost of a clobber is re-typing one base — where the cost
of clobbering an owner is losing somebody's decision. What makes that acceptable is that
`updated_at` and `updated_by` are recorded and shown on every base, so a surprise is at least
explainable: you can see the count changed, when, and who changed it.

### The trade rules

`web/src/card-trades.ts`, pure and with no knowledge of React, the server, or the generated card
list — categories arrive through a resolver, which is what lets the tests run the rules against
three made-up cards instead of sixty real ones. `web/src/card-trades.test.ts` covers it.

A trade pairs base A giving card X to base B, and B giving card Y to A, where **all** of:

1. **A holds 2 or more of X, and B holds 2 or more of Y.** A base never trades away its last
   copy, so a count of exactly 1 is *not* tradeable. This is the rule people get wrong by hand.
2. **B holds zero of X, and A holds zero of Y.** You may only receive a card you do not already
   own — a second copy of something you hold once is worth nothing to you.
3. **X and Y are in the same category.** The game only swaps within a deck.
4. **A and B are different bases**, including when one tag appears twice in the input.

Rules 1 and 2 together make `X === Y` unreachable without a special case, and there is a test
that says so rather than only a comment.

**Mirrors are reported once.** A↔B and B↔A are one trade seen from two sides, so each unordered
pair is considered once and the result is always oriented with the lexicographically smaller tag
as `baseA` — which makes the output independent of the order the bases were passed in, and that
is asserted directly. Output is sorted by base then card, so it never shuffles between renders.

One pair can yield several suggestions and one spare can appear against several partners. That
is intended: these are options to choose between, not a plan.

### The UI

`#/cards`, titled **Clash of Cards** — the event's own name in the game, and the same heading the
card panel on a player page carries, so the two pages no longer word it differently. `CARD_SEASON`
is not shown in either title; it still scopes every stored row and is still returned by every
route, it is simply not chrome.

The page **narrows as it goes down**. The picker and the grid are the one base you can act on;
the three panels under them are the whole clan and are deliberately *not* filtered by the picker:

1. the base picker, with the **Mine / All** filter to its left, and the 60-tile grid for the base
   it chooses;
2. **Trade suggestions** — who should swap what with whom, 5 pairs at a time;
3. **Collection leaderboard** — every tracked base, furthest along first, 5 rows at a time;
4. **Cards across the clan** — an expandable copy of the same grid, every tile badged with the
   clan's total.

**Trades sit directly under the grid** because the spares you have just typed in are what the
suggestions are made of, and because they are the only panel on the page that asks you to *do*
something. The leaderboard and the clan totals are both reference; the totals are sixty more tiles,
so they go last, still collapsed. Only the trades' position was asked for — the rest is a
consequence of it.

The bases are the **owner assignments** — the set of player
tags the group already tracks — so there is no second list of bases to curate and drift. A base
that somehow has counts but no owner assignment is still listed, so its rows are never orphaned.
The **owner is named on every trade suggestion**, because the owner is who would do the trading.
The picker itself lists in-game names and not owners: a name and an owner side by side in one
option are two people's names in one label, and the reader cannot tell which is which.

- **The base list is member names, not tags.** A tag is not who you go and talk to. The names come
  from the saved clans' rosters — one request per saved clan covers every base in it — and any base
  no visible roster names is asked for directly, one request each. A tag the API will not resolve
  keeps showing as a tag. Where two bases share a name the tag is appended (`darek (#2GCJ2QPU)`),
  and only then; the list is ordered by name, unnamed bases last. All of that is
  `baseOptions()` in `base-names.ts`, pure and tested. **Tags remain the identity** — the select's
  values, the inventory keys and the trade suggestions are all still tags, and the selected base
  shows its tag beside the timestamp.
- **The grid** is one continuous grid of all 60 in deck order — nothing drawn between one deck and
  the next, so a deck that runs out mid-row does not leave a ragged line. Each deck is still a
  **named group** in the markup: a `.card-deck` wrapper carrying `role="group"` and a
  `.visually-hidden` `<h3>` it is labelled by. The wrapper is `display: contents`, which is what
  keeps it out of the layout — the tiles stay direct grid items of the one grid, so the grouping
  costs no box, no gap and no change to the column alignment. Anything other than `contents` there
  splits the sixty tiles back into four grids and the seams reappear.
  Tiles are **picture only**: no card name. A card the base holds renders in colour; one it lacks
  renders the same file under `grayscale(1)`. That is **never the only cue** — the number box under
  the art reads 0 for a card the base lacks and n for one it holds, at every breakpoint, so
  held-vs-not survives with no colour vision at all. The name is on the tile's `title` and opens
  the number box's accessible name, so nothing that reads the page aloud has lost it. The cost is
  real and worth knowing: the card art is gitignored, so on a checkout with no art a tile is an
  empty frame over a count.
- **The count badge** sits in the art's lower right and appears **only past one copy**: `×1` on
  fifty tiles would be noise, where a spare is the fact worth spotting. The clan-totals grid makes
  the opposite call and badges every count — see [Cards across the clan](#cards-across-the-clan).
- **The tile border carries the deck**, in the event's own frame colours —
  `--deck-elixir`, `--deck-dark-elixir`, `--deck-builder-base`, `--deck-super-troop`, declared
  in all three theme scopes and lightened for dark mode, where the deep purple would otherwise
  vanish. Categorical colour on a border only, never on text. With the drawn headings and the names
  gone it is the only *visible* cue to deck, which is a real narrowing — the fallbacks are that
  the cards stay in deck order so each colour arrives as one unbroken run, that each run is a
  named group with a hidden heading, and that every tile's `title` and its box's accessible name
  spell the deck out in words. **Colour is never the only carrier**, which is the rule this page
  would otherwise have been the first to break. It also settles the one case
  where two cards share a picture, since the home and Builder Base Baby Dragons sit in different
  decks; with the names gone, that pair is otherwise indistinguishable. The nominal
  values are recorded in `CARD_CATEGORY_BORDER` in `shared/src/card-types.ts`; what the page
  paints is the CSS token, because a colour that must work on parchment *and* dark wood is a
  theme decision.
- **Entry** is a capped 0–10 number box on each tile, kept in a local draft so typing sixty
  boxes is one write, not sixty. The draft re-seeds when the base changes or when somebody
  else's save lands — but never while there are unsaved edits, because silently replacing what
  someone is typing is worse than showing a stale number they are about to overwrite.
- **The four deck plaques** sit in the base header's **upper right, directly beneath the
  `13/60 cards · 22 copies · 9 spares` line** they break down. See
  [Deck progress plaques](#deck-progress-plaques) — the same four are on every player page.
- **Last updated and who** is shown above the grid for the selected base.
- **A failed write is reported at the Save button**, with the typed counts left exactly as they
  are so nothing has to be re-entered. `Saved` never appears unless the request succeeded.
- **Trade suggestions** are the panel directly under the grid, driven entirely by the pure module
  and grouped by the pair of bases involved. Its two identity columns are headed **Member** and
  print the **member name** as the link — a tag is not who you go and talk to — with the **tag and
  the owner** on a second line beneath it. The tag is not dropped anywhere: it is the identity the
  counts, the routes and the trades are all keyed on, and it is omitted only where it *is* the
  name, i.e. for a base no visible roster names. The names come from the same `baseOptions()` the
  picker uses, so there is one resolver, not two. Stacked on a phone, a pair's later options label
  themselves `darek gives` / `Zack gives` rather than repeating the tags.
  The table itself is `TradeSuggestions` in `web/src/components/TradeSuggestions.tsx`, **shared with
  a player page**, which renders the same component with a `focusTag` so it shows only that base's
  pairs — see [the trades under a player's grid](#the-trades-themselves-under-the-grid). Here it
  is deliberately unfiltered and group-wide: a trade has two sides and half of them are somebody
  else's bases by definition.

#### Row counts on the trade suggestions

A **Pairs** select at the **bottom** of the section, defaulting to **5** (5 / 10 / 20 / All), with
the pager beside it. The choice persists at `coc:tradePairLimit`, the same way every other row
limit in the app does, and the same `paginate()` / `parseRowLimit()` / `RowLimitSelect` / `Pager`
machinery does the work — see [Row counts and paging](#row-counts-and-paging).

**The limit counts pairs, not rows, and both controls say so.** The two readings genuinely differ
here: fifteen pairs can be nineteen rows, because a pair with several options is one block with the
member named once and its options listed beneath. Paging by row would put a row with two empty
Member cells at the top of page 2 — which reads as missing data rather than as "the same two bases
as above", the exact failure the wide table's `data-pair-start` rule exists to prevent — and would
also make "5" mean something other than five decisions to make. So the control is labelled `Pairs`,
the pager reads `Showing 1–5 of 15 pairs`, and the note underneath adds `7 options on this page`
whenever there is more than one page. Verified in a browser: at the default, `Showing 1–5 of 15
pairs` over 5 pair-blocks and 7 rows; `Next` gives `Showing 6–10 of 15 pairs` over 5 and 5; `All`
gives 15 blocks and 19 rows with no pager at all.

### The collection leaderboard

Every tracked base, ranked by how far it has got, directly under the trade suggestions — because
"who should trade with whom" and "who is furthest ahead" are the same question asked two ways, and
the base near the top with spares is the one worth messaging. Member name, tag, owner, points, cards
and copies; the `17/60` is printed and a `.meter` bar on the sequential blue ramp is a second
telling of it, never the only one.

**A Rows select at the bottom of the table**, defaulting to **5** (5 / 10 / 20 / **50**), persisted
at `coc:cardStandingLimit`. No `All`: 50 already covers every tracked base with room to spare, so
it would be a second name for the option next to it. Same helpers as every other paged table.

**The measure is points**, awarded per card by how many copies a base holds — `cardPoints()` in
`card-standings.ts`:

| Copy | 1st | 2nd | 3rd | … | 10th | 11th and beyond |
|---|---|---|---|---|---|---|
| Worth | 10 | 9 | 8 | … | 1 | 1 each |

So a card held once is 10 points, twice 19, three times 27, ten times 55. Summed over the sixty,
a complete set at the cap is **3,300**. The curve means the first copy of a card you lack is worth
ten times the eleventh copy of one you have, so breadth outweighs hoarding — while spares still
count, because spares are what make a trade possible at all.

The beyond-ten arm is **deliberately unreachable today**: `MAX_CARD_COUNT` caps entry at ten, so
nothing can score it through the interface. It is implemented so that raising the cap cannot
silently change what a base scores, and a test pins it.

The order, in `baseStandings()`:

> **points descending, then distinct descending, then member name, then tag.**

Distinct breaks a points tie because reaching the same score across more of the sixty is the
better position — and points ties are real, not hypothetical: 54 is reachable both as one card
held nine times and as two cards held three times each. The name and tag are not merit at all.
They are there to make the order **total**, so two level bases render in the same sequence every
time rather than swapping places between renders; a test runs the same bases in reversed input
order and asserts an identical result.

The **rank number** is shared on a genuine tie and then skips (1, 2, 2, 4). Tied means level on
**points**: two bases separated by nothing but their names, or by which cards made up the same
score, have not out-scored one another and must not print as 4th and 5th.

The row prints the score *and* `17/60`. Either alone misleads — a bare score does not say how far
through the sixty a base is, and the fraction no longer explains why one row outranks another.

**Paging never renumbers.** The rank comes from `baseStandings()`, computed once over the whole
board, so page 2 opens at rank 6 and reads 6 — numbering the visible rows instead would restart at
1 and turn the one column that means something into a row counter. Read back off the DOM: page 2 of
the default 5-row view shows ranks `6, 7` under `Showing 6–7 of 7 bases`.

A base **nobody has ever saved** stays on the board, last, and says `Nothing recorded yet` rather
than printing `0/60` — the same distinction the grid's attribution line draws. Sixty zeroes
presented as data would be a claim nobody made.

It is **group-wide and not filtered by Mine/All**. A leaderboard of one base answers nothing.

### Cards across the clan

The **last** panel, and an expandable one: the same 60-tile grid as above, every tile carrying the
copies held across **every** tracked base as a small badge in its lower-right corner — exactly where
the per-base count badge sits. Collapsed by default, and its summary line carries the headline —
`All 60 cards, in grid order · 38 nobody holds`.

**It is the grid, not a list.** It was a two-column list of `.meter-row`s; a grid is what makes it
readable against the tiles above, because "the same picture in the same place" needs no
translation. That is not a claim about two similar components: `CardTile` in
`web/src/components/CardTile.tsx` **is** the tile, and `BaseCardEditor`'s entry grid and this one
are its two callers — same art, same framing, same deck-coloured frame, same greyscale.
Measured at 1280px, both grids render 7 columns of 123px tiles over a 107×134 (4:5) frame; five
columns at 600px, three at 390px. What the two callers vary is only the badge, what sits under the
frame (a number box, or nothing) and where the accessible name comes from.

**The order is fixed by design and never changes with the counts.** It comes from
`cardsInGridOrder()`, which is literally the grid's own two calls — `cardCategoriesInOrder()` then
`cardsInCategory()` — rather than a second ordering that agrees with it today and drifts the next
time the manifest is regenerated. The whole reason the panel earns its place is that it can be
scanned tile-for-tile against the grid above it, so **nothing here sorts by count, in any mode**.
That is asserted directly: a test puts all the copies on the *last* card and none on the first and
checks the output order still matches the input's. And read back off the DOM: the two grids' 60
tiles, compared by name in document order, match card for card at 390, 600 and 1280px.

**The badge appears on every count, including 1** — the opposite of the entry grid, where `×1` on
fifty tiles is noise. Here the totals *are* the point, and a card exactly one person in the clan
holds is one of the more interesting things on the page.

**Every tracked base is counted, linked to an account or not.** Most assignments in this install
are still free-text labels; their cards are as tradeable as anyone's, and excluding them would
undercount the group by more than half rather than describe a smaller one.

**A card nobody holds is greyscale with no badge, and the words carry it.** That visual state is a
colour cue plus a *missing* cue, which is not enough on its own, so every tile has an explicit
accessible name — the tile is a `role="img"` with an `aria-label`, since there is no control inside
it to carry one:

```
Barbarian, Elixir — none held across the clan
Archer, Elixir — 3 held across the clan
```

Both read back off the computed accessibility tree as `image` nodes with exactly those names; the
same sentence is on each tile's `title`, and the summary line above counts them. The tile **does
not move**: card 1 is the first tile in grid order and nobody holds it, and it stays first.

Each deck is a `role="group"` labelled by a `.visually-hidden` heading exactly as the entry grid's
`.card-deck` is, with its own `card-total-deck-*` ids — both grids are mounted on this page at once,
so the ids cannot be shared.

It stays **collapsed** because sixty more tiles left open would push everything above them off a
phone. It costs no extra art either way: measured, its sixty image URLs are byte-for-byte the entry
grid's, so opening it adds no requests, only the drawing.

### Mine / All on the base picker

A `Show` select to the **left** of the `Base` picker, filtering what the picker offers. A select
rather than a pair of buttons: it is the same control as the one beside it, it shows its own state
without being opened, and the phone rules already give it a 44px target and a 16px font. Its
accessible name, read off the computed accessibility tree, is `Show`.

**`Mine` means `ownerUserId`, never the owner label.** It is the same field the write rule
(`cardEntryAccess`) uses, so "mine" on the picker and "mine" on the grid cannot come apart — and
a free-text owner name that happens to match yours is a note about a person, not a base you may
write.

Four things it has to get right, all of them in `base-scope.ts` with tests:

- **the selection cannot point outside the list.** `activeTag()` keeps the chosen base while the
  filtered list still offers it and otherwise falls to the head of that list — so switching to
  `Mine` while reading somebody else's base moves the editor to your own first base rather than
  leaving counts on screen that the picker no longer offers. It is deliberately the *same* rule as
  the initial default, so there is one definition of "a valid selection" rather than a default and
  a repair that could disagree. Widening back to `All` carries the base you were reading with it.
- **`Mine` is the default only when the account actually owns a base**, otherwise `All`. Most
  accounts here own nothing, and defaulting blindly would open them on an empty dropdown over an
  empty editor. The check waits for the owner list to land first: an empty first snapshot would
  say everybody owns nothing.
- **an empty `Mine` says so in words**, naming the actual next step — a base becomes yours when an
  **admin assigns it to your account** — and pointing at `All`. The `Base` select is not rendered
  at all in that state rather than rendered empty. A stored `Mine` is honoured even by an account
  that owns nothing, which is what keeps that message reachable: they asked for it.
- **the choice is persisted per account**, at `coc:baseScope:<userId>`, for the reason
  `coc:lastClan:<id>` is: one browser is shared, and one person's `Mine` is the other person's
  empty list. Verified in a browser — with `coc:baseScope:1` holding `all`, a second account
  signing in on the same profile still defaults to `Mine` and does not touch the first key.

**The leaderboard and the card totals ignore this filter entirely.** They are about the whole
clan's progress; narrowed to one person's bases they would stop meaning anything.

### Deck progress plaques

How far a base has got in each of the four decks, drawn the way the event itself draws it across
the top of its own panel: one rounded plaque per deck, in that deck's colour with a full-strength
rim, the deck named across the top in bold, and beneath it a bar — dark track, fill growing from
the left, **the fraction printed on the bar** — `Elixir Cards 7/19`.

**Where they are.** Two placements, both showing the same four numbers:

- **a player page**, full width, immediately under the panel's `Clash of Cards` title and
  **above** the `<details>` that holds the grid — so they are readable whether the grid is open or
  shut, which is the whole point of them. Deliberately *not* inside the `<summary>`: a summary's
  accessible name is its own contents, so four progressbars in there would rename the disclosure
  control from `Card grid · Trades available with 1 base` to a paragraph of numbers every time it
  was announced, and four block plaques would have to lay out around the marker glyph a summary
  draws. The summary keeps the **trade indicator**, which is now the only thing it says that the
  plaques do not;
- **the card page**, in the base header's upper right, directly beneath the
  `13/60 cards · 22 copies · 9 spares` line they break down. There they read off the live **draft**
  rather than the stored record, so they never disagree with that count while somebody is typing.

**Four across, 2×2 at ≤600px** — four in a row at 390px would be 75px each, narrower than the
words on them. The header placement reserves `34rem` beside the base name and lets the *name* take
its own line rather than squeezing the plaques, which is what keeps four across down to 601px with
no third breakpoint. Measured 320–1280px: names on one line at every width, no horizontal
overflow anywhere.

**The bar fill is the sequential blue ramp, not the game's gold.** The game fills these bars gold;
gold in this app is chrome — panel edges, buttons, the two display numerals — and has never encoded
a value. A gold bar whose length meant something would be the first, and it would spend the one
signal the palette has for "this is furniture, not data". The deck's own colour was the other
candidate and is out for the mirror-image reason: `--deck-*` is *categorical*, it already says
which deck on the plaque wrapped around the bar, and reusing it for the bar would leave four bars
whose colours differ for a reason that has nothing to do with their lengths. So the plaque keeps
the deck colour, the bar keeps `--accent` on `--track` like every other meter here, and **the
fraction is printed either way** — progress is never carried by a length or a hue alone. That last
part is the non-negotiable one; the choice between the three colours is a judgement call and this
is where it is recorded, alongside the same note in `DeckPlaques.tsx`.

The plaque is a *tint* of the deck colour rather than a solid fill like the game's, because the
four tokens run from bright magenta to deep purple and no single text colour clears 4.5:1 on all
four; tinting keeps the name and the fraction in `--ink`. The fraction sits over bare track on an
empty deck and over full-strength `--accent` on a complete one, so it carries a `--surface` ring
in `text-shadow` — the panel colour `--ink` is already designed to be read on, in both themes.
The game outlines its numerals for the same reason.

**No resource icon** at the right end, unlike the game. The event's elixir, dark-elixir,
builder-gold and potion icons are not among the vendored art — `web/public/coc/` has card art,
league badges, labels and wiki unit art and nothing else — and an equipment gem standing in for a
resource would be a picture saying something untrue. The space goes to the fraction.

**A base with nothing recorded gets no plaques at all**, on either page: four `0/19` bars for a
base nobody has entered would be a claim nobody made. A base entered once and then **cleared back
to zero** does show four empty bars, because that is a base somebody checked. Same distinction the
card page's attribution line draws, and it comes from the same place — `summariseBase().recorded`.

Each plaque's bar is a real `role="progressbar"` with `aria-valuemin` / `max` / `now` set and an
`aria-valuetext` of `7 of 19` (not `7/19`, which is read out as "seven slash nineteen"). Its
accessible name, read back off Chrome's computed accessibility tree, is
**`Elixir cards: 7 of 19 collected`** — deck, count and total, so nothing depends on seeing the
bar.

The shape is `deckProgress()` in `web/src/deck-progress.ts`, pure and tested: it pairs each deck's
`distinct` from `summariseBase()` with its size from `cardsInCategory()`, clamps the bar, and
builds the two strings. It **recounts nothing** — that was the point of extracting it, since the
denominators had already been assembled once in the player panel and a second copy on the card
page would have been the third place a `7/19` could be built and the first place it could disagree.

### The same grid on a player page

A player page **is** a base, so it carries the card panel too — directly under the profile header
that holds the name and trophies, above the stat tiles. The panel's four deck plaques are always
on screen; the sixty tiles **and this base's trade suggestions** are a `<details>` below them,
**collapsed** by default, because sixty tiles unfurled there would bury the rest of the page. Shut,
the panel is the plaques plus one line:

```
EVENT CARDS · 2026-08
[Elixir Cards 7/19] [Dark Elixir Cards 2/13] [Builder Base Cards 2/11] [Super Troop Cards 2/17]
▸ Card grid · Trades available with 1 base
```

- **how far each deck has got**, as the plaques above;
- **whether a swap is waiting**, in words, with the status green as a second carrier and never
  the only one — `No trades available` reads the same with no colour vision at all.

A base nobody has entered shows **no plaques** and reads
**`Nothing recorded yet — open to enter counts`**, not sixty zeroes dressed as data. That is the
same distinction the card page's attribution line draws, and it is why the panel keys off whether
a base has a record at all rather than off its totals: a base saved and then cleared back to zero
keeps its stamp and reads as recorded-and-empty.

**Opened it is the card page's grid, with no base selector** — the base is the player whose page
it is. Same tiles, same greyscale, same deck-coloured frames, same `×n` badges, same 0–10 boxes,
same one-request save, same 4 named deck groups. That is not a claim about two similar
components: `BaseCardEditor` in `web/src/components/BaseCardEditor.tsx` **is** the grid, and
`CardsView` and the player page are its two callers, and one tile of it is `CardTile`, shared in
turn with the clan-totals grid. Measured side by side at 1280px, both render `123.141px ×7`
columns, a 10px gap and a 107×134 frame per tile; five columns at 600px, three at 390px.
Duplicating sixty tiles and their draft-and-save logic was the thing to avoid — the greyscale, the
badges and the clamping would have drifted apart the first time either copy was touched. Choosing
the base is deliberately not the shared component's job; each page keeps its own idea of which base
it is about.

The **one** thing the two callers differ on is the deck plaques, which `BaseCardEditor` draws only
when asked (`showDeckProgress`, on for the card page and off here). A player page already has them
above the panel, where they can be read without opening it, so drawing them in the grid's header
too would print the same four bars twice on one screen.

**The trade hint needs the other bases**, because a trade is a pair. It comes from the same
module-level `card-inventory.ts` store the card page uses, so the player page costs **one**
`GET /api/cards/inventory` for every base — never one per base and never one per card — and it is
already warm if you arrived from the card page.

The counting and the predicate are one pure, tested function, `summariseBase()` in
`web/src/card-summary.ts`. It does not re-implement the trade rules: it **calls `suggestTrades`**,
one pair at a time (the whole-list call is quadratic and computes every pair the panel will never
mention), so the hint cannot drift from the list on the card page. Its tests cover no cards, cards
in one deck only, a base holding spares with no counterpart, and a base with a genuine swap
available.

#### The trades themselves, under the grid

The summary line has always said `Trades available with N bases`. Now the panel **shows them**:
the suggestions table sits inside the same `<details>`, directly below the grid, under a
`Trade suggestions` sub-heading. Same disclosure, so it opens and closes with the tiles — verified
by clicking the summary and reading `checkVisibility()` off the table, the heading and the grid at
390, 600 and 1280px in both themes: all three hidden shut, all three shown open, no second control
to find.

**Filtered to this base.** The table takes an optional `focusTag` and keeps only the pairs that base
is a side of. A clan-wide list under a heading counting *this* base's partners would contradict its
own summary line; filtered, the two are the same number. Read back off the DOM on a seeded base
with two partners: summary `Trades available with 2 bases`, table `2` pair blocks over `10` option
rows, one `Propose` per row. Seeded up to six partners: summary `Trades available with
6 bases`, `6` pairs, and the pager appears — `Showing 1–5 of 6 pairs`, `Page 1 of 2`, 19 options on
page 1 and 3 on page 2. Below five it hides itself, so a base with a couple of partners shows no
control at all.

**It is the card page's table, extracted — not a copy.** `TradeSuggestions` in
`web/src/components/TradeSuggestions.tsx` is now the third thing the two pages share, after
`CardTile` and `BaseCardEditor`, and it took `TradeCard`, `ProposeButton` and `BaseLabel` with it.
Naming a base moved too, into `useBaseLabels()` in `web/src/base-labels.ts`, so both pages print the
same text for the same tag right down to the `(#TAG)` suffix a shared name gets. The rules run over
**every** base and the narrowing happens afterwards — one call, in one order, so the two pages
cannot drift into disagreeing about what a trade is or which one comes first.

Paging is the card page's, unchanged: **pairs, not rows**, five by default, remembered under one
`coc:tradePairLimit` for both pages, because it is a reading preference about this table and not
about a route. **Propose** works here for the same reason — it posts to
`/api/cards/trades` and the tracker directly below reads the same module-level store — so a swap
proposed from a player page appears on the card page's tracker and the other way round. See
[The Trade Tracker](#the-trade-tracker).

The table carries `aria-label="Trade suggestions"` and **never** `aria-labelledby` the heading above
it. Both headings that sit over it are `.section-title`, which is `text-transform: uppercase`, and
Chrome computes an accessible name from the *transformed* text — pointing at one would name the table
`TRADE SUGGESTIONS`. Read back off the accessibility tree: `table: "Trade suggestions"`. The visible
heading is the same words, so label-in-name still holds.

**The Category column is kept**, deliberately. It is not redundant with the two cards beside it: the
swap is legal *because* they share a deck, and on a player page the four deck plaques directly above
make the deck the unit of progress — so "which deck does this swap move" is the column that says
whether an option is worth taking. It costs nothing at 390px either, where the table stacks into one
labelled card per swap and the deck becomes a line rather than a column competing for width.

### The Trade Tracker

A *suggestion* is arithmetic: recomputed from the shared counts on every render, thrown away, and
true only for as long as the counts behind it are. It answers "what **could** we swap". Nothing in
it recorded that two people had agreed to one, so "did we actually do that swap?" had no answer
anywhere but in a chat scrollback — which is what the tracker replaces.

A **trade** is a stored row: one swap, two bases, visible to everybody, that either party can mark
complete or declined. Completing it is what moves the cards.

#### Where it is

Directly **below** the trade suggestions, in both places the suggestions appear — the card page and
each player page's card panel, inside the same disclosure as that base's grid. That order is the
order the work happens in, read downwards: what could be swapped, then what has been agreed and is
waiting on somebody. It is its own panel rather than a second table inside the suggestions, because
a row here is a record with consequences and a row above it is a calculation.

One component, `web/src/components/TradeTracker.tsx`, for both — the fourth thing the two pages
share, after `CardTile`, `BaseCardEditor` and `TradeSuggestions`. The only difference is
`focusTag`: the player page passes its base and gets the trades that base is a side of, the card
page passes nothing and gets the clan's.

#### Proposing

Every suggestion row carries a **Propose** button. It writes a row and stops: **no cards move.**
The proposal is one side saying "let's do this", and the *other* side (or an admin) is who
completes it — so the button is safe to press and its label promises only what it does.

You must own one of the two bases, or be an admin. A member who owns neither is told who can
(`darek or Turtle can propose this`) rather than being handed a button that would 403: proposing a
swap between two other people's bases is putting words in their mouths, and the other party would
have to decline something they never discussed. The rule is `tradeProposeAccess` in
`web/src/trade-tracker.ts`, mirroring the server's `mayProposeTrade`; the server is the
enforcement and the client rule only stops the UI offering what would be refused.

A swap already pending reads `On the tracker ↓` instead of offering a second proposal. Pressing it
again would in fact be harmless — the server answers **409 `alreadyProposed` with the existing row**
and `proposeTrade` treats that as success, because what the button promises ("this swap is on the
tracker") is true either way — but a control that does nothing new should not look like one that
does. The check is `findPendingSwap`, the same four columns as the partial unique index in
migration v7, so "already proposed" means the same thing on both sides of the wire.

#### Resolving, and who may

**Either party, or an admin.** A trade belongs to *both* bases, which makes its rule different from
the per-base card write: card counts belong to one owner, an agreement does not. The consequence
worth saying out loud is that **completing a trade writes to two bases, one of which the person
clicking very likely does not own** — so the authorisation for those two writes is the *trade
record*, not the owner rule, and `server/src/cards/trade-access.ts` is where that is decided once.

A base carrying only a legacy text label grants nobody anything, exactly as for card entry: the
label is a note about a person, not a permission held by a session, so such a trade is an admin's
to resolve until an admin links the base to an account.

**Completing asks first**, and the question says what it does to whom: it is the only control in the
app that changes somebody else's card counts, and it cannot be undone from here. **Declining does
not ask**, because nothing moves. Both are recorded.

A trade is resolved **once**. Re-completing would move the same two cards a second time — silent,
wrong, and exactly the accident the refusal exists to prevent — and re-declining would rewrite the
audit stamp of a decision somebody else already made. The store refuses, the route answers 409
`alreadyResolved`, and the client hides the buttons; three layers, because the cost of missing it
is a wrong count nobody can trace.

The invariant the whole feature protects is checked **at completion, against the counts as they are
at that moment** — not against the ones the proposal was drawn from. A base must hold at least
`MIN_TRADEABLE_COUNT` (two) of a card to give one away, because a base that trades away its last
copy has lost a card rather than swapped one. Counts are hand-entered and routinely lag the game, so
a proposal is deliberately *not* re-validated when it is made: somebody who has just looked at their
cards knows more than the table does, and refusing them would push the disagreement into a
conversation nobody can see. If the spare has gone by the time it is completed, the route answers
409 `countsChanged` and the tracker shows that message verbatim.

#### The audit record

Every row names **both** events: who proposed it and when, and — once resolved — who completed or
declined it and when. Not just the latest one: "Bert completed it" without "Anna proposed it" loses
which direction the agreement came from, which is the first thing somebody checks when a swap turns
out to be wrong. Relative on screen, absolute in the `title`, as everywhere else in the app.

A `null` name means that account has since been deleted, and it is said in words rather than left
blank. Both user columns are `ON DELETE SET NULL` on purpose: the trade is the record of something
that really happened, so deleting an account costs the attribution, not the record.

#### Order

Pending first, however old — it is the only status anybody has to act on. Within pending, **oldest
first**, because a swap that has been waiting three days is the one being forgotten. Resolved rows
read newest-first, which is the order you want when checking whether something just went through.
The id breaks every remaining tie, so two trades proposed in the same second cannot swap places
between polls. `sortTrades`, tested.

#### What the counts do afterwards

Completing writes both bases in one transaction in `trades-store.ts`, and the response carries the
trade in its new state **plus both bases' current counts** — so one request is enough for a client
to refresh two bases. `web/src/trades.ts` nonetheless reloads the inventory store rather than
patching it from that payload: it is the same refresh every other write does, and patching would
add a second path by which counts enter the cache — one no other write uses, and one that would be
wrong in exactly the case that matters, a count that fell to zero and is therefore *absent* from
the response rather than present as a zero.


## War view

`#/war/<clanTag>` shows the current war and the war log together, fetched independently so
one failing does not blank the other. Head-to-head star score, destruction, attack usage
meters, and both rosters with per-member stars, best hit, attacks used, and best defence
against them.

## Capital raid weekends

Below the roster, the clan page shows the last few raid weekends from
`GET /api/clans/:tag/capitalraidseasons` — date range, state, total capital loot, raids
completed, enemy districts destroyed, and the offensive and defensive reward. Each weekend
also gets a `<details>` expander with the per-member breakdown: attacks used out of the limit,
and capital resources looted, ordered by loot.

Two things about that payload are worth knowing before reading the code:

- **`members` is only present while a weekend is `ongoing`.** Every `ended` weekend omits the
  key entirely — not an empty array — verified across two clans and ten weekends each. So past
  weekends have totals but no attribution at all, and the expander says so rather than
  pretending the clan had no participants.
- **Attacks used can exceed `attackLimit`**, because the bonus attack is reported separately.
  The usable total is `attackLimit + bonusAttackLimit`, which is what the table divides by.

A clan that has never taken part gets `{"items": []}`, which the card handles with a plain
message.

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

## Game art and the Fan Content Policy

The UI wears a Clash-themed skin — parchment and stone by day, dark wood by night,
gold-bevelled panels and pressed buttons. All of that is CSS: gradients and bevels,
no image assets, so it costs nothing to load and works in both themes.

The actual game art is a different matter, and it arrives from two different places.

### What the API gives you

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

### What the wiki gives you

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
now its own purpose-made set (see [The tiles are framed whole](#the-tiles-are-framed-whole)), so the
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

### Absent art is the normal case, not an error

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

### Licensing, and why it matters more now

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

### Not covered

- **Capital district art does not exist on the wiki.** Checked: there is no per-district
  image for Wizard Valley, Balloon Lagoon, Golem Quarry and the rest, only a generic
  `District_Hall<n>.png` by level. Mapping that generic building onto district names
  would show the same picture for every district, which is worse than no picture, so
  `CapitalRaidsCard` has none.
- **Resource and achievement icons** are not fetched. Nothing in the UI is keyed to a
  resource type by name, so there is nowhere to put them.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | API + UI with reload |
| `npm test` | server auth, card and trade suites (`app.request` against `createApp`, in-memory SQLite) + web unit tests for table sort, paging, owner-overwrite, `coc:saved` migration, wiki-art name lookup, the card list, the trade rules, the tracker's access and ordering rules, and the account menu. Both workspaces glob `src/**/*.test.ts`, so a new test file runs without being added to a list |
| `npm run typecheck` | `tsc --noEmit` across all three workspaces |
| `npm run build` | production bundle for the UI — run the two asset scripts *first* |
| `npm run assets:coc` | re-download the vendored league and label icons from the CoC API |
| `npm run assets:wiki` | re-download troop / spell / hero / equipment / Town Hall art from the wiki, and print a coverage report |
| `npm run cards:generate` | regenerate `web/src/cards.generated.ts` from the card manifest. Needs `web/public/coc/cards/manifest.json`, which is gitignored — so this only runs where the art tree exists, and the generated module is committed for everywhere else |
| `npm start` | API only, no watcher |

The server runs through `tsx` in both dev and production — there is no server build step.
