#!/usr/bin/env bash
#
# Tests deploy/nginx-coc.conf by actually serving it. Needs Docker; skips cleanly
# without it.
#
#   ./deploy/nginx-test.sh
#
# Why bother, when `nginx -t` on the droplet is the real gate: `nginx -t` proves the
# file parses, and nothing about what it does. The things most worth being sure of
# here are behavioral — that the login throttle fires, that it does NOT fire during
# an ordinary page render, and that the security headers reach API responses and not
# just the SPA. Getting the login throttle wrong locks everyone out of the app; that
# is worth more than a syntax check.
#
# It runs the real config, unedited, with one server block appended to stand in for
# the Node API on 8787 — so proxy_pass and both /api locations are exercised as
# written. The certificate, dhparams and certbot include file are stubbed on the host
# (the nginx alpine image has no openssl), and nothing here touches the droplet.
#
# Measured against nginx 1.30.4. The two "listen ... http2 is deprecated" warnings
# are expected and deliberate — see the comment on that line in the config.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DOCKER="$(command -v docker || true)"
[[ -x "$DOCKER" ]] || DOCKER=/usr/local/bin/docker
if [[ ! -x "$DOCKER" ]] || ! "$DOCKER" info >/dev/null 2>&1; then
  echo "SKIP: Docker is not available, so the config cannot be served here."
  echo "      Run 'sudo nginx -t' on the droplet instead — that is the real gate."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/le/live/coc.jcciv.com"

cp "$REPO/deploy/nginx-coc.conf" "$WORK/coc.conf"
cat >> "$WORK/coc.conf" <<'STUB'

# ---- test-only: stands in for the Node API on 8787 ----
server {
    listen 127.0.0.1:8787;
    location / { return 200 "stub-api\n"; }
}
STUB

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$WORK/le/live/coc.jcciv.com/privkey.pem" \
  -out "$WORK/le/live/coc.jcciv.com/fullchain.pem" \
  -subj "/CN=coc.jcciv.com" 2>/dev/null
openssl dhparam -out "$WORK/le/ssl-dhparams.pem" 2048 2>/dev/null
cat > "$WORK/le/options-ssl-nginx.conf" <<'OPT'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
OPT

cat > "$WORK/entry.sh" <<'ENTRY'
#!/bin/sh
set -e
mkdir -p /var/www/certbot /srv/coc/web/dist
printf '<html><body>spa</body></html>\n' > /srv/coc/web/dist/index.html
cp /tmp/coc.conf /etc/nginx/conf.d/coc.conf
rm -f /etc/nginx/conf.d/default.conf
nginx -t 2>/dev/null || { echo "CONFIG REJECTED"; nginx -t; exit 1; }
nginx
sleep 1

H="Host: coc.jcciv.com"
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$3" "$2"; fail=$((fail+1))
  fi
}

echo
echo "=== the SPA and the API both answer ==="
code=$(curl -sk -o /dev/null -w '%{http_code}' -H "$H" https://127.0.0.1/)
check "GET / serves the SPA" "$code" "200"
body=$(curl -sk -H "$H" https://127.0.0.1/api/health)
check "GET /api/health reaches the backend" "$body" "stub-api"

echo
echo "=== the login throttle: burst of 5, then 429 ==="
seq=""
i=1
while [ "$i" -le 8 ]; do
  c=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "$H" \
       -H 'Content-Type: application/json' -d '{"email":"a@b.c","password":"x"}' \
       https://127.0.0.1/api/auth/login)
  seq="$seq $c"
  i=$((i+1))
done
echo "   statuses:$seq"
allowed=$(echo "$seq" | tr ' ' '\n' | grep -c '^200$' || true)
limited=$(echo "$seq" | tr ' ' '\n' | grep -c '^429$' || true)
check "six attempts get through (burst 5 + the rate’s own)" "$allowed" "6"
check "the rest are throttled" "$limited" "2"

echo
echo "=== a real page render is NOT throttled (30 API calls) ==="
n429=0
i=1
while [ "$i" -le 30 ]; do
  c=$(curl -sk -o /dev/null -w '%{http_code}' -H "$H" https://127.0.0.1/api/clans/%23ABC)
  [ "$c" = "429" ] && n429=$((n429+1))
  i=$((i+1))
done
check "no 429s in 30 ordinary API calls" "$n429" "0"

echo
echo "=== security headers ==="
hdrs=$(curl -skI -H "$H" https://127.0.0.1/)
for h in "content-security-policy" "strict-transport-security" "x-frame-options" \
         "x-content-type-options" "referrer-policy"; do
  echo "$hdrs" | grep -qi "^$h:" && r=0 || r=1
  check "$h present on the SPA" "$r" "0"
done
# The headers have to reach API responses too, or a JSON endpoint is unprotected.
ahdrs=$(curl -skI -H "$H" https://127.0.0.1/api/health)
echo "$ahdrs" | grep -qi "^content-security-policy:" && r=0 || r=1
check "CSP present on API responses too" "$r" "0"
printf '   Server header: [%s]\n' "$(echo "$ahdrs" | grep -i "^server:" | tr -d "\r")"
echo "$ahdrs" | tr -d "\r" | grep -qiE "^server: *nginx *$" && r=0 || r=1
check "server_tokens off (no version in Server:)" "$r" "0"

echo
echo "   CSP as sent:"
echo "$hdrs" | grep -i "^content-security-policy:" | cut -c1-160

printf '\n---------------------------------------\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
ENTRY
chmod +x "$WORK/entry.sh"

"$DOCKER" run --rm \
  -v "$WORK/coc.conf:/tmp/coc.conf:ro" \
  -v "$WORK/entry.sh:/entry.sh:ro" \
  -v "$WORK/le:/etc/letsencrypt:ro" \
  --entrypoint /entry.sh \
  nginx:stable-alpine
