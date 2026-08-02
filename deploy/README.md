# Deploy

Config for hosting this app on a $6 DigitalOcean droplet (`146.190.196.236`),
**HTTPS only** — port 80 redirects and answers ACME challenges, and serves no
application traffic.

## You need a hostname first

A browser-trusted certificate cannot be issued for a bare IP address. Serving
the app on `146.190.196.236` alone would mean a self-signed certificate and a
click-through warning for every user, which trains people to dismiss TLS
warnings — worse than no TLS at all.

Any name pointing at the droplet works:

- a domain you own, or
- a free subdomain from a dynamic-DNS provider such as `duckdns.org`, which
  works with Let's Encrypt.

Point an `A` record at `146.190.196.236`, confirm it resolves, then substitute
that name for `coc.example.com` everywhere in `nginx-coc.conf`.

This matters because the app has real accounts: without TLS, passwords and
session cookies cross the network in clear text.

## Files

- `coc.service` — systemd unit for the Node/Hono API (runs `npm start`, which
  launches the server workspace via `tsx`).
- `nginx-coc.conf` — Nginx site: HTTPS on 443 serving the built SPA from
  `web/dist`, proxying `/api` to `127.0.0.1:8787`, with an HTTP server block
  that only redirects and serves ACME challenges.
- `.env.production.example` — template for `~/coc/.env` on the server.

## Sequence (on the droplet, as `jcc`)

```bash
# One-time prerequisites
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx certbot python3-certbot-nginx

# Firewall: 443 for the app, 80 for redirects and certificate renewal
sudo ufw allow 80,443/tcp && sudo ufw allow OpenSSH && sudo ufw enable

# Code
cd ~ && git clone <your-repo-url> coc && cd coc
npm install          # includes tsx (a runtime dep) — do NOT use --omit=dev

# Game art. Both are required BEFORE the build: the art is gitignored, and
# Vite copies web/public into dist. Skip these and the app works but is
# imageless. assets:wiki needs COC_API_TOKEN, so set .env up first.
cp deploy/.env.production.example .env
# edit .env: paste the CoC token minted for 146.190.196.236, set ADMIN_PASSWORD,
# and for now COMMENT OUT NODE_ENV=production (see the TLS note below)
set -a && . ./.env && set +a
npm run assets:coc && npm run assets:wiki
npm run build        # -> web/dist

# First admin
npm start            # creates the admin on first boot; Ctrl-C when you see it
# then remove ADMIN_PASSWORD from .env

# Service
sudo cp deploy/coc.service /etc/systemd/system/coc.service
sudo systemctl daemon-reload
sudo systemctl enable --now coc

# Certificate, then Nginx
sudo mkdir -p /var/www/certbot
sudo cp deploy/nginx-coc.conf /etc/nginx/sites-available/coc   # after editing the hostname
sudo ln -sf /etc/nginx/sites-available/coc /etc/nginx/sites-enabled/coc
sudo rm -f /etc/nginx/sites-enabled/default
chmod o+x /home/jcc
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
cd ~/coc && git pull && npm install
set -a && . ./.env && set +a && npm run assets:coc && npm run assets:wiki
npm run build && sudo systemctl restart coc
```

The asset scripts are cheap on a re-run — anything already on disk is skipped.

> `nginx-coc.conf` sets `client_max_body_size 10M` for the image-upload feature.
> If you raise it, raise the server-side limit to match rather than relying on
> Nginx alone.
