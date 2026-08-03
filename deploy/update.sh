#!/usr/bin/env bash
#
# Update the running app to origin/main. Safe to run repeatedly and safe to run
# when nothing has changed.
#
#   ./deploy/update.sh            # deploy if origin/main has moved
#   ./deploy/update.sh --force    # rebuild and restart even if it has not
#
# Run as the user that owns the tree (crighjc), never with sudo: npm run as root
# leaves root-owned files in node_modules that every later run then trips over.
#
# The design premise is that a deploy which *reports* success while serving old
# code is worse than one that fails loudly. Every fault this project actually hit
# in production let each individual command exit 0:
#
#   - the checkout was on a stale branch, so a pull advanced nothing
#   - Nginx served a directory the build never wrote to
#   - the bundle was React's development build, because NODE_ENV was inherited
#   - the artwork was absent, so the build shipped sixty broken tiles
#   - the API token was minted for the wrong address
#
# So this script checks the *outcome*, not the exit codes: which branch, which
# commit, art present before building, and finally that the bundle the site serves
# is the one just built. It aborts before touching anything if a precondition
# fails, and restores the previous front-end build if the new one cannot be served.

set -euo pipefail
# An unmatched glob must expand to nothing rather than to itself, so counting files
# with an array is exact. Without this, `set -e` plus a failing `ls` on a missing
# directory exits the script silently — which is the one behaviour this whole file
# exists to prevent, and it did it. Found by testing the guard, not by reading it.
shopt -s nullglob

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH=main
SERVICE=coc
SITE="${DEPLOY_SITE_URL:-https://coc.jcciv.com}"
CARD_COUNT_EXPECTED=60
BACKUP_DIR="$HOME/coc-backups"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31m!!! %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preconditions

say "Checking preconditions"

[[ -d .git ]] || die "$ROOT is not a git checkout."

current="$(git rev-parse --abbrev-ref HEAD)"
# A detached HEAD or a feature branch is why a deploy can pull nothing for weeks
# while every command succeeds. Refuse rather than guess.
[[ "$current" == "$BRANCH" ]] || die "On '$current', expected '$BRANCH'. Fix with: git checkout $BRANCH"

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
[[ "$upstream" == "origin/$BRANCH" ]] || die "'$current' tracks '${upstream:-nothing}', not origin/$BRANCH."

dirty="$(git status --porcelain --untracked-files=no)"
[[ -z "$dirty" ]] || die "Uncommitted changes in the deploy tree:
$dirty
Deploys must be reproducible from the commit. Discard or commit them first."

# The artwork is gitignored and lives only on the host. Building without it produces
# a bundle that works and shows sixty broken tiles, which is exactly the kind of
# quiet failure this script exists to prevent.
host_cards=(web/public/coc/cards/*.png)
cards=${#host_cards[@]}
[[ "$cards" == "$CARD_COUNT_EXPECTED" ]] || die "Found $cards card images, expected $CARD_COUNT_EXPECTED.
The card art is gitignored and no script fetches it — see deploy/README.md §5.9.
Refusing to build, because the result would look fine and show broken tiles."
info "card art: $cards images"

for dir in leagues labels wiki; do
  [[ -d "web/public/coc/$dir" ]] || die "web/public/coc/$dir is missing. Run: npm run assets:coc && npm run assets:wiki"
done
info "badge, label and wiki art present"

# ------------------------------------------------------------------------ fetch

say "Fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"
info "local  $(git log --oneline -1 HEAD)"
info "remote $(git log --oneline -1 "origin/$BRANCH")"

if [[ "$local_sha" == "$remote_sha" && "$FORCE" == 0 ]]; then
  say "Already up to date — nothing to do"
  exit 0
fi

# ----------------------------------------------------------------------- backup

say "Backing up the database"
mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
if [[ -f server/data/coc.db ]]; then
  # .backup folds the write-ahead log into one consistent file and is safe while
  # the service is running; copying coc.db alone would leave the WAL behind.
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 server/data/coc.db ".backup '$BACKUP_DIR/coc-$stamp.db'"
    info "$BACKUP_DIR/coc-$stamp.db"
  else
    cp server/data/coc.db* "$BACKUP_DIR/" 2>/dev/null || true
    info "copied raw db files (sqlite3 not installed, so the WAL may lag)"
  fi
  # Keep the last twenty; a 25 GB disk and an unbounded backup directory is a
  # future outage with a boring cause.
  old_backups=("$BACKUP_DIR"/coc-*.db)
  if (( ${#old_backups[@]} > 20 )); then
    # Newest first, drop everything past the twentieth.
    printf '%s\n' "${old_backups[@]}" | xargs -r ls -1t | tail -n +21 | xargs -r rm -f
  fi
else
  info "no database yet — skipping"
fi

# ------------------------------------------------------------------ pull, build

say "Updating the working tree"
# --ff-only refuses on divergence instead of writing a merge commit on the server.
git merge --ff-only "origin/$BRANCH" || die "Cannot fast-forward: '$BRANCH' has diverged from origin. Resolve by hand."
info "now at $(git log --oneline -1 HEAD)"

say "Installing dependencies"
# ci, not install: it installs exactly the lockfile and never rewrites it, so the
# tree cannot drift dirty and block the next deploy.
npm ci --silent

say "Building the front end"
# Snapshotted so a failed build or a failed health check can put back something
# that was known to work.
PREV_DIST=""
if [[ -d web/dist ]]; then
  PREV_DIST="web/dist.prev-$stamp"
  rm -rf "$PREV_DIST"
  cp -R web/dist "$PREV_DIST"
fi

restore_dist() {
  if [[ -n "$PREV_DIST" && -d "$PREV_DIST" ]]; then
    rm -rf web/dist
    mv "$PREV_DIST" web/dist
    printf '    restored the previous build from %s\n' "$PREV_DIST"
  fi
}

if ! npm run build --silent; then
  restore_dist
  die "Build failed. The previous build is back in place, so the site is unchanged."
fi

built_bundles=(web/dist/assets/index-*.js)
bundle=""
(( ${#built_bundles[@]} > 0 )) && bundle="$(basename "${built_bundles[0]}")"
[[ -n "$bundle" ]] || { restore_dist; die "Build produced no JS bundle."; }
[[ -f web/dist/index.html ]] || { restore_dist; die "Build produced no index.html."; }
info "built $bundle"

# A development React is roughly twice the size and ships dev-only warnings. The
# build script pins NODE_ENV, so this is a regression alarm rather than a routine
# check — it costs nothing and it caught a real one.
bytes=$(wc -c < "web/dist/assets/$bundle")
if (( bytes > 450000 )); then
  info "WARNING: bundle is $bytes bytes; a production build is ~330 kB."
  info "         That size means a development React. Check NODE_ENV."
fi

# The art must have been copied into dist, or the tiles are broken again.
dist_cards=(web/dist/coc/cards/*.png)
built_cards=${#dist_cards[@]}
[[ "$built_cards" == "$CARD_COUNT_EXPECTED" ]] || { restore_dist; die "dist has $built_cards card images, expected $CARD_COUNT_EXPECTED."; }
info "dist carries $built_cards card images"

# ---------------------------------------------------------------------- restart

say "Restarting $SERVICE"
# Also what applies any pending schema migration.
sudo systemctl restart "$SERVICE"

for _ in $(seq 1 20); do
  sleep 1
  if curl -fsS --max-time 3 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    info "API healthy"
    break
  fi
done

if ! curl -fsS --max-time 3 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  restore_dist
  die "The API did not come back. The previous front-end build is restored, but the
service is down — check: journalctl -u $SERVICE -n 50"
fi

# --------------------------------------------------------------------- verify

say "Verifying what is actually being served"

served="$(curl -fsS --max-time 10 "$SITE/" | grep -oE 'assets/index-[^"]+\.js' | head -1 | xargs -r basename || true)"
if [[ -z "$served" ]]; then
  info "WARNING: could not read $SITE — check it by hand."
elif [[ "$served" == "$bundle" ]]; then
  info "serving $served — matches the build"
else
  die "Serving '$served' but built '$bundle'.
Nginx is serving a different directory than the one just built. Check:
  grep -n root /etc/nginx/sites-enabled/coc     # should be $ROOT/web/dist
  sudo cp deploy/nginx-coc.conf /etc/nginx/sites-available/coc
  sudo nginx -t && sudo systemctl reload nginx"
fi

# Drift in the Nginx config is reported, never applied: a deploy that can rewrite
# the TLS config has a far bigger blast radius than the problem it would solve.
if [[ -f /etc/nginx/sites-available/coc ]] && ! diff -q deploy/nginx-coc.conf /etc/nginx/sites-available/coc >/dev/null 2>&1; then
  info "NOTE: deploy/nginx-coc.conf differs from the installed config."
  info "      Review, then: sudo cp deploy/nginx-coc.conf /etc/nginx/sites-available/coc"
  info "                    sudo nginx -t && sudo systemctl reload nginx"
fi

rm -rf "$PREV_DIST"
say "Deployed $(git log --oneline -1 HEAD)"
