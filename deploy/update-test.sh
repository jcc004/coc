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
# no-op, because local already equaled origin, and three tests passed for the wrong
# reason.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="${TMPDIR:-/tmp}/coc-update-test.$$"
trap 'rm -rf "$SB"' EXIT
# Normalized, because a TMPDIR with a trailing slash leaves $SB with a doubled one and
# the paths update.sh reports have all been through `cd && pwd`. Comparing the two
# then fails on a slash, which is a waste of everybody's afternoon.
mkdir -p "$SB"
SB="$(cd "$SB" && pwd)"

HOST="$SB/coc"
DEV="$SB/dev"

# update.sh copies itself into $TMPDIR and re-execs from there, so point TMPDIR at the
# sandbox: the copies land somewhere countable, and "did it clean up after itself" is
# a question about an empty directory rather than about /tmp on a shared machine.
# Set after SB, which is derived from the real TMPDIR on purpose.
mkdir -p "$SB/tmp"
export TMPDIR="$SB/tmp"

# ------------------------------------------------------------------- the stubs

mkdir -p "$SB/bin" "$SB/origin" "$SB/home"

cat > "$SB/bin/sudo" <<'STUB'
#!/usr/bin/env bash
# Real sudo, minus the privilege: this sandbox runs as one user throughout, so
# there is nothing to elevate to and no real systemd to talk to.
#
# `systemctl restart coc` is a no-op — nothing here to restart. Everything else
# `sudo` is asked to run (the backup step's sqlite3/cp, needed once the app runs
# as its own dedicated account and its files stop being readable to this one) is
# executed for real, so that logic is actually exercised rather than silently
# skipped the way a blanket no-op would skip it.
if [[ "${1:-}" == "systemctl" ]]; then
  exit 0
fi
exec "$@"
STUB

cat > "$SB/bin/npm" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "ci" ]]; then
  # A real `npm ci` here installs tsx and vite, and update.sh now asserts both are
  # on disk afterwards — because a bare `npm ci` under NODE_ENV=production silently
  # prunes them, which took the site down once. Honor --include=dev the way npm
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
  # ~510 kB: what the real production bundle weighs (510,579 bytes on the droplet,
  # 2026-09-21), and past the 450 kB the old size alarm fired at. So the default stub
  # is a production-sized bundle carrying no React text, and every deploy here that
  # stays quiet is also a deploy that did not warn on size alone — section 23 asserts
  # it. Knobs, all off by default:
  #   STUB_DEV_TEXT=<string>  plants one of React's development-only strings, in the
  #                           middle of a line (minified code carries it that way; alone
  #                           on a line, a grep that only matches whole lines would
  #                           find it too and pass for the wrong reason)
  #   STUB_DEV_IN=vendor      ...in a second chunk instead of index-*.js
  #   STUB_DEV_IN=changelog   ...in changelog-data-*.js, as a commit message quoting it
  #   STUB_CLEAN_WORDS=1      adds ordinary English sharing single words with the
  #                           markers ("hook", "call", "the") and the phrases only in
  #                           lowercase, so it is clean to an exact match and not to
  #                           a loose one
  #   STUB_UNREADABLE=1       adds a file the scan cannot read
  head -c 510000 /dev/zero | tr '\0' 'x' > "web/dist/assets/index-$sha.js"
  # A real build always ships this next to index-*.js, and it sorts first. Emitting it
  # every time keeps the harness the shape of the droplet's dist, so a scan that stops
  # or misbehaves when it meets that file cannot go unseen.
  printf 'x\nvar c=[{"subject":"Fix a crash","body":"An ordinary commit message."}];\nx\n' \
    > "web/dist/assets/changelog-data-$sha.js"
  if [[ -n "${STUB_DEV_TEXT:-}" ]]; then
    case "${STUB_DEV_IN:-index}" in
      vendor)
        printf 'x\nfunction f(){throw new Error("%s. See the docs.")}\nx\n' "$STUB_DEV_TEXT" \
          > "web/dist/assets/vendor-$sha.js" ;;
      changelog)
        printf 'x\nvar c=[{"subject":"Fix a crash","body":"%s. See the docs."}];\nx\n' "$STUB_DEV_TEXT" \
          > "web/dist/assets/changelog-data-$sha.js" ;;
      *)
        printf '\nfunction f(){throw new Error("%s. See the docs.")}\n' "$STUB_DEV_TEXT" \
          >> "web/dist/assets/index-$sha.js" ;;
    esac
  fi
  if [[ -n "${STUB_CLEAN_WORDS:-}" ]]; then
    # The lowercase phrases are there so that matching case-insensitively would flag
    # this file: the markers are exact.
    printf '\nvar t="Invalid input. Rendered more rows than expected during the previous render. The hook is a call to update the depth. Maximum value exceeded. invalid hook call; maximum update depth exceeded.";\n' \
      >> "web/dist/assets/index-$sha.js"
  fi
  if [[ -n "${STUB_UNREADABLE:-}" ]]; then
    : > "web/dist/assets/unreadable-$sha.js"
    chmod 000 "web/dist/assets/unreadable-$sha.js"
  fi
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

# The retention policy keeps ONE backup per day, so "a deploy took a backup" can no
# longer be tested by watching the count go up: five deploys in one test run are five
# deploys on one day and collapse to a single daily. These three replace that.
#
# The whole directory as one string, for "nothing moved" assertions.
backup_list() { ls "$HOME"/coc-backups/ 2>/dev/null | sort | tr '\n' ' '; }
# How many distinct days the surviving backups cover. Must equal the file count, or
# the policy has left two backups from the same day behind.
backup_days() {
  ls "$HOME"/coc-backups/coc-*.db 2>/dev/null |
    sed 's#.*/coc-##; s#-.*##' | sort -u | wc -l | tr -d ' '
}
# The path update.sh said it had just written, read back out of its own log.
fresh_backup() { grep -oE '/[^ ]*/coc-[0-9]{8}-[0-9]{6}\.db' "$1" | head -1; }
# Did the deploy take a backup and still have it afterwards? This is the property
# that matters: rotation must never eat the copy the deploy just stopped to make.
kept_its_backup() {
  local f; f="$(fresh_backup "$1")"
  if [[ -n "$f" && -f "$f" ]]; then echo yes; else echo no; fi
}

# ------------------------------------------------- the re-exec, seen from outside
#
# update.sh copies itself out of the tree and re-execs bash on the copy, so that the
# `git merge` half way down cannot rewrite the file bash is reading. These read that
# back out of its own log; sections 20 and 21 prove the mechanism itself.

# How many times a run announced that it was running from a copy. Must be exactly 1 for
# anything that touches git — 0 means the protection is not there, 2 means the copy
# re-execed itself and the next number would be 3.
reexec_count() { grep -c 'running from a temporary copy' "$1" | tr -d ' '; }
# The path it copied itself to.
copy_path() { grep -oE '/[^ ]*/coc-update\.[A-Za-z0-9]+' "$1" | head -1; }
# Is that copy gone? A run that leaves them behind fills $TMPDIR one deploy at a time.
copy_cleaned() {
  local p; p="$(copy_path "$1")"
  if [[ -z "$p" ]]; then echo "no copy in the log"
  elif [[ -e "$p" ]]; then echo "still there"
  else echo gone; fi
}
# The copy must not be under the checkout: that is the one directory git rewrites.
copy_is_inside() {
  local p; p="$(copy_path "$1")"
  case "$p" in
    "$2"/*) echo inside ;;
    *)      echo outside ;;
  esac
}
# Where the script decided the checkout is, after the exec moved it to /tmp.
logged_root() { grep -E '^ +repo /' "$1" | head -1 | sed 's#^ *repo ##'; }
# Nothing at all left in TMPDIR. Checked after most runs rather than once at the end,
# so that whichever run leaks is the one that fails.
temp_left() { ls "$TMPDIR" 2>/dev/null | wc -l | tr -d ' '; }

# =================================== the tests ==================================

banner "1. first deploy"
./deploy/update.sh --force > "$SB/d1.log" 2>&1
check "exit 0" "$?" "0"
good_sha="$(git rev-parse HEAD)"
check "last-good recorded" "$(cat .deploy-last-good-sha 2>/dev/null)" "$good_sha"
check "offsite copy attempted" "$(grep -c rsync rsync.log 2>/dev/null || echo 0)" "1"
check "one backup taken" "$(backups)" "1"
check "and it is still there" "$(kept_its_backup "$SB/d1.log")" "yes"
# The re-exec, on the path that matters: a run that is about to merge.
check "ran from a copy of itself" "$(reexec_count "$SB/d1.log")" "1"
check "the copy lives outside the checkout" "$(copy_is_inside "$SB/d1.log" "$HOST")" "outside"
check "ROOT survived the exec" "$(logged_root "$SB/d1.log")" "$HOST"
check "the copy was deleted on the way out" "$(copy_cleaned "$SB/d1.log")" "gone"
check "nothing left in TMPDIR" "$(temp_left)" "0"
# --force reached the other side of the exec, or this run would have found local ==
# remote on a fresh clone and exited before building anything.
grep -q "Building the front end" "$SB/d1.log"; check "--force survived the re-exec" "$?" "0"

banner "2. a bad commit lands upstream, and the host picks it up"
push_upstream v2-broken "bad commit two"
./deploy/update.sh > "$SB/d2.log" 2>&1
check "exit 0" "$?" "0"
check "host now serves the bad commit" "$(cat app.txt)" "v2-broken"
bad_sha="$(git rev-parse HEAD)"
check "HEAD really moved" "$([[ "$bad_sha" != "$good_sha" ]] && echo moved || echo same)" "moved"
check "a backup was taken first, and survived rotation" "$(kept_its_backup "$SB/d2.log")" "yes"
check "one backup per day retained" "$(backups)" "$(backup_days)"
check "last-good advanced (it passed its own checks)" "$(cat .deploy-last-good-sha)" "$bad_sha"

# The realistic operator action: the commit was healthy and still wrong, so name the
# release that really was good. A health check cannot tell the difference, which is
# why --rollback reads a recorded sha rather than assuming HEAD~1.
printf '%s\n' "$good_sha" > .deploy-last-good-sha

banner "3. rollback"
./deploy/update.sh --rollback > "$SB/d3.log" 2>&1
check "exit 0" "$?" "0"
check "HEAD is back on the good commit" "$(git rev-parse HEAD)" "$good_sha"
check "the served tree reverted" "$(cat app.txt)" "v1"
check "backed up before touching anything" "$(kept_its_backup "$SB/d3.log")" "yes"
check "hold written" "$([[ -f .deploy-hold ]] && echo yes || echo no)" "yes"
check "last-good untouched by a rollback" "$(cat .deploy-last-good-sha)" "$good_sha"
grep -q "Rolled back to" "$SB/d3.log"; check "says so" "$?" "0"
# --rollback runs `git reset --hard`, which rewrites this script exactly as a merge
# does, so it gets the same protection — and the argument has to survive the exec for
# any of the above to have happened at all.
check "--rollback ran from a copy too" "$(reexec_count "$SB/d3.log")" "1"
check "and the copy is gone" "$(copy_cleaned "$SB/d3.log")" "gone"

banner "4. the timer fires again while held — must do nothing at all"
held_backups="$(backup_list)"
./deploy/update.sh > "$SB/d4.log" 2>&1
check "exit 0" "$?" "0"
check "did not follow origin/main" "$(cat app.txt)" "v1"
check "still on the good commit" "$(git rev-parse HEAD)" "$good_sha"
grep -q "Deploy is on hold" "$SB/d4.log"; check "says it is held" "$?" "0"
grep -q "Fetching origin" "$SB/d4.log"; check "did not even fetch" "$?" "1"
# Not a count: a held run must not take a backup AND must not rotate one away, and
# only comparing the directory itself catches the second half.
check "no backup churn while held" "$(backup_list)" "$held_backups"
# A held run re-execs even though it exits before touching git. That is the deliberate
# choice recorded in update.sh: whether a host is held is state, not an argument, and
# one answer to "is this host held" is worth more than a saved file copy. Asserted so
# that moving the hold check above the re-exec is a decision somebody makes on purpose.
check "a held run still re-execs" "$(reexec_count "$SB/d4.log")" "1"
check "and still tidies up" "$(copy_cleaned "$SB/d4.log")" "gone"

banner "5. the fix is pushed, then --resume"
push_upstream v3-fixed "fix commit three"
./deploy/update.sh --resume > "$SB/d5.log" 2>&1
check "exit 0" "$?" "0"
check "hold cleared" "$([[ -f .deploy-hold ]] && echo yes || echo no)" "no"
check "the fix is deployed" "$(cat app.txt)" "v3-fixed"
check "last-good advanced to the fix" "$(cat .deploy-last-good-sha)" "$(git rev-parse HEAD)"
check "still one backup per day after five deploys" "$(backups)" "$(backup_days)"
check "and the last one is still on disk" "$(kept_its_backup "$SB/d5.log")" "yes"

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
# A run that dies still has to take its copy with it, and this one dies a long way from
# the end. `rm -f` on the EXIT trap rather than on the last line is what makes that so.
check "the copy is removed on the failure path too" "$(copy_cleaned "$SB/d11.log")" "gone"
check "no copies left behind by any run so far" "$(temp_left)" "0"

mv "$SB/bin/npm.real" "$SB/bin/npm"

banner "22. npm ci fails outright after the fast-forward, and the next run retries"
# The fast-forward and the install are not atomic. If npm ci dies, the branch has
# already moved — and comparing only local_sha to remote_sha on the next tick would
# find them equal and report "already up to date" forever, with the broken install
# never retried. This is the trap CLAUDE.md's Deploying section records.
push_upstream v4-flaky-install "fix commit four"
# Not `git rev-parse origin/main` here: $HOST's remote-tracking ref is only as fresh
# as its last fetch, which has not happened yet — push_upstream pushed from $DEV,
# straight to the bare origin, without touching $HOST's own idea of origin/main.
prev_last_good="$(cat .deploy-last-good-sha 2>/dev/null || true)"

cp "$SB/bin/npm" "$SB/bin/npm.real"
cat > "$SB/bin/npm" <<'BROKEN'
#!/usr/bin/env bash
if [[ "${1:-}" == "ci" ]]; then
  echo "npm ERR! network timeout" >&2
  exit 1
fi
exit 0
BROKEN
chmod +x "$SB/bin/npm"

./deploy/update.sh > "$SB/d22a.log" 2>&1
check "the broken install run fails" "$?" "1"
# update.sh's own fetch-then-merge already ran before npm ci did, so HEAD is now
# usable as "the commit that got stuck" — the same pattern scenario 2 uses above.
stuck_sha="$(git rev-parse HEAD)"
check "the fast-forward still happened" "$(cat app.txt)" "v4-flaky-install"
check "last-good was NOT advanced" "$(cat .deploy-last-good-sha 2>/dev/null || true)" "$prev_last_good"

mv "$SB/bin/npm.real" "$SB/bin/npm"

./deploy/update.sh > "$SB/d22b.log" 2>&1
check "the retry succeeds, with npm working again" "$?" "0"
# The full sentence, not just "Already up to date" — `git merge --ff-only` prints
# that substring on its own whenever HEAD is already at the target (as it is here),
# which is expected and harmless; only the script's own early-exit message ("...—
# nothing to do") would mean the retry never actually happened.
grep -q "Already up to date — nothing to do" "$SB/d22b.log"
check "does not report already up to date" "$?" "1"
grep -q "did not finish — retrying" "$SB/d22b.log"
check "says why it is retrying" "$?" "0"
check "last-good now covers the commit that was stuck" "$(cat .deploy-last-good-sha)" "$stuck_sha"
check "the site now serves the fix" "$(cat app.txt)" "v4-flaky-install"

banner "23. a development React is flagged by what is in the bundle, not by how big it is"
# The stub bundle is production-sized (~510 kB) and carries no React text. That is
# past the 450 kB the old alarm fired at, so a deploy of it that warns is the old
# alarm still firing on size — which is what it did on every real deploy from the day
# the production bundle grew past its limit.
./deploy/update.sh --force > "$SB/d23a.log" 2>&1
check "a production-sized bundle deploys" "$?" "0"
check "and it really is past the old 450 kB limit" \
  "$(( $(cat web/dist/assets/index-*.js | wc -c) > 450000 ))" "1"
grep -q "WARNING" "$SB/d23a.log"; check "and size alone does not warn" "$?" "1"
# The line above fails on any line containing WARNING, but not on a size note worded some
# other way. So pin the shape instead of a vocabulary: on a clean deploy nothing at all
# is printed between "built index-…" and "dist carries …", and that is exactly where a
# bundle warning would land, however it is worded. Not a word search over the log:
# the log carries a random mktemp name and the machine's TMPDIR, and a pattern such as
# `kB` turns up in one of those about once in two hundred runs.
between="$(awk '/^ +built index-/{f=1; next} /^ +dist carries/{f=0} f' "$SB/d23a.log")"
check "and nothing is said about the bundle between building it and checking the art" \
  "$between" ""
grep -qE '^ +built index-' "$SB/d23a.log" && grep -qE '^ +dist carries' "$SB/d23a.log"
check "and both of those lines are in the log, so that was not an empty slice" "$?" "0"

# Read out of update.sh rather than retyped, as section 21 does for the preamble: a
# copy here would test the copy. The check fails if the array goes, instead of the loop
# below quietly running zero times. Blank and comment lines are not markers.
markers=()
while IFS= read -r line; do markers+=("$line"); done < <(
  awk '/^dev_react_markers=\(/{f=1; next} f && /^\)/{f=0} f && NF && !/^[[:space:]]*#/' \
    "$REPO/deploy/update.sh" | sed "s/^ *'//; s/' *\$//"
)
check "found the marker list in update.sh" \
  "$([[ ${#markers[@]} -ge 1 ]] && echo yes || echo no)" "yes"

# Every marker on its own, so a dropped or mangled -e argument shows up as the one
# marker that stops being found rather than hiding behind the others. Still a warning,
# not a gate: the deploy goes ahead, as it did before.
i=0
for m in ${markers[@]+"${markers[@]}"}; do
  i=$((i + 1))
  STUB_DEV_TEXT="$m" ./deploy/update.sh --force > "$SB/d23-m$i.log" 2>&1
  check "marker $i: the deploy still goes ahead" "$?" "0"
  grep -q "development-only text" "$SB/d23-m$i.log"; check "marker $i is flagged: $m" "$?" "0"
  # The line right after "Found in:", not the whole log: "built index-…" and "serving
  # index-…" are in every run's log, so a looser match would pass whether or not the
  # warning named anything.
  grep -A1 "Found in:" "$SB/d23-m$i.log" | tail -1 | grep -q "index-"
  check "marker $i: and the log names the file it was in" "$?" "0"
done

# Not in index-*.js. The old alarm measured only that one file; this one has to follow
# React into whichever chunk the build puts it in.
STUB_DEV_TEXT="${markers[0]:-}" STUB_DEV_IN=vendor ./deploy/update.sh --force > "$SB/d23-v.log" 2>&1
check "a marker in another chunk: the deploy goes ahead" "$?" "0"
grep -q "development-only text" "$SB/d23-v.log"; check "and it is flagged there too" "$?" "0"
grep -A1 "Found in:" "$SB/d23-v.log" | tail -1 | grep -q "vendor-"
check "naming that chunk" "$?" "0"
grep -A1 "Found in:" "$SB/d23-v.log" | tail -1 | grep -q "index-"
check "and not the clean index one" "$?" "1"

# Ordinary English that shares single words with the markers ("hook", "call", "the")
# and none of the phrases. A pattern list that got split into words, as an unquoted
# expansion would do, matches this; the phrases do not.
STUB_CLEAN_WORDS=1 ./deploy/update.sh --force > "$SB/d23-w.log" 2>&1
check "words the markers share, without the phrases: the deploy goes ahead" "$?" "0"
grep -q "WARNING" "$SB/d23-w.log"; check "and it is not flagged" "$?" "1"

# changelog-data-*.js holds every kept commit's subject and body verbatim, so a commit
# message that quotes a marker is in it for good. That is not a development React, and
# flagging it would put the alarm back to warning on every deploy.
STUB_DEV_TEXT="${markers[0]:-}" STUB_DEV_IN=changelog ./deploy/update.sh --force \
  > "$SB/d23-c.log" 2>&1
check "a marker quoted in the changelog chunk: the deploy goes ahead" "$?" "0"
grep -q "WARNING" "$SB/d23-c.log"; check "and it is not flagged" "$?" "1"

# A scan that fails must not read as a clean one. A mode-000 file makes grep exit 2,
# which the `|| true` this replaced would have swallowed. Root reads it anyway, so the
# check cannot run as root.
if [[ "$(id -u)" == 0 ]]; then
  printf '  skip the unreadable-file check: root can read a mode-000 file\n'
else
  STUB_UNREADABLE=1 ./deploy/update.sh --force > "$SB/d23-u.log" 2>&1
  check "an unreadable file: the deploy still goes ahead" "$?" "0"
  grep -q "could not finish scanning" "$SB/d23-u.log"
  check "and it says the scan did not finish" "$?" "0"
  # A failed scan is not a finding: nothing was planted, so it must not claim React's
  # text was found.
  grep -q "development-only text" "$SB/d23-u.log"
  check "and it does not claim to have found development React" "$?" "1"
  # The next run copies web/dist before building, which a mode-000 file would break.
  rm -f web/dist/assets/unreadable-*.js

  # Both at once: grep exits 2 for the unreadable file but still lists what it did find,
  # and that must not be dropped because the scan as a whole failed.
  STUB_UNREADABLE=1 STUB_DEV_TEXT="${markers[0]:-}" ./deploy/update.sh --force \
    > "$SB/d23-uv.log" 2>&1
  check "unreadable file and a marker: the deploy still goes ahead" "$?" "0"
  grep -q "could not finish scanning" "$SB/d23-uv.log"
  check "the unfinished scan is reported" "$?" "0"
  grep -q "development-only text" "$SB/d23-uv.log"
  check "and so is what the scan did find" "$?" "0"
  rm -f web/dist/assets/unreadable-*.js
fi

# Back to a clean bundle, so the tree is left the way the sections after this expect.
./deploy/update.sh --force > "$SB/d23z.log" 2>&1
check "a clean bundle after all that is quiet again" "$(grep -c WARNING "$SB/d23z.log")" "0"
check "nothing left in TMPDIR" "$(temp_left)" "0"

banner "8. an unknown option is rejected rather than ignored"
./deploy/update.sh --nonsense > "$SB/d10.log" 2>&1
check "exit 2" "$?" "2"
# It exits before the re-exec, so it neither copies itself nor has anything to clean up.
check "did not copy itself first" "$(reexec_count "$SB/d10.log")" "0"
check "and left nothing in TMPDIR" "$(temp_left)" "0"

banner "17. if it cannot copy itself it refuses, rather than deploying unprotected"
# The whole point of the copy is that the deploy is about to rewrite this file. Falling
# back to running the original would be choosing the hazard at the exact moment
# something else is already wrong with the disk.
before_sha="$(git rev-parse HEAD)"
TMPDIR="$SB/no-such-directory" ./deploy/update.sh --force > "$SB/d12.log" 2>&1
check "exits nonzero" "$?" "1"
grep -q "Refusing to deploy" "$SB/d12.log"; check "says it is refusing" "$?" "0"
grep -q "Fetching origin" "$SB/d12.log";    check "never got as far as fetching" "$?" "1"
check "HEAD is where it was" "$(git rev-parse HEAD)" "$before_sha"

banner "18. the copy refuses to guess where the checkout is"
# COC_UPDATE_ROOT is the whole of what survives the exec. If it is missing or wrong the
# copy has no idea which tree to deploy, and /tmp is not a plausible answer.
COC_UPDATE_REEXEC="$TMPDIR/coc-update.ZZZZZZ" COC_UPDATE_ROOT="$SB/not-a-directory" \
  ./deploy/update.sh > "$SB/d13.log" 2>&1
check "exits nonzero" "$?" "1"
grep -q "not a directory" "$SB/d13.log"; check "says what it was given" "$?" "0"
grep -q "Fetching origin" "$SB/d13.log";  check "and did nothing" "$?" "1"

# The copy deletes the path it is handed, so it checks the shape of that path first: a
# stale COC_UPDATE_REEXEC in somebody's shell must not turn this into an rm.
: > "$SB/precious"
COC_UPDATE_REEXEC="$SB/precious" COC_UPDATE_ROOT="$HOST" ./deploy/update.sh > "$SB/d14.log" 2>&1
check "exits nonzero" "$?" "1"
check "did not delete a file it never created" \
  "$([[ -f "$SB/precious" ]] && echo there || echo gone)" "there"
grep -q "not a path this script" "$SB/d14.log"; check "says why" "$?" "0"

# ============================== backup retention ================================
#
# The deploy tests above cannot exercise this properly: every backup they produce is
# stamped within the same minute, so the policy has one day to work with and there is
# no such thing as a completed week. So these drive the same code through
# `--prune-backups`, against directories of known stamps.
#
# The dates are fixed rather than relative to today on purpose. A policy whose test
# data moves under it gives a different answer on a Monday, and the whole point of
# the exercise is that the answer is derivable from the filenames alone.

fake_dir() {                        # fake_dir <dir> <stamp>...
  local dir="$1"; shift
  rm -rf "$dir"; mkdir -p "$dir"
  local s
  for s in "$@"; do printf 'not really a database\n' > "$dir/coc-$s.db"; done
}
listing() { ls "$1" 2>/dev/null | sort | tr '\n' ' '; }
count_of() { ls "$1" 2>/dev/null | wc -l | tr -d ' '; }

banner "10. retention picks 3 dailies, 1 weekly and 1 monthly"
# Reading the stamps: two deploys on 08-04 (only the newer is the daily), 08-03, then
# nothing at all from 07-29 to 08-02 — five quiet days, so the third daily slot slides
# back to 07-28 rather than sitting empty. 07-27 is in the same Monday-start week as
# the 07-28 daily, so it is NOT the weekly; the weekly is the newest of the week
# before, 07-24. July is covered by a daily and by the weekly, so the monthly drops to
# the newest backup in June.
R="$SB/rot-a"
fake_dir "$R" \
  20260504-100000 20260531-235500 \
  20260603-090000 20260630-235959 \
  20260701-080000 20260713-090000 20260720-100000 20260724-174500 \
  20260727-081500 20260728-081600 \
  20260803-210533 20260804-073011 20260804-091244
# mtime is deliberately made to disagree with the stamps, because on the droplet it
# will: an rsync back from BACKUP_REMOTE or a restore rewrites every one of them. The
# oldest backup here is now the newest file on disk, and it must still be the first
# to go. The code this replaced ranked with `ls -1t` and would keep it.
touch "$R/coc-20260504-100000.db"
./deploy/update.sh --prune-backups "$R" > "$SB/r1.log" 2>&1
check "exit 0" "$?" "0"
# The one mode that deliberately skips the re-exec: it runs no git command, so there is
# nothing to protect it from, and copying itself would only give housekeeping a new way
# to fail. It must still work, which is what the rest of this section is about.
check "--prune-backups does not re-exec" "$(reexec_count "$SB/r1.log")" "0"
check "and leaves TMPDIR alone" "$(temp_left)" "0"
check "survivors" "$(listing "$R")" \
  "coc-20260630-235959.db coc-20260724-174500.db coc-20260728-081600.db coc-20260803-210533.db coc-20260804-091244.db "
grep -q "coc-20260630-235959.db monthly" "$SB/r1.log"; check "names the monthly" "$?" "0"
grep -q "coc-20260724-174500.db weekly" "$SB/r1.log"; check "names the weekly" "$?" "0"
check "three dailies" "$(grep -c ' daily$' "$SB/r1.log")" "3"
check "mtime did not save the oldest file" "$([[ -e "$R/coc-20260504-100000.db" ]] && echo there || echo gone)" "gone"

banner "11. running it again changes nothing"
./deploy/update.sh --prune-backups "$R" > "$SB/r2.log" 2>&1
check "exit 0" "$?" "0"
check "same five survivors" "$(listing "$R")" \
  "coc-20260630-235959.db coc-20260724-174500.db coc-20260728-081600.db coc-20260803-210533.db coc-20260804-091244.db "
check "deleted nothing" "$(grep -c '^    delete ' "$SB/r2.log")" "0"

banner "12. many deploys in one day collapse to the newest of that day"
R="$SB/rot-b"
fake_dir "$R" 20260804-080000 20260804-093000 20260804-110000 20260804-181500 20260804-205900
./deploy/update.sh --prune-backups "$R" > "$SB/r3.log" 2>&1
check "exit 0" "$?" "0"
check "only the last one survives" "$(listing "$R")" "coc-20260804-205900.db "

banner "13. one backup is never rotated to zero"
R="$SB/rot-c"
fake_dir "$R" 20260804-091244
./deploy/update.sh --prune-backups "$R" > "$SB/r4.log" 2>&1
check "exit 0" "$?" "0"
check "it survives" "$(listing "$R")" "coc-20260804-091244.db "

banner "14. names the policy cannot parse are reported and never deleted"
# The raw coc.db / coc.db-wal the sqlite3-less fallback leaves, somebody's hand-made
# copy, and a stamp that is the right SHAPE but an impossible date. An unattended rm
# gets to delete only files it can explain.
R="$SB/rot-d"
fake_dir "$R" 20260801-090000 20260804-091244
: > "$R/coc.db"; : > "$R/coc.db-wal"; : > "$R/coc-backup-manual.db"
: > "$R/coc-20261332-994499.db"
./deploy/update.sh --prune-backups "$R" > "$SB/r5.log" 2>&1
check "exit 0" "$?" "0"
check "everything unparseable is still there" "$(listing "$R")" \
  "coc-20260801-090000.db coc-20260804-091244.db coc-20261332-994499.db coc-backup-manual.db coc.db coc.db-wal "
grep -q "carry no coc-YYYYmmdd-HHMMSS.db stamp" "$SB/r5.log"; check "says so out loud" "$?" "0"

banner "15. a large backlog is trimmed over several runs, not emptied in one"
# 28 backups against a 20-per-run cap: the first run leaves 8, the second converges on
# the policy's 5. This is what the migration off the old keep-twenty looks like on the
# droplet, and it is deliberately slow.
R="$SB/rot-e"
fake_dir "$R" \
  20260505-100000 20260512-100000 20260519-100000 \
  20260601-100000 20260605-100000 20260610-100000 20260615-100000 20260620-100000 \
  20260625-100000 20260630-100000 \
  20260701-100000 20260703-100000 20260706-100000 20260708-100000 20260710-100000 \
  20260713-100000 20260715-100000 20260717-100000 20260720-100000 20260722-100000 \
  20260724-100000 20260727-100000 20260728-100000 20260730-100000 \
  20260801-100000 20260802-100000 20260803-100000 20260804-100000
./deploy/update.sh --prune-backups "$R" > "$SB/r6.log" 2>&1
check "exit 0" "$?" "0"
check "first run deletes exactly the cap" "$(grep -c '^    delete ' "$SB/r6.log")" "20"
check "8 left, not 5" "$(count_of "$R")" "8"
grep -q "past retention" "$SB/r6.log"; check "explains the throttle" "$?" "0"
./deploy/update.sh --prune-backups "$R" > "$SB/r7.log" 2>&1
check "second run converges" "$(listing "$R")" \
  "coc-20260630-100000.db coc-20260724-100000.db coc-20260802-100000.db coc-20260803-100000.db coc-20260804-100000.db "

banner "16. --prune-backups refuses a directory that is not there"
./deploy/update.sh --prune-backups "$SB/does-not-exist" > "$SB/r8.log" 2>&1
check "exits nonzero" "$?" "1"
grep -q "is not a directory" "$SB/r8.log"; check "says why" "$?" "0"
./deploy/update.sh --prune-backups > "$SB/r9.log" 2>&1
check "and refuses no directory at all" "$?" "1"

# ====================== the hazard the re-exec exists for =======================
#
# Everything above checks that update.sh runs from a copy. This checks that it needed
# to, by doing the thing to a throwaway script and watching it happen.
#
# The mechanism. Bash does not read a script into memory first. It reads a bufferful —
# min(file size, 8172) bytes — and keeps a byte offset into the open file. Rewrite that
# file in place while it is running and the next bufferful comes back from the *new*
# content at the *old* offset, which is almost never the start of a statement.
#
# The replacement below is one 30 kB comment line whose tail is `; printf FRAGMENT-RAN`,
# then a statement of its own. Nothing can print FRAGMENT-RAN by running either version
# of the script from the top: in the replacement that text is inside a comment. It can
# only appear if execution resumed part way into a line. And 30 kB of it on one line
# means the assertion does not depend on knowing exactly where bash resumed — every
# offset the victim script can reach is inside that comment.
#
# Why this has never actually happened, which is worth writing down next to the test
# that says it could: git does not rewrite in place. `merge --ff-only` and `reset
# --hard` unlink the file and create a new one — checked on git 2.50.1, where a 12 kB
# self-rewriting script pulled through a real merge still ran its last line, because
# the unlinked inode stays alive for as long as bash holds it open. Everything else
# that puts a file over another one on this host does truncate: `cp`, `scp`, `rsync
# --inplace`, a plain `>`. `sudo cp` is how deploy/README.md installs things. So the
# simulation below is the truncating case, which is the one that is not a promise
# anybody has made.

HZ="$SB/hazard"
mkdir -p "$HZ/deploy"

# One enormous comment line, then a line of its own.
{
  printf '#!/usr/bin/env bash\n'
  printf '#'
  head -c 30000 /dev/zero | tr '\0' 'z'
  printf ' ; printf %s\n' "'FRAGMENT-RAN\n'"
  printf 'printf %s\n' "'REPLACEMENT-FROM-THE-TOP\n'"
} > "$HZ/replacement"

# build_victim <preamble-file|""> — writes $HZ/deploy/demo.sh.
#
# The body is identical either way; the only difference is whether update.sh's re-exec
# preamble is spliced in front of it. It announces its arguments and its ROOT, prints
# ONE, replaces its own file on disk with the 30 kB replacement, and then has 12 kB of
# padding to walk through before printing TWO. Padding, because the whole question is
# what happens when bash needs a second bufferful.
# The single quotes below are the point: this writes the text of another script, so
# nothing in it may expand here.
# shellcheck disable=SC2016
build_victim() {
  local preamble="${1:-}"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -uo pipefail\n'
    printf 'info() { printf %s "$*"; }\n' "'    %s\n'"
    printf 'die()  { printf %s "$*" >&2; exit 1; }\n' "'!!! %s\n'"
    printf 'PRUNE_ONLY=0\n'
    if [[ -n "$preamble" ]]; then
      cat "$preamble"
    else
      printf 'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n'
    fi
    printf 'cd "$ROOT"\n'
    printf 'printf %s "$*"\n'   "'ARGS[%s]\n'"
    printf 'printf %s "$ROOT"\n' "'ROOT[%s]\n'"
    printf 'printf %s\n' "'ONE\n'"
    printf 'cat "$ROOT/replacement" > "$ROOT/deploy/demo.sh"\n'
    awk 'BEGIN{for(i=0;i<180;i++) printf "# padding %04d ------------------------------------------------\n", i}'
    printf 'printf %s\n' "'TWO\n'"
  } > "$HZ/deploy/demo.sh"
  chmod +x "$HZ/deploy/demo.sh"
}

banner "20. a script rewritten under bash resumes mid-statement"
build_victim ""
check "the victim is bigger than one bufferful" \
  "$([[ "$(wc -c < "$HZ/deploy/demo.sh")" -gt 8172 ]] && echo yes || echo no)" "yes"
"$HZ/deploy/demo.sh" > "$SB/h1.log" 2>&1
hz_exit=$?
grep -q '^ONE$' "$SB/h1.log";                check "it started as itself" "$?" "0"
grep -q '^FRAGMENT-RAN$' "$SB/h1.log";       check "then ran a fragment of a comment in the new file" "$?" "0"
grep -q '^TWO$' "$SB/h1.log";                check "and never reached its own last line" "$?" "1"
check "having reported success" "$hz_exit" "0"

banner "21. the same rewrite, with update.sh's re-exec preamble in front of it"
# Extracted from update.sh rather than retyped: a paraphrase of the preamble would test
# the paraphrase. If the markers ever go, the check below fails rather than the section
# quietly passing against an empty file.
awk '/^# >>> re-exec preamble/{f=1; next} /^# <<< re-exec preamble/{f=0} f' \
  "$REPO/deploy/update.sh" > "$SB/preamble.sh"
# shellcheck disable=SC2016   # a literal to match, not an expression to expand
grep -qF 'exec "${BASH:-bash}"' "$SB/preamble.sh"
check "extracted the real preamble out of update.sh" "$?" "0"

build_victim "$SB/preamble.sh"
"$HZ/deploy/demo.sh" --force spare-arg > "$SB/h2.log" 2>&1
hz_exit=$?
check "exit 0" "$hz_exit" "0"
check "it re-execed, once" "$(reexec_count "$SB/h2.log")" "1"
grep -q '^ONE$' "$SB/h2.log";          check "started" "$?" "0"
grep -q '^TWO$' "$SB/h2.log";          check "and finished, through the same rewrite" "$?" "0"
grep -q 'FRAGMENT-RAN' "$SB/h2.log";   check "no fragment of the replacement ran" "$?" "1"
grep -q 'REPLACEMENT-FROM-THE-TOP' "$SB/h2.log"
check "and it did not restart into the replacement either" "$?" "1"
check "arguments came through the exec intact" \
  "$(grep -o 'ARGS\[.*\]' "$SB/h2.log")" "ARGS[--force spare-arg]"
check "ROOT is the tree, not the copy" "$(grep -o 'ROOT\[.*\]' "$SB/h2.log")" "ROOT[$HZ]"
check "the copy was cleaned up" "$(copy_cleaned "$SB/h2.log")" "gone"
check "and the file on disk really was replaced under it" \
  "$(grep -c 'REPLACEMENT-FROM-THE-TOP' "$HZ/deploy/demo.sh" | tr -d ' ')" "1"

check "nothing left in TMPDIR at the end" "$(temp_left)" "0"

printf '\n---------------------------------------\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
