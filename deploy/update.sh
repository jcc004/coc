#!/usr/bin/env bash
#
# Update the running app to origin/main. Safe to run repeatedly and safe to run
# when nothing has changed.
#
#   ./deploy/update.sh            # deploy if origin/main has moved
#   ./deploy/update.sh --force    # rebuild and restart even if it has not
#   ./deploy/update.sh --rollback # put back the last commit that deployed cleanly
#   ./deploy/update.sh --resume   # clear the hold a rollback left, and deploy again
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
ROLLBACK=0
RESUME=0
case "${1:-}" in
  --force)    FORCE=1 ;;
  --rollback) ROLLBACK=1 ;;
  --resume)   RESUME=1 ;;
  '')         ;;
  *)          printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH=main
SERVICE=coc
SITE="${DEPLOY_SITE_URL:-https://coc.jcciv.com}"
CARD_COUNT_EXPECTED=60
BACKUP_DIR="$HOME/coc-backups"

# Written after every deploy that passes its own health and bundle checks, and read
# by --rollback. Gitignored: it describes this host, not the code.
LAST_GOOD="$ROOT/.deploy-last-good-sha"

# A rollback leaves this behind, and a normal run refuses to proceed while it
# exists. Without it the timer would fast-forward straight back onto the commit that
# was just rolled back, five minutes later — which is the failure mode that makes a
# rollback feel like it did not work.
HOLD="$ROOT/.deploy-hold"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31m!!! %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------------- hold

# --resume is only ever "clear the hold, then behave normally", so it is handled
# before the hold is checked and needs nothing else of its own.
if [[ "$RESUME" == 1 ]]; then
  if [[ -f "$HOLD" ]]; then
    say "Clearing the deploy hold"
    info "was: $(cat "$HOLD")"
    rm -f "$HOLD"
  else
    info "no hold in place — nothing to clear"
  fi
fi

# The hold is checked before anything else so a held host does no work at all: no
# fetch, no backup, no build. A timer firing every five minutes against a held
# deploy should be almost free, and should say the same thing every time.
if [[ -f "$HOLD" && "$ROLLBACK" == 0 ]]; then
  say "Deploy is on hold — doing nothing"
  info "$(cat "$HOLD")"
  info "This host was rolled back, so it will not follow origin/$BRANCH again until"
  info "you clear the hold. Push the fix first, then: ./deploy/update.sh --resume"
  exit 0
fi

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

# One exception, and only one: package-lock.json.
#
# `npm ci` never writes it, so a modified lockfile on a deploy host can only have come
# from somebody running `npm install` by hand — and the committed lockfile is the
# authoritative one either way. Left to fail, a single stray `npm install` would stop
# every unattended deploy from then on, and the timer would go quietly dead until
# somebody thought to read its journal. That is a worse failure than restoring a file
# whose local edits are npm's rather than anyone's.
#
# It matters that this happens *before* `npm ci`: that command installs from the
# lockfile as it exists on disk, so a modified one would be silently honoured.
if [[ "$dirty" == " M package-lock.json" ]]; then
  info "package-lock.json was modified locally — restoring the committed version"
  info "(npm ci never writes it, so this came from a manual npm install)"
  git checkout -- package-lock.json
  dirty="$(git status --porcelain --untracked-files=no)"
fi

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

# ---------------------------------------------------------- what are we deploying
#
# Two ways in. A rollback names a commit from this host's own history and refuses to
# look at the remote at all; everything else follows origin/main as it always has.
# Both converge on the same build, restart and verify path below, because a rollback
# that took a different route to production would be a second deploy mechanism
# tested even less than the first.

TARGET_SHA=""

if [[ "$ROLLBACK" == 1 ]]; then
  say "Rolling back"

  [[ -f "$LAST_GOOD" ]] || die "No record of a good deploy in $LAST_GOOD, so there is
nothing to roll back to. That file is written by this script after a deploy passes
its health and bundle checks, so a host that has only ever deployed by hand has none.
Pick a commit yourself:  git reset --hard <sha> && ./deploy/update.sh --force"

  TARGET_SHA="$(cat "$LAST_GOOD")"
  git cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null || die "$LAST_GOOD names $TARGET_SHA, which is not a commit in this checkout."

  if [[ "$(git rev-parse HEAD)" == "$TARGET_SHA" ]]; then
    say "Already on the last good commit — nothing to roll back"
    exit 0
  fi

  info "from $(git log --oneline -1 HEAD)"
  info "to   $(git log --oneline -1 "$TARGET_SHA")"
else
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

  # Offsite copy, if one is configured.
  #
  # Twenty backups on the same droplet protect against a bad migration and against
  # nothing else: losing the droplet loses the accounts and the whole card season
  # with it. BACKUP_REMOTE is any rsync destination — `user@host:path/` or a local
  # mount — and lives in /srv/coc/.env beside the rest of the host's configuration.
  #
  # A failure here **warns and carries on**. An unreachable backup host is not a
  # reason to stop deploying, and dying at this point would leave the tree pulled
  # and the service un-restarted, which is the one state this script works hardest
  # to avoid. The warning is the signal; silence would be the bug.
  if [[ -n "${BACKUP_REMOTE:-}" ]]; then
    if command -v rsync >/dev/null 2>&1; then
      if rsync -q --timeout=30 "$BACKUP_DIR/coc-$stamp.db" "$BACKUP_REMOTE" 2>/dev/null; then
        info "copied offsite to $BACKUP_REMOTE"
      else
        info "WARNING: offsite copy to $BACKUP_REMOTE failed. The local backup is fine."
      fi
    else
      info "WARNING: BACKUP_REMOTE is set but rsync is not installed. No offsite copy."
    fi
  fi
else
  info "no database yet — skipping"
fi

# ------------------------------------------------------------------ pull, build

if [[ "$ROLLBACK" == 1 ]]; then
  say "Moving the working tree back"
  # --hard is safe here only because the precondition above proved the tree is clean
  # apart from gitignored files, which a reset does not touch.
  git reset --hard --quiet "$TARGET_SHA"
  info "now at $(git log --oneline -1 HEAD)"

  # Written before the build, not after: the hold has to survive a rollback whose
  # rebuild then fails, or the timer would helpfully restore the broken commit.
  printf 'Rolled back to %s on %s\n' "$(git log --oneline -1 HEAD)" "$(date -Is)" > "$HOLD"
  info "deploy held — the timer will not follow origin/$BRANCH until --resume"
else
  say "Updating the working tree"
  # --ff-only refuses on divergence instead of writing a merge commit on the server.
  git merge --ff-only "origin/$BRANCH" || die "Cannot fast-forward: '$BRANCH' has diverged from origin. Resolve by hand."
  info "now at $(git log --oneline -1 HEAD)"
fi

say "Installing dependencies"
# ci, not install: it installs exactly the lockfile and never rewrites it, so the
# tree cannot drift dirty and block the next deploy.
#
# `--include=dev` is not redundant, and leaving it out took the site down once.
#
# **This project's devDependencies are runtime dependencies.** The service runs
# `tsx` — there is no build step for the server, it executes TypeScript directly —
# and the front end needs `vite` to build at all. Both are devDependencies.
#
# npm decides what to omit from `NODE_ENV`: with `NODE_ENV=production` exported,
# `npm config get omit` returns `dev`, so a bare `npm ci` silently prunes both.
# Nothing errors. `npm ci` reports "added 8 packages" instead of ~249, the build
# then fails with `vite: not found`, and — the part that actually hurts — the
# service restarts into a missing `tsx` and the site is down.
#
# It is easy to have `NODE_ENV=production` in the environment here, because
# /srv/coc/.env sets it for the app and deploy/README.md tells you to source that
# file before fetching artwork. `--include=dev` wins over any omit setting
# regardless of order, which is exactly why it is the fix rather than unsetting
# a variable and hoping.
npm ci --silent --include=dev

# Checking the outcome, not the exit code — the whole premise of this script, and
# the one guard whose absence let the above reach production. `npm ci` exits 0
# having installed the wrong tree, so the only honest test is whether the two
# binaries the deploy and the service need are actually on disk.
for tool in tsx vite; do
  [[ -x "node_modules/.bin/$tool" ]] || die "npm ci finished but node_modules/.bin/$tool is missing.
That means devDependencies were pruned — almost certainly NODE_ENV=production in this
shell, which npm treats as --omit=dev. Both tsx (which *runs* the server) and vite
(which builds the front end) are devDependencies here.

Nothing has been built or restarted, so the site is still up. Fix with:
  unset NODE_ENV && npm ci --include=dev"
done
info "tsx and vite present"

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

# The same trap, for the same reason, one directory over. A `git pull` updates
# deploy/coc.service in the repo and nothing in /etc/systemd/system, so the
# sandboxing and the ExecStart the repo believes are in force may not be. Reported
# rather than applied, exactly as above — installing a unit and restarting into it
# unattended is how you find out a directive was wrong with the site already down.
for unit in coc.service coc-update.service coc-update.timer; do
  if [[ -f "/etc/systemd/system/$unit" ]] && ! diff -q "deploy/$unit" "/etc/systemd/system/$unit" >/dev/null 2>&1; then
    info "NOTE: deploy/$unit differs from the installed unit."
    info "      Review, then: sudo cp deploy/$unit /etc/systemd/system/$unit"
    info "                    sudo systemctl daemon-reload"
  fi
done

rm -rf "$PREV_DIST"

if [[ "$ROLLBACK" == 1 ]]; then
  say "Rolled back to $(git log --oneline -1 HEAD)"
  info "The deploy is held. Push the fix, then: ./deploy/update.sh --resume"
else
  # Recorded only here, so it names a commit that reached production and answered a
  # health check — which is the only definition of "good" this script can actually
  # observe. Deliberately not written after a rollback: leaving it pointing at the
  # same commit makes a second --rollback a no-op rather than walking backwards
  # through history one commit at a time, which is not a thing a script should do
  # unattended.
  git rev-parse HEAD > "$LAST_GOOD"
  say "Deployed $(git log --oneline -1 HEAD)"
  info "recorded as the last good deploy; ./deploy/update.sh --rollback returns here"
fi
