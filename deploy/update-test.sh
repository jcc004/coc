#!/usr/bin/env bash
#
# Tests for deploy/update.sh. Run from anywhere:
#
#   ./deploy/update-test.sh
#
# Why this exists. `update.sh` is the one piece of this project that can take the
# site down, the one piece with no type checker behind it, and every guard in it was
# added because a real deploy failed in a way that let each individual command exit
# 0. Those guards were verified by hand, once. This runs them every time.
#
# It builds a throwaway tree that looks enough like the droplet — 60 card images, an
# art directory per source, a checkout tracking an origin — and stubs the four
# commands that would otherwise touch the world: sudo, npm, curl and rsync. Nothing
# here reads or writes the real repository, the real database, or the real host.
#
# Commits are made in a SECOND clone standing in for the developer's machine and
# pushed to origin; the host clone only ever runs update.sh. That distinction turned
# out to matter while writing this — committing on the host made every "deploy" a
# no-op, because local already equalled origin, and three tests passed for the wrong
# reason.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="${TMPDIR:-/tmp}/coc-update-test.$$"
trap 'rm -rf "$SB"' EXIT

HOST="$SB/coc"
DEV="$SB/dev"

# ------------------------------------------------------------------- the stubs

mkdir -p "$SB/bin" "$SB/origin" "$SB/home"

cat > "$SB/bin/sudo" <<'STUB'
#!/usr/bin/env bash
# The only sudo the script uses is `systemctl restart coc`, and there is nothing
# here to restart.
exit 0
STUB

cat > "$SB/bin/npm" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "ci" ]]; then
  # A real `npm ci` here installs tsx and vite, and update.sh now asserts both are
  # on disk afterwards — because a bare `npm ci` under NODE_ENV=production silently
  # prunes them, which took the site down once. Honour --include=dev the way npm
  # does: without it, pretend the prune happened, so the guard can be tested.
  mkdir -p node_modules/.bin
  for a in "$@"; do [[ "$a" == "--include=dev" ]] && include_dev=1; done
  if [[ -n "${include_dev:-}" || -z "${NODE_ENV:-}" ]]; then
    printf '#!/bin/sh\n' > node_modules/.bin/tsx
    printf '#!/bin/sh\n' > node_modules/.bin/vite
    chmod +x node_modules/.bin/tsx node_modules/.bin/vite
  fi
  exit 0
fi
if [[ "${1:-}" == "run" && "${2:-}" == "build" ]]; then
  rm -rf web/dist
  mkdir -p web/dist/assets web/dist/coc/cards
  # Named by commit, so "is the site serving what I just built" is a real question
  # here rather than a tautology.
  sha="$(git rev-parse --short HEAD)"
  # ~330 kB, what a production React bundle weighs — enough to keep the
  # development-build size alarm quiet.
  head -c 330000 /dev/zero | tr '\0' 'x' > "web/dist/assets/index-$sha.js"
  printf '<script src="/assets/index-%s.js"></script>\n' "$sha" > web/dist/index.html
  cp web/public/coc/cards/*.png web/dist/coc/cards/
  exit 0
fi
exit 0
STUB

cat > "$SB/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Answers the health probe, and serves back whatever index.html currently says.
for a in "$@"; do
  case "$a" in
    *api/health) exit 0 ;;
    https://example.test/) cat "$PWD/web/dist/index.html"; exit 0 ;;
  esac
done
exit 0
STUB

cat > "$SB/bin/rsync" <<'STUB'
#!/usr/bin/env bash
printf 'rsync %s\n' "$*" >> "$PWD/rsync.log"
exit 0
STUB

chmod +x "$SB"/bin/*

export PATH="$SB/bin:$PATH"
export DEPLOY_SITE_URL=https://example.test
export BACKUP_REMOTE=backup@offsite.test:/srv/coc-backups/
export HOME="$SB/home"

# ------------------------------------------------------------- the fake droplet

git init -q --bare "$SB/origin/coc.git"
git clone -q "$SB/origin/coc.git" "$HOST" 2>/dev/null
cd "$HOST"
git config user.email test@example.com
git config user.name Test
git symbolic-ref HEAD refs/heads/main

mkdir -p deploy web/public/coc/cards web/public/coc/leagues web/public/coc/labels \
         web/public/coc/wiki server/data
cp "$REPO/deploy/update.sh" deploy/
chmod +x deploy/update.sh
for i in $(seq -w 1 60); do : > "web/public/coc/cards/card_$i.png"; done
: > server/data/coc.db
printf 'v1\n' > app.txt
cat > .gitignore <<'IGN'
web/dist/
web/dist.prev-*/
web/public/coc/
.deploy-last-good-sha
.deploy-hold
rsync.log
IGN
git add -A
git commit -qm "good commit one"
git push -q origin main
git branch --set-upstream-to=origin/main main >/dev/null 2>&1

git clone -q "$SB/origin/coc.git" "$DEV"
git -C "$DEV" config user.email dev@example.com
git -C "$DEV" config user.name Dev

# Land a commit upstream the way a developer would: on their machine, then pushed.
push_upstream() {
  local body="$1" message="$2"
  git -C "$DEV" pull -q --ff-only
  printf '%s\n' "$body" > "$DEV/app.txt"
  git -C "$DEV" add -A
  git -C "$DEV" commit -qm "$message"
  git -C "$DEV" push -q origin main
}

pass=0
fail=0
check() {
  if [[ "$2" == "$3" ]]; then
    printf '  ok   %s\n' "$1"; pass=$((pass + 1))
  else
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$3" "$2"
    fail=$((fail + 1))
  fi
}
backups() { ls "$HOME"/coc-backups/coc-*.db 2>/dev/null | wc -l | tr -d ' '; }
banner() { printf '\n=== %s ===\n' "$*"; }

# =================================== the tests ==================================

banner "1. first deploy"
./deploy/update.sh --force > "$SB/d1.log" 2>&1
check "exit 0" "$?" "0"
good_sha="$(git rev-parse HEAD)"
check "last-good recorded" "$(cat .deploy-last-good-sha 2>/dev/null)" "$good_sha"
check "offsite copy attempted" "$(grep -c rsync rsync.log 2>/dev/null || echo 0)" "1"
check "one backup taken" "$(backups)" "1"

banner "2. a bad commit lands upstream, and the host picks it up"
push_upstream v2-broken "bad commit two"
b1="$(backups)"
./deploy/update.sh > "$SB/d2.log" 2>&1
check "exit 0" "$?" "0"
check "host now serves the bad commit" "$(cat app.txt)" "v2-broken"
bad_sha="$(git rev-parse HEAD)"
check "HEAD really moved" "$([[ "$bad_sha" != "$good_sha" ]] && echo moved || echo same)" "moved"
check "a backup was taken first" "$(backups)" "$((b1 + 1))"
check "last-good advanced (it passed its own checks)" "$(cat .deploy-last-good-sha)" "$bad_sha"

# The realistic operator action: the commit was healthy and still wrong, so name the
# release that really was good. A health check cannot tell the difference, which is
# why --rollback reads a recorded sha rather than assuming HEAD~1.
printf '%s\n' "$good_sha" > .deploy-last-good-sha

banner "3. rollback"
b2="$(backups)"
./deploy/update.sh --rollback > "$SB/d3.log" 2>&1
check "exit 0" "$?" "0"
check "HEAD is back on the good commit" "$(git rev-parse HEAD)" "$good_sha"
check "the served tree reverted" "$(cat app.txt)" "v1"
check "backed up before touching anything" "$(backups)" "$((b2 + 1))"
check "hold written" "$([[ -f .deploy-hold ]] && echo yes || echo no)" "yes"
check "last-good untouched by a rollback" "$(cat .deploy-last-good-sha)" "$good_sha"
grep -q "Rolled back to" "$SB/d3.log"; check "says so" "$?" "0"

banner "4. the timer fires again while held — must do nothing at all"
./deploy/update.sh > "$SB/d4.log" 2>&1
check "exit 0" "$?" "0"
check "did not follow origin/main" "$(cat app.txt)" "v1"
check "still on the good commit" "$(git rev-parse HEAD)" "$good_sha"
grep -q "Deploy is on hold" "$SB/d4.log"; check "says it is held" "$?" "0"
grep -q "Fetching origin" "$SB/d4.log"; check "did not even fetch" "$?" "1"
check "no backup churn while held" "$(backups)" "$((b2 + 1))"

banner "5. the fix is pushed, then --resume"
push_upstream v3-fixed "fix commit three"
./deploy/update.sh --resume > "$SB/d5.log" 2>&1
check "exit 0" "$?" "0"
check "hold cleared" "$([[ -f .deploy-hold ]] && echo yes || echo no)" "no"
check "the fix is deployed" "$(cat app.txt)" "v3-fixed"
check "last-good advanced to the fix" "$(cat .deploy-last-good-sha)" "$(git rev-parse HEAD)"

banner "6. --rollback with no recorded good deploy refuses"
rm -f .deploy-last-good-sha
./deploy/update.sh --rollback > "$SB/d6.log" 2>&1
check "exits nonzero" "$?" "1"
grep -q "nothing to roll back to" "$SB/d6.log"; check "explains why" "$?" "0"

banner "7. the guards that abort before touching anything"
git checkout -q -b not-main
./deploy/update.sh > "$SB/d7.log" 2>&1
check "refuses off main" "$?" "1"
grep -q "expected 'main'" "$SB/d7.log"; check "names the branch" "$?" "0"
git checkout -q main

printf 'uncommitted\n' >> app.txt
./deploy/update.sh --force > "$SB/d8.log" 2>&1
check "refuses a dirty tree" "$?" "1"
grep -q "Uncommitted changes" "$SB/d8.log"; check "lists what is dirty" "$?" "0"
git checkout -q -- app.txt

rm web/public/coc/cards/card_01.png
./deploy/update.sh --force > "$SB/d9.log" 2>&1
check "refuses with art missing" "$?" "1"
grep -q "expected 60" "$SB/d9.log"; check "counts the images" "$?" "0"
# Put it back, or every later test dies at this precondition instead of at whatever
# it was written to exercise. It did exactly that.
: > web/public/coc/cards/card_01.png

banner "9. a pruned install is caught before anything is built or restarted"
# The failure this guard exists for: `npm ci` exits 0 having installed the wrong tree,
# because NODE_ENV=production makes npm omit devDependencies — and tsx (which runs the
# server) and vite (which builds the front end) are both devDependencies. It took the
# site down once, so it is worth a test. Swap in an npm that installs neither.
cp "$SB/bin/npm" "$SB/bin/npm.real"
cat > "$SB/bin/npm" <<'PRUNED'
#!/usr/bin/env bash
if [[ "${1:-}" == "ci" ]]; then
  rm -f node_modules/.bin/tsx node_modules/.bin/vite
  echo "added 8 packages, and audited 12 packages"
  exit 0
fi
exit 0
PRUNED
chmod +x "$SB/bin/npm"

before_sha="$(git rev-parse HEAD)"
cp web/dist/index.html "$SB/dist-before.html"
./deploy/update.sh --force > "$SB/d11.log" 2>&1
check "aborts" "$?" "1"
grep -q "node_modules/.bin/tsx is missing" "$SB/d11.log"; check "names the missing binary" "$?" "0"
grep -q "NODE_ENV=production" "$SB/d11.log"; check "names the likely cause" "$?" "0"
grep -q "still up" "$SB/d11.log"; check "says the site is unaffected" "$?" "0"
grep -q "Restarting" "$SB/d11.log"; check "never got as far as restarting" "$?" "1"
check "the served build is untouched" "$(cmp -s web/dist/index.html "$SB/dist-before.html" && echo same || echo changed)" "same"
check "HEAD is where it was" "$(git rev-parse HEAD)" "$before_sha"

mv "$SB/bin/npm.real" "$SB/bin/npm"

banner "8. an unknown option is rejected rather than ignored"
./deploy/update.sh --nonsense > "$SB/d10.log" 2>&1
check "exit 2" "$?" "2"

printf '\n---------------------------------------\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
