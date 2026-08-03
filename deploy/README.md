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
