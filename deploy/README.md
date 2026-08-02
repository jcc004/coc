# Deploy

Config for hosting this app on a $6 DigitalOcean droplet, HTTP over the bare
IP (`146.190.196.236`), no domain. Full walkthrough is in
`CoC-DigitalOcean-Deployment.docx`.

## Files

- `coc.service` — systemd unit for the Node/Hono API (runs `npm start`, which
  launches the server workspace via `tsx`).
- `nginx-coc.conf` — Nginx site: serves the built SPA from `web/dist` and
  proxies `/api` to the Node server on `127.0.0.1:8787`.
- `.env.production.example` — template for `~/coc/.env` on the server.

## Quick sequence (on the droplet, as `jcc`)

```bash
# One-time prerequisites
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx

# Code + build
cd ~ && git clone <your-repo-url> coc && cd coc
npm install          # includes tsx (runtime dep) — do NOT use --omit=dev
npm run build        # -> web/dist

# Environment
cp deploy/.env.production.example .env
# edit .env: paste the CoC token for 146.190.196.236, set ADMIN_PASSWORD
npm start            # creates the admin on first boot; Ctrl-C when you see it
# then remove ADMIN_PASSWORD from .env

# Service
sudo cp deploy/coc.service /etc/systemd/system/coc.service
sudo systemctl daemon-reload
sudo systemctl enable --now coc

# Nginx
sudo cp deploy/nginx-coc.conf /etc/nginx/sites-available/coc
sudo ln -sf /etc/nginx/sites-available/coc /etc/nginx/sites-enabled/coc
sudo rm -f /etc/nginx/sites-enabled/default
chmod o+x /home/jcc
sudo nginx -t && sudo systemctl reload nginx
```

Then open http://146.190.196.236 and log in.

## Updating

```bash
cd ~/coc && git pull && npm install && npm run build && sudo systemctl restart coc
```

> Note: `nginx-coc.conf` sets `client_max_body_size 10M` for the image-upload
> feature. Bump it if uploads need to be larger.
