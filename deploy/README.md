# Deploy

Config for hosting this app on a $6 DigitalOcean droplet (`146.190.196.236`),
**HTTPS only** — port 80 redirects and answers ACME challenges, and serves no
application traffic.

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
# edit .env: paste the CoC token minted for 146.190.196.236, set ADMIN_PASSWORD
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
cd /srv/coc && git pull && npm install
set -a && . ./.env && set +a && npm run assets:coc && npm run assets:wiki
npm run build && sudo systemctl restart coc
```

The asset scripts are cheap on a re-run — anything already on disk is skipped.

> `nginx-coc.conf` sets `client_max_body_size 10M` as a plain ceiling on request
> bodies — nothing the app serves comes close. If a route ever needs more, raise
> the server-side limit to match rather than relying on Nginx alone.
