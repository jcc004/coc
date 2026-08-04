# Authentication

**Why it exists.** The Supercell token lives server-side and is rate-limited *per token*. An
open `/api/*` on the public internet is therefore a free proxy onto that budget — anyone who
finds the URL can spend it, and Supercell throttles the key, not the caller. Authentication
here is not a login form for decoration; it is what protects the token.

## The model

- **Server-side sessions, not JWT.** A session is a row in SQLite keyed by a 256-bit opaque
  token (32 random bytes, base64url) in an `HttpOnly` cookie. With ten users the row costs
  nothing and buys the thing a JWT cannot: **instant revocation**. Sign-out, a password
  change, and disabling an account all take effect on the next request, because the check is a
  lookup rather than a signature over a claim that stays valid until it expires. There is no
  refresh-token dance and no key rotation to get wrong.
- **Cookie**: `HttpOnly` (JavaScript cannot read the token, so an XSS bug cannot exfiltrate a
  session), `SameSite=Lax` (the browser withholds it on cross-site POSTs, which is the CSRF
  defense for every state-changing route), `Path=/`, and `Secure` whenever
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

## Routes

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

## Password recovery is admin-mediated, and there is deliberately no email reset

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

## The forced change is enforced, not cosmetic

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

## The UI

The app shell is not rendered until `GET /api/auth/me` answers; a 401 renders the login screen
*instead of* the shell, so no panel gets to fire a request and paint its own 401. A **global
401 handler** in `web/src/api.ts` (`setUnauthorizedHandler`, wired up by `web/src/session.ts`)
means a session expiring in an open tab drops you back to the login screen rather than
surfacing as a confusing error inside a data panel. The topbar carries an **account menu** behind a
silhouette (see [The account menu](ui.md#the-account-menu)); `#/account` shows your identity (display
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
the behavior cannot drift between them. It defaults to `type="password"` and only the toggle
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

## Email is the credential (it used to be a username)

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

## The migration, and the escape hatch

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
  [The card-collecting event](cards.md#the-card-collecting-event). A plain `CREATE TABLE`, which would
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
  [Migration v6, and what the backfill did](shared-data.md#migration-v6-and-what-the-backfill-did).
- **v7** — `trades`, the Trade Tracker's one table: a swap two bases have agreed to, which
  either party can then mark complete or declined. `base_a < base_b` with its card, the same
  orientation `suggestTrades` produces, so one agreement is one row however the two sides
  named themselves; `CHECK`s repeat the card-id range and forbid a base trading with itself or
  a card for itself; both user columns are `ON DELETE SET NULL`, because a resolved trade is the
  record of something that really happened and must outlive the account that resolved it. A
  **partial unique index** on the four swap columns `WHERE status = 'pending'` makes a duplicate
  live proposal impossible while leaving history alone. See
  [The Trade Tracker](trade-tracker.md#the-trade-tracker).

Backfill, per row:

- `guid` — a fresh v4 UUID. Nothing derived from the username, so it carries no information.
- `display_name` — the old username. It was the only human label there was.
- `email` — **the old username if it contains an `@`**, normalized; otherwise **null**.
  Somebody who signed up with their address should not have to re-enter it, and inventing one
  for everybody else would either be wrong or would hand a login credential to whoever guessed
  the pattern. (If two legacy usernames normalize to the same address, the first keeps it and
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

## Storage

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

## New environment variables

All optional except the bootstrap pair on a fresh database. Full comments in `.env.example`.

| Variable | Default | Does |
|---|---|---|
| `DATABASE_PATH` | `./data/coc.db` | SQLite file for accounts and the shared data; directory created if absent |
| `ADMIN_EMAIL` | — | **Replaces `ADMIN_USERNAME`.** First admin's email when `users` is empty; *and* the escape hatch that fills in a missing email on an existing admin, without touching the password |
| `ADMIN_DISPLAY_NAME` | local part of `ADMIN_EMAIL` | Display name for the first admin, only while creating it. Never overwrites an existing account's name |
| `ADMIN_PASSWORD` | — | First admin's password, minimum 12 characters. Remove after the first boot. Ignored by the escape-hatch path |
| `COOKIE_SECURE` | off | Forces `Secure` on the session cookie when you terminate TLS but do not set `NODE_ENV` |
| `NODE_ENV` | — | `production` implies `COOKIE_SECURE` |
