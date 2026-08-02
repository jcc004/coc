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
start failing with **403 `accessDenied`**, your public IP changed — mint a new key for the
new IP and update `.env`. The server surfaces this as a hint in the error panel rather than
leaving you to guess, because it is by far the most common failure.

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
surfacing as a confusing error inside a data panel. The topbar shows your **display name** — it
links to `#/account`, which shows your identity (display name, email, guid — the guid is shown
but not editable), the password-change form and, for admins only, the user list — plus a
**Sign out** button. No credential is kept in `localStorage`: the cookie is the whole
mechanism.

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
  the same path.
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
The directory is created if missing. Five tables — `users`, `sessions`, `chat_messages`,
`saved_clans`, `owner_assignments` — created and migrated on boot by `user_version`.

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

### Where image upload will attach

Upload is **not built**. The seam for it is `requireAuth`, exported from
`server/src/auth/middleware.ts`, which reads only context state and so mounts anywhere:

```ts
app.post('/api/uploads', requireAuth, handler)   // already denied to anonymous callers anyway
```

Three things that must be decided when it is built, none of which this layer does for you:

1. **A body-size limit before accepting any body** — Hono's `bodyLimit` middleware, mounted on
   the upload route *ahead* of the handler. Without it, an authenticated user can exhaust the
   host's disk or memory with one request.
2. **Per-user scoping.** Files belong to `users.id`, both in the path on disk and in whatever
   table indexes them, and a read must check ownership rather than trusting an id in the URL.
   `users.id` is a plain integer primary key precisely so this can FK to it
   (`user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE`, as `sessions` already
   does).
3. **Storage location on the host** — the same persistent volume as the database, or object
   storage; the container filesystem is not it.

## Deployment

What the host actually has to provide:

- **A persistent volume for the SQLite file.** Point `DATABASE_PATH` at an absolute path on it
  (`/data/coc.db`). On an ephemeral filesystem every restart wipes the accounts and the
  bootstrap runs again — which is also the one case where `ADMIN_PASSWORD` lingering in the
  environment would silently recreate the admin.
- **A static egress IP.** Supercell binds the API key to the IP addresses you name when you
  create it, so the app's *outbound* address must be fixed. Most PaaS hosts rotate outbound
  IPs, which is why this wants a small VPS or a fixed-address proxy. Symptom of getting it
  wrong: every upstream call returns 403 `accessDenied`.
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

`assets:wiki` needs `COC_API_TOKEN` as well, because it asks the CoC API which units exist
before it goes looking for their pictures. It takes about a minute on a cold run (requests are
serialised and paced) and a few seconds when the files are already on disk.

## Layout

```
shared/   types for the CoC API, the auth payloads and the shared data, + tag
          parsing and email normalisation
server/   Hono API, upstream client, TTL cache, auth (src/auth/), the shared
          saved clans and owners (src/shared-data/), migrations (src/db.ts)
web/      Vite + React UI
```

Inside `server/src/auth/`: `passwords.ts` (scrypt), `store.ts` (the only code that touches
`users` and `sessions`), `middleware.ts` (cookie → context, plus the exported `requireAuth` /
`requireAdmin` / `requirePasswordUpToDate`), `rate-limit.ts`, `bootstrap.ts` (first admin and the
email escape hatch), `temp-password.ts` (the unambiguous alphabet and the rejection sampling),
and `routes.ts`. `server/src/shared-data/` is the same split for the shared rows: `store.ts` is the
only code touching `saved_clans` and `owner_assignments`, `routes.ts` mounts them. Migrations
live in `server/src/db.ts`.

`createApp({ coc, cache, auth, chat, sharedData })` stays dependency-injected, which is what
lets the test suite drive the whole app over an in-memory database and a stub upstream.

`shared` is consumed as TypeScript source through an npm workspace link — no build step,
so a type change is visible on both sides immediately.

Two asset-mapping modules in `web/src/` are machine-written and must not be hand-edited:
`coc-assets.ts` (which league and label ids are vendored) and `wiki-art.generated.ts` (which
unit names have wiki art). The hand-written half of the second one is `wiki-art.ts` — the
normalisation and lookup — which is where the tests point.

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

## The lookup sidebar

Lookup lives in a right-hand sidebar, sticky near the top so it stays put while the main
column scrolls. The sidebar is **15% of the viewport with a 260px floor** — a bare 15% is
only ~192px at 1280px wide, which is too narrow for the controls. Below 900px the layout
collapses to one column and the sidebar stacks *above* the content, so lookup is still the
first thing in reach on a phone. The topbar spans the full width above both columns.

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
per clan tag and one per player tag for the install, and every signed-in caller reads and
writes the same ones. There is no per-user filter in any handler.

```
saved_clans        clan_tag PK, name, custom, clan_level, members, clan_points,
                   war_league, updated_at, updated_by_user_id → users(id)
owner_assignments  player_tag PK, owner, updated_at, updated_by_user_id → users(id)
```

- **`owner` is free text, deliberately not a FK to `users`.** The owner of a base is a person
  in the clan, who need not have an account in this app. *Future option:* if that stops being
  true, the column could become a nullable `owner_user_id` alongside the text, so a linked
  owner renders as an account and an unlinked one still renders as a name.
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
| `GET /api/owners` | every assignment |
| `DELETE /api/owners/:tag` | remove one |
| `POST /api/owners/bulk` | the conditional bulk apply, below |
| `POST /api/import` | the one-time browser hand-off, below |

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

## Owners live on the clan page

There used to be a second landing-page table of saved *bases*: a curated list of player tags
with a display name, Town Hall, trophies, clan, and an **owner**. The clan page already shows
all of that for every member, so the table was redundant and is gone. The one thing worth
keeping is the owner, because it is the only field the API cannot supply.

Owner is now a bare annotation keyed by player tag, stored on the server and **shared with
everyone** (see [The shared data model](#the-shared-data-model)), through `web/src/owners.ts`.
The clan roster joins it in as a sortable **Owner** column, so the place you assign an owner
is the place you can already see the Town Hall, trophies and rank you are deciding from.

Removing the bases table also removed the **Save** button from player profiles. Player pages
themselves stay, and the sidebar still looks players up.

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

166 files, ~358 KiB on disk, against a 3 MiB cap the script enforces and reports
against. It stays small because `iiurlwidth`/`iiurlheight` make MediaWiki render the
thumbnail server-side: the app asks for 48px art for a 20px slot instead of pulling
a 4000×4000 original and needing an image library to shrink it. There is no `sharp`
here and there should not be.

It is polite by construction: existence checks batch 50 titles per request,
downloads run serially with a 300ms delay, anything already on disk is skipped, and
the `User-Agent` names the tool (override the contact via `WIKI_CONTACT`).

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
| `npm test` | server auth suite (`app.request` against `createApp`, in-memory SQLite) + web unit tests for table sort, paging, owner-overwrite, `coc:saved` migration and wiki-art name lookup |
| `npm run typecheck` | `tsc --noEmit` across all three workspaces |
| `npm run build` | production bundle for the UI — run the two asset scripts *first* |
| `npm run assets:coc` | re-download the vendored league and label icons from the CoC API |
| `npm run assets:wiki` | re-download troop / spell / hero / equipment / Town Hall art from the wiki, and print a coverage report |
| `npm start` | API only, no watcher |

The server runs through `tsx` in both dev and production — there is no server build step.
