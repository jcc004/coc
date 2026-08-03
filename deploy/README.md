# Deploy

Config for hosting this app on a $6 DigitalOcean droplet, **HTTPS only** — port 80
redirects and answers ACME challenges, and serves no application traffic.

## The droplet has two addresses, and they are not interchangeable

This is the one thing to get right, because getting it wrong breaks every game
lookup in production with a 403 and nothing else.

| Address | Which | Used for |
| --- | --- | --- |
| `146.190.196.236` | Reserved IP | **Inbound.** The `A` record for `coc.jcciv.com`, and the address the certificate is issued against. |
| `192.81.212.182` | The droplet's own public IP | **Outbound.** What every request *leaving* the droplet appears to come from — including calls to the Clash of Clans API. |

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

The app is served at **`coc.jcciv.com`**, whose `A` record already points at
`146.190.196.236`. That name is baked into `nginx-coc.conf` in four places —
`server_name` in both blocks and the two certificate paths — so changing it
means changing all of them.

A hostname is required rather than convenient: a browser-trusted certificate
cannot be issued for a bare IP, and the alternative — a self-signed certificate
— would put a click-through warning in front of every user, which teaches people
to dismiss TLS warnings and is worse than no TLS at all.

This matters because the app has real accounts: without TLS, passwords and
session cookies cross the network in clear text.

## Files

- `coc.service` — systemd unit for the Node/Hono API (runs `npm start`, which
  launches the server workspace via `tsx`).
- `nginx-coc.conf` — Nginx site: HTTPS on 443 serving the built SPA from
  `web/dist`, proxying `/api` to `127.0.0.1:8787`, with an HTTP server block
  that only redirects and serves ACME challenges.
- `.env.production.example` — template for `/srv/coc/.env` on the server.

## Sequence (on the droplet, as `crighjc`)

```bash
# One-time prerequisites
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx certbot python3-certbot-nginx

# Firewall: 443 for the app, 80 for redirects and certificate renewal
sudo ufw allow 80,443/tcp && sudo ufw allow OpenSSH && sudo ufw enable

# Code — lives in /srv/coc (world-traversable, so no chmod on the app dir)
sudo mkdir -p /srv/coc && sudo chown crighjc:crighjc /srv/coc
git clone <your-repo-url> /srv/coc && cd /srv/coc
npm install          # includes tsx (a runtime dep) — do NOT use --omit=dev

# Environment
cp deploy/.env.production.example .env
# edit .env: paste the CoC token minted for the droplet's OUTBOUND IP — see the
# two-addresses note above; it is NOT the reserved IP — then set ADMIN_PASSWORD
# (fresh install only), and for now COMMENT OUT NODE_ENV=production (TLS note below)

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
sudo certbot certonly --webroot -w /var/www/certbot -d coc.jcciv.com
sudo nginx -t && sudo systemctl reload nginx

# NOW turn on the Secure cookie, once TLS actually works
# uncomment NODE_ENV=production in .env, then:
sudo systemctl restart coc
```

Then open `https://coc.jcciv.com` and log in.

### Why `NODE_ENV=production` comes last

It marks the session cookie `Secure`, and a `Secure` cookie is never sent back
over plain http. Set it before the certificate is working and login fails
silently with nothing useful in the logs. Certificate first, then this.

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
curl -s https://coc.jcciv.com/ | grep -oE 'assets/index-[^"]+'   # what the browser gets
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
curl -s -o /dev/null -w '%{http_code}\n' https://coc.jcciv.com/coc/cards/anything.png

# what actually distinguishes them
curl -s -o /dev/null -w '%{content_type}  %{size_download}\n' \
  https://coc.jcciv.com/coc/cards/elixir_01_barbarian.png
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
> bodies — nothing the app serves comes close. If a route ever needs more, raise
> the server-side limit to match rather than relying on Nginx alone.

## Automating it

`deploy/update.sh` **is** the deploy. Run it by hand, from a timer, or from CI — it
behaves identically, because all the judgement lives in the script rather than in
whatever triggered it.

```bash
cd /srv/coc && ./deploy/update.sh          # deploy if origin/main has moved
cd /srv/coc && ./deploy/update.sh --force  # rebuild and restart regardless
```

Safe to run repeatedly: with nothing new upstream it prints one line and exits 0,
which is what makes it usable on a timer.

### What it refuses to do

It checks outcomes rather than exit codes, because every fault this deployment
actually hit let each individual command succeed. It aborts **before touching
anything** if:

- the checkout is not on `main`, or `main` does not track `origin/main` — the stale-branch outage
- the tree has uncommitted changes, so the deploy could not be reproduced from the commit
- the card art is not exactly 60 images, or an art directory is missing
- `main` has diverged from the remote (`--ff-only`, so it never writes a merge commit on the server)

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

### Trigger on push — GitHub Actions

`.github/workflows/deploy.yml` runs typecheck, tests and a build on every push, and
only if all three pass does it SSH in and run the script. Setup — a dedicated key,
four repository secrets including a pinned `known_hosts`, and the sudoers rule below —
is in the comment block at the top of that file.

The trade: port 22 has to be reachable from GitHub's runners, which use a wide and
changing set of addresses.

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

**For ten users the timer is the better trade** — immediacy is worth less than not
having a deploy key for your server sitting in a third-party service. Actions earns
its keep only for the test gate, which is a real advantage: the timer will happily
deploy a commit whose tests fail.

### Either way, one sudoers rule

The script restarts a service, so it needs passwordless `sudo` for exactly that:

```bash
sudo visudo -f /etc/sudoers.d/coc-deploy
# crighjc ALL=(root) NOPASSWD: /usr/bin/systemctl restart coc, /usr/bin/systemctl reload nginx
sudo -n systemctl restart coc     # must not prompt
```

Narrow it to those commands. A blanket `NOPASSWD: ALL` would make the deploy key — or
a compromised CI job — equivalent to root.
