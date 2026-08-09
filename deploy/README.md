# Deploy

Config for hosting this app on a $6 DigitalOcean droplet, **HTTPS only** — port 80
redirects and answers ACME challenges, and serves no application traffic.

> This file's addresses, hostname and account name (`203.0.113.10`, `198.51.100.10`,
> `coc.example.com`, `deploy`) are placeholders — `203.0.113.0/24` and `198.51.100.0/24` are
> reserved by RFC 5737 for exactly this, and `example.com` by RFC 2606, so none of the three is
> ever a real, reachable host, and `deploy` names no one in particular. Substitute your own
> droplet's addresses, domain and account throughout. `nginx-coc.conf` and the systemd unit files
> in this directory are the actual files copied onto a running host, not documentation, so they
> still carry this deployment's real values, including the real account in each unit's `User=`
> line — replace those too before reusing them for a different host, but do not expect this
> prose to match them byte for byte. That includes the `sed` example below that edits
> `coc.service`'s `User=` line: it shows `deploy` for readability, but the line it is actually
> matching in the shipped unit file is the real account, not this placeholder.

## The droplet has two addresses, and they are not interchangeable

This is the one thing to get right, because getting it wrong breaks every game
lookup in production with a 403 and nothing else.

| Address | Which | Used for |
| --- | --- | --- |
| `203.0.113.10` | Reserved IP | **Inbound.** The `A` record for `coc.example.com`, and the address the certificate is issued against. |
| `198.51.100.10` | The droplet's own public IP | **Outbound.** What every request *leaving* the droplet appears to come from — including calls to the Clash of Clans API. |

A DigitalOcean reserved IP is an inbound mapping. Attaching one does not change
where the droplet's own traffic egresses from: that still leaves via its public
IPv4. So **the CoC API key must be minted for the outbound address**, not for the
one in DNS.

Supercell rejects a mismatch with `403 accessDenied.invalidIp` and names the
address it saw, which is the address to mint for. Confirm it from the droplet
itself:

```bash
curl -s https://api.ipify.org        # the address Supercell will see
```

If you would rather the key follow the reserved IP — worth it only if you expect to
rebuild the droplet and keep that IP as the stable identity — you have to force
egress through it with policy routing or SNAT on the droplet. That is a persistent
networking change that must survive reboots and can lock you out of SSH if it is
wrong. Minting the key for the public IP, or naming **both** addresses on one key,
costs a minute and carries no such risk.

## Hostname

The app is served at **`coc.example.com`**, whose `A` record already points at
`203.0.113.10`. That name is baked into `nginx-coc.conf` in four places —
`server_name` in both blocks and the two certificate paths — so changing it
means changing all of them.

A hostname is required rather than convenient: a browser-trusted certificate
cannot be issued for a bare IP, and the alternative — a self-signed certificate
— would put a click-through warning in front of every user, which teaches people
to dismiss TLS warnings and is worse than no TLS at all.

This matters because the app has real accounts: without TLS, passwords and
session cookies cross the network in clear text.

## Files

- `coc.service` — systemd unit for the Node/Hono API. Runs `tsx` directly (it used
  to go through `npm start`; npm wants a writable home directory, which the
  sandboxing below forbids) and is sandboxed with `ProtectSystem=strict`,
  `ProtectHome=true` and the rest.
- `coc-update.service` / `coc-update.timer` — the pull-based deploy: every five
  minutes the droplet checks `origin/main` and runs `update.sh` if it has moved.
  Sandboxed much more lightly, and the unit says why.
- `coc-progress-reference.service` / `.timer` and `coc-progress-snapshot.service` /
  `.timer` — the two weekly progress-tracking jobs, Tuesdays 16:00 and 17:00 UTC.
  Sandboxed as tightly as `coc.service` itself. See "Weekly progress-tracking
  jobs" below.
- `nginx-coc.conf` — Nginx site: HTTPS on 443 serving the built SPA from
  `web/dist`, proxying `/api` to `127.0.0.1:8787`, with an HTTP server block
  that only redirects and serves ACME challenges. Also carries the security
  headers and the two request-rate zones.
- `update.sh` — **is** the deploy. Also `--rollback`, `--resume` and `--force`.
- `update-test.sh` — tests for `update.sh`, against a throwaway tree with `sudo`,
  `npm`, `curl` and `rsync` stubbed. Run it before changing the deploy script:

  ```bash
  ./deploy/update-test.sh      # 113 checks, touches nothing real
  ```

- `nginx-test.sh` — serves `nginx-coc.conf` for real in a container and checks what
  it *does*: that the login throttle fires, that an ordinary page render is not
  throttled, that the security headers reach API responses as well as the SPA, and
  that the static-asset `Cache-Control` headers (`/assets/` cached long and
  immutable, `/coc/` game art cached for a day, `/` never cached) don't cost those
  same security headers on the way in — a location block that sets its own
  `add_header` stops inheriting the server block's entirely, which is exactly the
  kind of thing worth a real check rather than a read-through. Needs Docker, skips
  cleanly without it.

  ```bash
  ./deploy/nginx-test.sh       # 21 checks; `nginx -t` on the droplet is still the gate
  ```

- `.env.production.example` — template for `/srv/coc/.env` on the server.

## Sequence (on the droplet, as `deploy`)

```bash
# One-time prerequisites
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx certbot python3-certbot-nginx

# Firewall: 443 for the app, 80 for redirects and certificate renewal.
# The API's own port is deliberately absent: it binds 127.0.0.1, so it is not
# reachable from outside regardless — the firewall is the second lock, not the first.
sudo ufw allow 80,443/tcp && sudo ufw allow OpenSSH && sudo ufw enable

# Code — lives in /srv/coc (world-traversable, so no chmod on the app dir)
sudo mkdir -p /srv/coc && sudo chown deploy:deploy /srv/coc
git clone <your-repo-url> /srv/coc && cd /srv/coc
npm install          # includes tsx (a runtime dep) — do NOT use --omit=dev

# Environment
cp deploy/.env.production.example .env
chmod 600 .env       # NOT optional — see "The .env is a credential" below
# edit .env: paste the CoC token minted for the droplet's OUTBOUND IP — see the
# two-addresses note above; it is NOT the reserved IP — then set ADMIN_PASSWORD
# (fresh install only), set TRUST_PROXY=true (Nginx is in front), and for now
# COMMENT OUT NODE_ENV=production (TLS note below)

# Build — imageless for now; the art is fetched AFTER launch (see below)
npm run build        # -> web/dist (no art yet)

# First admin (fresh install only; skip if you migrated an existing DB)
npm start            # creates the admin on first boot; Ctrl-C when you see it
# then remove ADMIN_PASSWORD from .env

# Service
sudo cp deploy/coc.service /etc/systemd/system/coc.service
sudo systemctl daemon-reload
sudo systemctl enable --now coc

# Game art — MUST run on the droplet, AFTER launch: the CoC token is bound to
# this droplet's IP, so assets:coc 403s from anywhere else. Rebuild so Vite
# copies the fetched art (web/public/coc) into web/dist. assets:wiki optionally
# uses WIKI_CONTACT for a polite User-Agent.
set -a && . ./.env && set +a
npm run assets:coc && npm run assets:wiki
npm run build        # rebuild with art -> web/dist (served statically by Nginx)

# Certificate, then Nginx
sudo mkdir -p /var/www/certbot
sudo cp deploy/nginx-coc.conf /etc/nginx/sites-available/coc
sudo ln -sf /etc/nginx/sites-available/coc /etc/nginx/sites-enabled/coc
sudo rm -f /etc/nginx/sites-enabled/default
sudo certbot certonly --webroot -w /var/www/certbot -d coc.example.com
sudo nginx -t && sudo systemctl reload nginx

# NOW turn on the Secure cookie, once TLS actually works
# uncomment NODE_ENV=production in .env, then:
sudo systemctl restart coc
```

Then open `https://coc.example.com` and log in.

### Why `NODE_ENV=production` comes last

It marks the session cookie `Secure`, and a `Secure` cookie is never sent back
over plain http. Set it before the certificate is working and login fails
silently with nothing useful in the logs. Certificate first, then this.

### `TRUST_PROXY=true` is not cosmetic

Set it whenever Nginx is in front, and never when it is not.

The login rate limiter counts failures per client address, and it is the only real
bound on a request that costs the server ~40 ms of password hashing *whether or not
the account exists* — the equal cost is deliberate, and it is what stops a caller
telling a real account from a fake one by timing the answer. Behind a proxy the
socket address is the proxy's, so the client's address has to come from a header,
and the app has to be told the header is trustworthy:

| | behind Nginx | exposed directly |
| --- | --- | --- |
| `TRUST_PROXY=true` | correct — real client address, per-caller limits | broken — the caller sends the header, so it picks its own bucket and the limit never fires |
| unset | degraded — every caller looks like the proxy, shares one bucket, so one person's failures lock out everybody | correct — the socket address is the real one |

The app defaults to off, which fails in the safe direction. Nginx sets `X-Real-IP`
and appends the real peer to `X-Forwarded-For`; the app prefers the former and reads
the **last** hop of the latter. It used to read the first hop — the part a client
supplies — which meant the per-address limit could be sidestepped by sending a
header, and that is the finding this setting exists to close.

### The `.env` is a credential

`chmod 600 /srv/coc/.env`. It holds the CoC API token, and on a fresh install the
first admin password. It was mode `644` — readable by every account on the box —
and the app directory being world-traversable by design is exactly why the file
itself has to be closed:

```bash
chmod 600 /srv/coc/.env
ls -l /srv/coc/.env          # -rw------- 1 deploy deploy
```

The systemd unit also sets `UMask=0077`, so the SQLite database and its WAL are
created owner-only from now on. Files created before that keep their old mode:

```bash
chmod 600 /srv/coc/server/data/coc.db*
chmod 700 ~/coc-backups          # password hashes, and until recently live session tokens
```

## Renewal

`certbot` installs a systemd timer that renews automatically. Two things break
it silently:

- **Blocking port 80.** HTTP-01 renewal needs it reachable. The failure surfaces
  as an expired certificate roughly 60 days later, not as an error today. Use
  DNS-01 if you want 80 closed.
- **Nginx not reloading** after renewal, so it keeps serving the old cert.

Check both with `sudo certbot renew --dry-run`.

## Updating

```bash
cd /srv/coc && git pull && npm install     # npm as the owning user, never with sudo
set -a && . ./.env && set +a && npm run assets:coc && npm run assets:wiki
npm run build && sudo systemctl restart coc
```

The asset scripts are cheap on a re-run — anything already on disk is skipped.

Then **verify you are serving what you just built**, because three things can leave the
site on an older version even when every command above succeeds:

```bash
curl -s https://coc.example.com/ | grep -oE 'assets/index-[^"]+'   # what the browser gets
ls web/dist/assets/                                              # what you just built
git log --oneline -1                                             # what you built it from
```

Those two filenames must match. Vite names bundles by content hash, so a given commit
always produces the same filename — which makes the pair a reliable fingerprint.

**Check the artwork on disk, never over HTTP.** Nginx falls back to `index.html` for any
path it cannot find — that is what makes client-side routing work, and it means *every*
request returns 200, including one for art that is not there. A status check therefore
proves nothing about the images:

```bash
# useless — 200 whether the file exists or not
curl -s -o /dev/null -w '%{http_code}\n' https://coc.example.com/coc/cards/anything.png

# what actually distinguishes them
curl -s -o /dev/null -w '%{content_type}  %{size_download}\n' \
  https://coc.example.com/coc/cards/elixir_01_barbarian.png
#   image/png  85694   -> present
#   text/html  1150    -> missing; that is index.html, and 1150 bytes is its size
```

Take filenames from the host rather than guessing: cards are named like
`dark_elixir_20_minion.png`, and league and label icons are numeric ids like
`29000000.png`. A guessed name gives exactly the same 200-and-HTML answer as genuinely
missing art, which reads as a fault that is not there.

The three traps, in the order they are likely:

1. **A stale Nginx config.** `git pull` updates `deploy/nginx-coc.conf` in the repo and
   nothing in `/etc/nginx/`. If that file has changed since you installed it — the
   served `root` moved from a home directory to `/srv/coc`, for instance — Nginx keeps
   serving the old path, and an old checkout there keeps working perfectly. Check with
   `grep -n root /etc/nginx/sites-enabled/coc`, and if it is wrong:

   ```bash
   sudo cp deploy/nginx-coc.conf /etc/nginx/sites-available/coc
   sudo nginx -t && sudo systemctl reload nginx
   ```

   `nginx -t` first, always: it refuses a broken config instead of dropping the site.

2. **A pull that did not land.** `git status -sb` shows a detached HEAD, another branch,
   or local edits blocking the merge. The build then succeeds against old sources.

3. **A build with no art.** `web/public/coc/` is gitignored, so a fresh clone has none of
   it and `npm run build` copies nothing into `dist`. The directory does not exist at all
   on a fresh clone — git cannot track an empty one, which is why `web/public/.gitkeep`
   is tracked — so the copy has somewhere to land:

   ```bash
   mkdir -p /srv/coc/web/public          # only needed on a clone that predates .gitkeep
   ```

   A complete tree is ~10 MB in 288 files, from three different sources:

   ```bash
   npm run assets:coc     # clan badges, league icons, labels — needs a working token
   npm run assets:wiki    # troop, spell, hero and Town Hall art
   # card portraits: copied to the host by hand, from neither the API nor the wiki
   ```

   Check all four directories before building — a missing one is 60 broken tiles, not
   an error:

   ```bash
   ls web/public/coc/cards/*.png | wc -l    # 60
   du -sh web/public/coc/*                  # cards, labels, leagues, wiki
   ```

4. **A development build.** `vite build` takes its mode from the environment, so a shell
   that has sourced an `.env` exporting `NODE_ENV=development` produces a *development*
   React — nearly twice the bytes, dev-only warnings, none of the production fast paths.
   It works, which is why it went unnoticed in production for a day. The build script now
   forces `NODE_ENV=production` so the host environment cannot decide this, but the size
   is the tell if it ever regresses: the JS bundle is ~327 kB, not ~616 kB.

Restarting the service is also what applies any pending schema migration, so there is no
separate migrate step. Back the database up first — all three files, since copying only
the `.db` leaves whatever is still in the WAL behind:

```bash
cp server/data/coc.db* ~/backup-$(date +%F)/
```

> `nginx-coc.conf` sets `client_max_body_size 10M` as a plain ceiling on request
> bodies — nothing the app serves comes close. The app now enforces its own,
> smaller limit as well (a request-size check on `/api/*` in `server/src/app.ts`),
> which is what the older version of this note asked for and could not point at.
> The inner limit is the tighter of the two, so raising the Nginx one alone changes
> nothing.

## Hardening

Everything in this section is applied by copying files this repo already contains.
None of it is optional-but-nice; each item closes something a review found.

### Read this before the first restart: three migrations run, and one signs everyone out

Restarting the service is what applies pending migrations, and this change carries
three. Production is at **v7**; the head is **v10**.

| | What it does | What you will notice |
| --- | --- | --- |
| **v8** | Re-keys `sessions` on `sha256(token)` instead of the token itself, and **deletes every existing session row** | **Everybody signs in again, once.** |
| **v9** | Drops the unused `chat_messages` table | Nothing. It had no reader anywhere in the app. |
| **v10** | Adds the append-only `auth_events` table | Nothing yet; it starts recording from that boot. |

**The sign-out is the point of v8, not a side effect.** The old rows *are* bearer
tokens: anyone who could read `coc.db` — or any of the twenty unencrypted copies in
`~/coc-backups` — held working 30-day sessions for every account. Rehashing them in
place would have kept exactly those tokens valid, so they go. Tell people, or ten
users hit a login screen with no explanation.

Back up first, as always, and note that the backup is also your only way back: a
migration only moves forward, so `./deploy/update.sh --rollback` restores the *code*
and leaves the schema at v10.

```bash
sqlite3 /srv/coc/server/data/coc.db "PRAGMA user_version;"   # 7 before, 10 after
sudo systemctl restart coc
journalctl -u coc -n 20 --no-pager    # the startup line names the schema version
```

The startup line now also reports the bound address and whether forwarded headers
are trusted, e.g. `API listening on http://127.0.0.1:8787 (cache TTL 60s, db
/srv/coc/server/data/coc.db at schema v10, trusting forwarded headers)`. If it says
*ignoring* forwarded headers on the droplet, `TRUST_PROXY=true` is missing from
`/srv/coc/.env` — see below for why that matters.

One thing v8 does **not** fix: those backups still contain password hashes and every
row of shared data. `chmod 700 ~/coc-backups` is the floor; encrypting them is a
separate job.

### The service is sandboxed now

`coc.service` gained `ProtectSystem=strict`, `ProtectHome=true`, `NoNewPrivileges`,
an empty capability set, a syscall filter and `UMask=0077`. Two consequences worth
knowing before you install it:

- **`ExecStart` no longer goes through npm.** It calls `tsx` directly, because npm
  wants a writable home directory for its cache and log files and `ProtectHome=true`
  denies that. It is the same command npm was running.
- **`ProtectHome=true` is the point of the exercise.** The service runs as
  `deploy`, a human account with an `~/.ssh` in it. The app never needed a home
  directory, and now it cannot read one.

`MemoryDenyWriteExecute` is deliberately absent, and the unit says so in place: V8
writes and then executes its own JIT output, so setting it gives a crash loop whose
message points nowhere near systemd.

```bash
sudo cp deploy/coc.service /etc/systemd/system/coc.service
sudo cp deploy/coc-update.service /etc/systemd/system/coc-update.service
sudo systemctl daemon-reload
sudo systemctl restart coc

# Prove it came back before you walk away
systemctl is-active coc
curl -fsS http://127.0.0.1:8787/api/health && echo

# And that the database is still writable through the sandbox — a read-only
# ReadWritePaths mistake looks fine until somebody tries to save a card count
journalctl -u coc -n 30 --no-pager

# What the sandbox is actually worth
systemd-analyze security coc.service | head -20
```

If the service fails to start, the sandbox is the first suspect and
`ReadWritePaths` is the first line to check: it names `/srv/coc/server/data`, which
is where `DATABASE_PATH` resolves to given `WorkingDirectory=/srv/coc/server`. Move
the database and that line has to move with it.

The update unit is sandboxed far more lightly, on purpose. It runs `git`, `npm` and
`sudo systemctl restart` — and `NoNewPrivileges=true` would break the `sudo`, which
is the whole restart step. The unit lists which settings it cannot have and why.

### A dedicated service user

The stronger version of the above, and the one thing here that is not just a file
copy: run the app as an account that owns nothing but the app.

```bash
sudo useradd --system --home-dir /srv/coc --shell /usr/sbin/nologin coc
sudo chown -R coc:coc /srv/coc/server/data
sudo chown coc:coc /srv/coc/.env          # it is read by the service, not by you
sudo sed -i 's/^User=deploy$/User=coc/' /etc/systemd/system/coc.service
sudo systemctl daemon-reload && sudo systemctl restart coc
curl -fsS http://127.0.0.1:8787/api/health && echo
```

Two things this does **not** move, deliberately: the deploy still runs as `deploy`
(it needs to write the checkout and hold the git credentials), and `~/coc-backups`
stays that user's. So `coc` gets the database and the token and nothing else.

`User=` is left as `deploy` in the committed unit rather than pre-switched, because
copying a unit whose `User=` does not own the data directory starts a server that
cannot write — a failure that looks like a code bug.

### Nginx: headers and rate limits

`nginx-coc.conf` gained a Content-Security-Policy, `server_tokens off`, a year-long
HSTS (it was a day, as a deliberate starting point), and **two request-rate zones**.
The login one is the important one: unthrottled login attempts are a denial of
service, because each costs the single-threaded server ~40 ms of scrypt and the
app's own per-email limiter is bypassed by rotating throwaway addresses. The file
explains the arithmetic where the zones are declared.

```bash
sudo cp deploy/nginx-coc.conf /etc/nginx/sites-available/coc
sudo nginx -t                     # ALWAYS first: it refuses a broken config
sudo systemctl reload nginx       # only if -t passed
```

`nginx -t` is not a formality here. The `limit_req_zone` directives sit at file
scope because they are only valid in the `http` context, and this file is included
from inside it — a detail that is either right or the whole config is rejected.

That much has been checked: `./deploy/nginx-test.sh` serves this config unedited
against nginx 1.30.4 and asserts the behavior, not just the syntax. It measured one
thing worth knowing — `burst=5` admits **six** attempts back to back, not five,
because nginx allows the burst plus the one the rate itself permits. `nginx -t` on
the droplet is still the gate, because the droplet's nginx version and the real
certificate paths are the two things a container cannot stand in for.

Then confirm the headers are actually being sent, and that a real login still works:

```bash
curl -sI https://coc.example.com/ | grep -iE 'content-security-policy|strict-transport|x-frame|x-content|referrer'

# The login throttle: the 6th request inside a minute should be 429, not 401
for i in $(seq 1 7); do
  curl -s -o /dev/null -w "$i:%{http_code} " -X POST https://coc.example.com/api/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"wrong-on-purpose"}'
done; echo
```

Expect `1:401 … 6:401 7:429` — six attempts through, then the zone. (Six, not five:
see the note above.) **Then wait a minute before signing in yourself**, or the
throttle you just proved works will meet you at the door.

If the CSP breaks an image or a style, the browser console names the directive and
the blocked URL. The likely candidate is `img-src`: clan badges come from
API-supplied CDN URLs, and any league or label icon newer than the last
`npm run assets:coc` falls back to the same host.

### Offsite backups

`update.sh` keeps a generational set of database backups in `~/coc-backups`: the three
most recent days that have one, then a weekly and a monthly promoted out of what is
already there. A quiet week does not burn a slot — the window is the last three days
that *have* a backup, not the last three on the calendar — and nothing is duplicated,
so the whole policy is re-derivable from the directory with no state file. It replaces
a flat "keep the newest twenty", which held a fortnight of one busy period and nothing
older. `./deploy/update.sh --prune-backups DIR` runs the same rotation against a named
directory, which is how the test harness exercises it.

That protects against a bad migration and against nothing else — losing the droplet
loses the accounts and the whole card season. Set `BACKUP_REMOTE` in `/srv/coc/.env` to
any rsync destination and each backup is copied there too:

```bash
# in /srv/coc/.env
BACKUP_REMOTE=backup@example.com:/srv/coc-backups/
```

A failure warns and lets the deploy continue: an unreachable backup host is not a
reason to stop shipping, and dying at that point would leave the tree pulled and the
service un-restarted. The backup contains password hashes, so send it somewhere you
would be comfortable storing those, and `chmod 700` the destination.

### Monitoring

Nothing on the droplet notices that the droplet is down, and nothing can: the failures
worth catching are the ones where it is off, unreachable, or its Nginx is not
answering, and a local check is down in every one of them. So monitoring lives
somewhere else, in two halves.

**`.github/workflows/monitor.yml`, which is in this repository and needs nothing set
up.** It runs on GitHub's runners — the one piece of infrastructure this project
already has that is not the droplet.

| | when | what it does |
| --- | --- | --- |
| `liveness` | every 30 min | `/api/health` must answer valid JSON with `ok: true`, the deployed commit it reports (if any) must not be stuck behind `main`, the page must reference a built JS bundle, and every request is made without `-k` so an invalid certificate fails it. Three attempts 20s apart before the JSON check concludes anything. |
| `certificate` | daily, 07:12 UTC | Fails at **under 21 days** remaining, and again more urgently under 7. |

The certificate half is the reason this is worth having in the repo rather than only
in an uptime service. It is a documented failure mode here rather than a hypothesis:
HTTP-01 renewal needs port 80 reachable, so a blocked port 80 becomes an expired
certificate about 60 days later — silently, because nothing is wrong today. certbot
renews at 30 days remaining, so 21 means the renewal *did not run* and there are three
weeks to find out why.

**The deployed-commit half exists because liveness alone missed a real incident.**
`coc-update.timer` fast-forwards to `origin/main` every five minutes, and a
`git filter-repo` history rewrite once left the droplet's clone unable to do that —
`git merge --ff-only` refused forever, silently, while `coc.service` stayed up the
whole time serving 13-commits-stale code. Liveness can never catch that shape of
failure, because the service was never down. The fix is to compare what is actually
running against `main`: `/api/health`'s optional `commit` field
([docs/api.md](../docs/api.md)) names the commit `.deploy-last-good-sha` last
confirmed live — written only after a deploy's build and health check both pass, so
unlike raw git HEAD it cannot lie about a deploy that advanced the tree but never
restarted the service (the "fast-forward happens before `npm ci`" trap above). The
workflow compares that commit against `main` via GitHub's compare API: `identical` is
fine, `ahead` is fine for a while (the timer's own five minutes plus however long a
build takes — the check only fails an `ahead` state once the oldest undeployed commit
is over 20 minutes old), and `diverged`, `behind`, or a 404 (the deployed commit is
unknown to GitHub — exactly what a rewritten history looks like) fail immediately,
since none of those three recovers on its own. The failure message gives the fix
directly:

```bash
ssh deploy@203.0.113.10 'cd /srv/coc && git fetch origin main && git reset --hard origin/main && ./deploy/update.sh --force'
```

Two constraints shaped it, and both are worth knowing before changing the cadence:

- **This repository is private, so Actions minutes are metered.** A five-minute check
  is roughly 8,600 minutes a month against a 2,000 free allowance. 30 minutes is
  ~1,440, which fits alongside the verify workflow. That is the only reason liveness is
  not more frequent.
- **Noise is the failure mode.** This project already deleted a workflow that failed
  on every push and emailed each time — noise that trains you to ignore the one signal
  the workflow exists for. Hence the retries, and hence the certificate check running
  daily: an expiry warning delivered 48 times a day is not lead time, it is a filter
  rule waiting to happen.

Also know: **GitHub disables scheduled workflows after 60 days of repository
inactivity**, and scheduled runs can be delayed by tens of minutes when the platform
is busy. Fine for "tell me before the users do"; not a pager.

**The second half is a free uptime service, and it is the one to add if you only do
one thing.** A minute-by-minute check that pages a phone is what Actions cannot be at
this budget, and it takes about two minutes to set up: point any of the free tiers at
`https://coc.example.com/api/health`, expect HTTP 200 containing `ok`, and send alerts
wherever you actually look. Nothing needs to change on the droplet — `/api/health` is
public precisely so a probe can reach it, and it answers without a session (the cache
size is only added for a signed-in caller).

A dead-man's switch is the third option and catches a class the other two do not — the
droplet being powered off, or off the network entirely, rather than merely answering
wrongly. It inverts the direction: the droplet pings a URL on a timer and the service
alerts when the pings *stop*. Worth it only if you have been bitten by that specific
failure.

Run either job by hand from the Actions tab, or:

```bash
gh workflow run monitor.yml        # runs liveness and the certificate check together
```

## Automating it

`deploy/update.sh` **is** the deploy. Run it by hand, from a timer, or from CI — it
behaves identically, because all the judgment lives in the script rather than in
whatever triggered it.

```bash
cd /srv/coc && ./deploy/update.sh            # deploy if origin/main has moved
cd /srv/coc && ./deploy/update.sh --force    # rebuild and restart regardless
cd /srv/coc && ./deploy/update.sh --rollback # back to the last commit that deployed cleanly
cd /srv/coc && ./deploy/update.sh --resume   # clear the hold a rollback left
```

Safe to run repeatedly: with nothing new upstream it prints one line and exits 0,
which is what makes it usable on a timer.

### It deploys from a copy of itself

The first thing `update.sh` does is copy itself into `$TMPDIR` and re-exec `bash` on the
copy, passing your arguments through. Every run except `--prune-backups` does it, and
the log says so:

```
    running from a temporary copy, so the pull cannot rewrite it: /tmp/coc-update.hT9wKx
```

The reason is that the deploy rewrites `deploy/update.sh` — that is what pulling a
commit which touched the deploy script *means* — and bash does not read a script into
memory before running it. It reads a bufferful at a time and keeps a byte offset into
the open file. Replace the file underneath a running bash and the next bufferful comes
back from the new content at the old offset, which is the middle of some unrelated
statement. The script then runs fragments of itself, or reaches the end early and exits
0 having skipped the build and the restart entirely. Serving old code while reporting
success is the one outcome this script is written to prevent, so it does not leave that
to chance.

Practical notes:

- The copy is deleted when the run ends, including when it fails. Under systemd it
  lands in the unit's `PrivateTmp` namespace, which nothing else on the host can see
  and which systemd discards when the unit finishes.
- If the copy cannot be made, the deploy **refuses**. It does not fall back to running
  from the checkout.
- `--prune-backups` skips it. That mode runs no git command, so there is nothing to
  protect it from.
- This also covers you when *you* are the one replacing the file: `cp`, `scp` or
  `rsync --inplace` of a new `update.sh` onto the droplet truncates the existing file
  rather than replacing it, and the five-minute timer does not know you are mid-copy.

`update-test.sh` proves the mechanism rather than arguing about it: it builds a
throwaway script that rewrites itself part way through, shows it executing a fragment
of the replacement and never reaching its own last line, and then shows the same script
completing normally with `update.sh`'s re-exec preamble in front of it.

### Rolling back

Until recently there was no rollback, and recovery from a bad commit was another
commit. With a timer that deploys `origin/main` unreviewed within five minutes, that
is a thin plan.

Each successful deploy now records its commit in `.deploy-last-good-sha` — recorded
only after the service came back and answered a health check, which is the only
definition of "good" the script can actually observe. `--rollback` returns to it:

```bash
cd /srv/coc && ./deploy/update.sh --rollback
```

It backs the database up first, resets the tree to that commit, rebuilds, restarts
and re-verifies the served bundle — the same path a forward deploy takes, because a
rollback that went a different way to production would be a second deploy mechanism,
tested even less than the first.

**Then it writes `.deploy-hold`, and this is the part that makes it work.** Without
it the timer would fast-forward straight back onto the commit you just rolled back,
five minutes later — which is exactly how a rollback comes to feel like it did
nothing. While the hold is in place every timer run prints one line and exits
without so much as fetching.

So the full recovery is:

```bash
./deploy/update.sh --rollback   # site is good again, host is held
# ...fix the bug, push it to main...
./deploy/update.sh --resume     # clears the hold and deploys what is now on main
```

Two limits worth stating plainly. `--rollback` goes back exactly one good release,
not two — a second run reports "already on the last good commit" rather than walking
backwards through history unattended; go further by hand with
`git reset --hard <sha> && ./deploy/update.sh --force`. And it rolls back **code, not
data**: a migration that already ran stays applied, because migrations only move
forward. If the bad commit migrated the schema, the rollback target is the backup
in `~/coc-backups` taken moments before it, not the git history.

All of this is covered by `./deploy/update-test.sh`, including that a held host
really does nothing and that `--resume` picks the fix up.

### What it refuses to do

It checks outcomes rather than exit codes, because every fault this deployment
actually hit let each individual command succeed. It aborts **before touching
anything** if:

- the checkout is not on `main`, or `main` does not track `origin/main` — the stale-branch outage
- the tree has uncommitted changes, so the deploy could not be reproduced from the commit
- the card art is not exactly 60 images, or an art directory is missing
- `main` has diverged from the remote (`--ff-only`, so it never writes a merge commit on the server)
- it cannot copy itself into `$TMPDIR` first — see "It deploys from a copy of itself" above

**One exception, and only one.** A locally modified `package-lock.json` is restored rather
than treated as a blocker. `npm ci` never writes that file, so a modified one can only
have come from someone running `npm install` by hand, and the committed lockfile is
authoritative regardless. Left to fail, a single stray `npm install` would stop every
unattended deploy from then on and the timer would go quietly dead. The exception is an
exact match on that one path: a dirty lockfile *plus* anything else still aborts, and
lists both.

After building it checks that the bundle **the site is actually serving** is the one
just built — the only test that catches Nginx pointing at a different directory. It
also warns above 450 kB, the signature of a development React.

If the build fails or the API does not come back healthy, the previous `web/dist` is
restored, so the site is left as it was.

Two things it deliberately does not do: it never runs `git clean` (that would delete
the gitignored artwork and the `.env`), and it never installs the Nginx config. Config
drift is *reported* with the command to apply it, because a deploy that can rewrite
the TLS config has a larger blast radius than the problem it solves.

### What CI does, and does not, do

`.github/workflows/verify.yml` typechecks, tests and builds every push and pull
request. **It does not deploy.** It exists for the one thing the timer cannot do: tell
you a commit is broken before you notice it in production.

It briefly had a second job that SSHed in and deployed, and that was a mistake here.
The deploy secrets were never set, so the job failed within five seconds of every push
and emailed a failure notice each time — noise that trains you to ignore the signal the
workflow is for. A dormant second deploy path earns nothing and costs attention.

If you do want push-triggered deployment later, it is a job that writes a private key
from a secret, pins `known_hosts`, and runs `ssh user@host 'cd /srv/coc &&
./deploy/update.sh'` — gated on the verify job. It needs a dedicated key, four
repository secrets, and the sudoers rule below. The version that did this is in git
history at `5e6c1b2`. The trade is that port 22 must be reachable from GitHub's
runners, which use a wide and changing set of addresses, and a key for your server then
lives in a third-party service.

### Or trigger on a timer — no secrets, nothing exposed

```bash
sudo cp deploy/coc-update.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now coc-update.timer
systemctl list-timers coc-update     # when it next fires
journalctl -u coc-update -n 40       # what the last run did
```

The droplet checks every five minutes and pulls when there is something to pull. No
private key leaves your machine, nothing is held by a CI provider, and SSH need not be
reachable from the internet at all. The cost is up to five minutes of latency.

**The timer is the deploy path.** For ten users, immediacy is worth less than not
having a deploy key for your server sitting in a third-party service. Note what that
costs: the timer will happily deploy a commit whose tests fail. CI tells you the commit
was broken, but it does not stop the timer — so if the verify workflow goes red, push
the fix rather than assuming production is protected.

### Either way, one sudoers rule

The script restarts a service, so it needs passwordless `sudo` for exactly that:

```bash
sudo visudo -f /etc/sudoers.d/coc-deploy
# deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart coc, /usr/bin/systemctl reload nginx
sudo -n systemctl restart coc     # must not prompt
```

Narrow it to those commands. A blanket `NOPASSWD: ALL` would make the deploy key — or
a compromised CI job — equivalent to root.

## Weekly progress-tracking jobs

Two more oneshot units, on the same pull-based-timer pattern as `coc-update` above
but unrelated to it — these keep the base-progress feature's data current rather
than deploying anything, and neither runs `git`, `npm` or `sudo`.

- **`coc-progress-reference.service` / `.timer`** — runs
  `server/src/progress/refresh-reference.ts`, which re-scrapes
  `clashofclans.fandom.com` for the current max-level and wall reference tables.
  Fires **Tuesdays 16:00 UTC**.
- **`coc-progress-snapshot.service` / `.timer`** — runs
  `server/src/progress/capture-snapshot.ts`, the weekly auto-capture of
  TH/heroes/equipment/pets/troops/spells for every owned base, against the live
  Clash of Clans API. Fires **Tuesdays 17:00 UTC**, an hour after the reference
  refresh above.

The order is not arbitrary: the snapshot job classifies a troop as a pet by
looking its name up in `max_level_reference` (`petNamesFromReference`,
`server/src/progress/capture-snapshot.ts`) — the table the reference job
populates. Running reference first means that lookup is current before the
snapshot reads it, rather than a week stale. An empty pet table is a harmless
bootstrap gap on the very first run (everything classifies as a troop until the
first reference refresh completes) but would be a recurring one every week if
the jobs ran in the other order, or too close together to reliably serialize.

Both units are sandboxed the same way `coc.service` is (`ProtectSystem=strict`,
`NoNewPrivileges=true`, the same `Restrict*`/`Protect*` block) rather than
`coc-update.service`'s lighter tier, because neither needs `sudo` — they are
read-then-write jobs against the same SQLite file `coc.service` owns, calling
either the CoC API or the wiki's API outbound, and nothing else. Both also use
`WorkingDirectory=/srv/coc/server`, for the identical reason `coc.service` does:
`DATABASE_PATH` defaults to `./data/coc.db`, which only resolves to the real
database from that directory.

```bash
sudo cp deploy/coc-progress-reference.{service,timer} /etc/systemd/system/
sudo cp deploy/coc-progress-snapshot.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now coc-progress-reference.timer
sudo systemctl enable --now coc-progress-snapshot.timer

# When each last/next ran
systemctl list-timers 'coc-progress-*'

# What the last run did
journalctl -u coc-progress-reference -n 40
journalctl -u coc-progress-snapshot -n 40

# Run one by hand, off-schedule, without waiting for Tuesday
sudo systemctl start coc-progress-reference
sudo systemctl start coc-progress-snapshot
```

Both `OnCalendar` lines are `UTC`-qualified explicitly — systemd calendar events
are local time otherwise, which would drift the schedule with the host's
timezone and DST. Verify the syntax before relying on it:

```bash
systemd-analyze calendar 'Tue *-*-* 16:00:00 UTC'
systemd-analyze calendar 'Tue *-*-* 17:00:00 UTC'
```

Like `coc-update.timer`, both carry `Persistent=true`: a missed window (the
droplet was off at 16:00 or 17:00 Tuesday) fires once on the next boot rather
than waiting a full week for the next occurrence.
