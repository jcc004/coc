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
#   ./deploy/update.sh --prune-backups DIR   # apply the backup retention policy to
#                                            # DIR and stop; deploys nothing
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
#   - the deploy rewrote *this file* while bash was part-way through reading it, and
#     execution carried on at the old byte offset in the new one — mid-statement. The
#     only entry here caught before production rather than after; "run from a copy of
#     this script" below has the measurements and says what it would take to fire.
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

# Defined here rather than further down because the re-exec below needs to be able to
# refuse loudly, and it has to run before anything else does.
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31m!!! %s\033[0m\n' "$*" >&2; exit 1; }

FORCE=0
ROLLBACK=0
RESUME=0
PRUNE_ONLY=0
PRUNE_DIR=""
case "${1:-}" in
  --force)          FORCE=1 ;;
  --rollback)       ROLLBACK=1 ;;
  --resume)         RESUME=1 ;;
  --prune-backups)  PRUNE_ONLY=1; PRUNE_DIR="${2:-}" ;;
  '')               ;;
  *)                printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac

# ----------------------------------------------- run from a copy of this script
#
# Bash does not read a script into memory before running it. It reads a bufferful at a
# time — min(file size, 8172) bytes — and keeps a byte offset into the open file. Every
# time it needs the next bufferful it reads from that offset, out of whatever is at the
# path *now*. This file is several bufferfuls long, and the deploy rewrites
# deploy/update.sh part way down it. If the running script is the
# same file the deploy rewrote, the second read returns the new content at the old
# offset — which is almost never the start of a statement. The deploy then executes
# fragments: half a command, the tail of a heredoc, or nothing at all when the new file
# is shorter, in which case bash reaches EOF and exits 0 having skipped the build, the
# restart and every check below.
#
# That last shape is why this sits at the top of the file rather than on a list. A
# deploy that reports success while serving old code is the fault this whole script
# exists to prevent, and this produces it out of nothing but a commit that changed the
# script's length.
#
# **Why it has not happened yet, measured rather than assumed.** Whether it fires turns
# on one detail: does the writer truncate the existing file, or unlink it and create a
# new one? Truncating keeps the inode, so the fd bash is holding sees the new bytes.
# Unlinking does not: the old inode stays alive for as long as bash has it open, and
# the script runs to the end as written. Today's git unlinks — checked on git 2.50.1,
# where both `merge --ff-only` and `reset --hard` give the file a new inode, and a
# 12 kB self-rewriting script pulled through a real merge still ran its last line. So
# the exposure has always been a promise git does not make. Everything else that puts
# a file on this host in place of another one does truncate: `cp`, `scp`, `rsync
# --inplace`, `>`. `sudo cp` is how deploy/README.md tells you to install things, and
# an operator copying a fixed update.sh onto the droplet while the five-minute timer
# happens to be mid-run is not an exotic scenario. The cost of not depending on any of
# this is one file copy per deploy.
#
# The fix is to make "the script bash is reading" and "the file git rewrites" two
# different files: copy ourselves out of the tree and exec bash on the copy, passing
# the arguments straight through. COC_UPDATE_REEXEC marks the copy, so it does not do
# it again, and carries the path so the copy can delete itself on the way out.
#
# The decisions inside that, since none of them are forced:
#
#   - **Where the copy lives.** Wherever mktemp puts it, which under systemd is not
#     the /tmp you would expect: coc-update.service sets PrivateTmp=true, so /tmp is
#     a per-service tmpfs nothing else on the host can see, and systemd tears it down
#     when the unit finishes. The copy cannot collide with another run, cannot be read
#     by anything else, and does not survive even a SIGKILL that skips the trap. Run
#     by hand it lands in the real $TMPDIR and the trap is what removes it. What it
#     must never be is somewhere under $ROOT: that is the directory git is about to
#     rewrite, which is the entire problem.
#   - **`exec bash "$copy"`, not `exec "$copy"`.** /tmp is mounted noexec on plenty of
#     hardened hosts, and the deploy should not start depending on that.
#   - **--prune-backups does not re-exec.** It runs no git command at all, so there is
#     nothing to protect it from, and re-execing it would give a pure housekeeping run
#     a new way to fail. An unknown option has already exited above, for the same
#     reason. Everything else re-execs, --rollback included: `git reset --hard`
#     rewrites this file exactly the way a merge does.
#   - **A held host re-execs anyway**, even though it is about to exit before touching
#     git. Whether a host is held is state read further down, not something the
#     arguments say, and hoisting that decision up here would put two answers to "is
#     this host held" in one file. One file copy every five minutes is the cheaper
#     mistake.
#   - **If the copy cannot be made, refuse.** Carrying on would mean running the
#     original, which is the exact situation being fixed, and doing it in the one case
#     where something is already wrong with the disk.
#
# ROOT is the part of this most likely to break, so it is handled explicitly rather
# than left to work out. After the exec, BASH_SOURCE names the copy in /tmp, and
# deriving ROOT from it the way this file always has would silently point the whole
# deploy — checkout, build, backup, verify — at a temporary directory. So the original
# resolves ROOT while it still can and hands it over in the environment; the copy takes
# it from there and never consults BASH_SOURCE at all.
#
# >>> re-exec preamble: update-test.sh extracts everything between these two markers
#     verbatim, puts it in front of a throwaway script, and has that script rewrite
#     itself part way through. Keep the markers, or that test silently tests nothing.
SELF_COPY=""
if [[ -n "${COC_UPDATE_REEXEC:-}" ]]; then
  # We are the copy.
  SELF_COPY="$COC_UPDATE_REEXEC"

  # This branch is about to arrange for `rm` to run on a path that arrived in the
  # environment, so it checks the shape of it first. Nothing but the exec below ever
  # sets COC_UPDATE_REEXEC, and it always sets it to an mktemp name, so anything else
  # means the variable is stale in somebody's shell or another script is calling this
  # one — neither of which is a reason to delete a file that is not ours.
  case "${SELF_COPY##*/}" in
    coc-update.??????) ;;
    *) die "COC_UPDATE_REEXEC is set to '$SELF_COPY', which is not a path this script
would have created. It is set by the re-exec inside this file and by nothing else.
Refusing rather than deleting a file that is not ours: unset it, then run
./deploy/update.sh from the checkout." ;;
  esac

  # However this run ends — success, a die(), a `set -e` trip — the copy goes with it.
  # The three signal traps are there so that a systemd stop or a Ctrl-C reaches the
  # EXIT trap at all: bash would otherwise take the default action and die on the
  # signal without running it.
  trap 'rm -f -- "$SELF_COPY"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  ROOT="${COC_UPDATE_ROOT:-}"
  [[ -n "$ROOT" && -d "$ROOT" ]] || die "This is the temporary copy at $SELF_COPY, but
COC_UPDATE_ROOT is '${COC_UPDATE_ROOT:-}', which is not a directory — so there is no
way to tell where the checkout is. Nothing has been fetched, pulled or restarted.
Run ./deploy/update.sh from the checkout, with neither COC_UPDATE_REEXEC nor
COC_UPDATE_ROOT set in the environment."
  info "running from a temporary copy, so the pull cannot rewrite it: $SELF_COPY"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  if [[ "$PRUNE_ONLY" == 0 ]]; then
    SELF_COPY="$(mktemp "${TMPDIR:-/tmp}/coc-update.XXXXXX")" || die "Could not create a
temporary file in ${TMPDIR:-/tmp} to copy this script into. Refusing to deploy: this
script is about to be rewritten by the pull, and running it from the checkout while
that happens resumes bash mid-statement. Nothing has been fetched or pulled. Check the
free space and the permissions on ${TMPDIR:-/tmp}."
    cp "${BASH_SOURCE[0]}" "$SELF_COPY" || { rm -f -- "$SELF_COPY"; die "Could not copy
${BASH_SOURCE[0]} to $SELF_COPY. Refusing to deploy from the checkout — see above.
Nothing has been fetched or pulled."; }

    # The outcome, not the exit code: cp exits 0 on a short write often enough, and a
    # truncated copy is a script that stops half way through the deploy and says
    # nothing. Byte counts, because that is the property that matters here.
    self_bytes="$(wc -c < "${BASH_SOURCE[0]}")"
    copy_bytes="$(wc -c < "$SELF_COPY")"
    if (( copy_bytes != self_bytes )); then
      rm -f -- "$SELF_COPY"
      die "The copy of this script came out at $copy_bytes bytes, not $self_bytes.
Refusing to deploy: a truncated copy would run part of the deploy and stop without
saying why. Nothing has been fetched or pulled. Check the free space on ${TMPDIR:-/tmp}."
    fi

    # bash, not the copy directly, so a noexec /tmp is not a deploy outage. The copy
    # deletes itself; there is nothing left for this process to clean up, and there is
    # no this process after the next line.
    COC_UPDATE_REEXEC="$SELF_COPY" COC_UPDATE_ROOT="$ROOT" exec "${BASH:-bash}" "$SELF_COPY" "$@"
  fi
fi
# <<< re-exec preamble

cd "$ROOT"

BRANCH=main
SERVICE=coc
SITE="${DEPLOY_SITE_URL:-https://coc.jcciv.com}"
CARD_COUNT_EXPECTED=60
BACKUP_DIR="$HOME/coc-backups"

# The retention policy, in one place. See the long comment above rotate_backups().
KEEP_DAILY=3
KEEP_WEEKLY=1
KEEP_MONTHLY=1
# Most files one run may delete. Not a tuning knob — a blast-radius limit, and the
# reason is in the rotate_backups() comment.
KEEP_DELETE_CAP=20

# Written after every deploy that passes its own health and bundle checks, and read
# by --rollback. Gitignored: it describes this host, not the code.
LAST_GOOD="$ROOT/.deploy-last-good-sha"

# A rollback leaves this behind, and a normal run refuses to proceed while it
# exists. Without it the timer would fast-forward straight back onto the commit that
# was just rolled back, five minutes later — which is the failure mode that makes a
# rollback feel like it did not work.
HOLD="$ROOT/.deploy-hold"

# -------------------------------------------------------------- backup retention

# Days since 1970-01-01 for a Gregorian date, by arithmetic alone.
#
# Deliberately not `date -d`: that is a GNU extension, and update-test.sh runs on a
# developer's Mac where date is BSD and would silently parse the string as something
# else entirely. The one thing worse than a rotation that miscounts weeks is a
# rotation that miscounts weeks only on the machine nobody tests on.
#
# Standard civil-from-days algorithm, unrolled. Years here are always well past 1970,
# so the negative-era branch the general form carries is not needed.
days_from_civil() {
  local y=$((10#$1)) m=$((10#$2)) d=$((10#$3))
  local era yoe doy doe
  if (( m <= 2 )); then y=$((y - 1)); fi
  era=$(( y / 400 ))
  yoe=$(( y - era * 400 ))
  if (( m > 2 )); then
    doy=$(( (153 * (m - 3) + 2) / 5 + d - 1 ))
  else
    doy=$(( (153 * (m + 9) + 2) / 5 + d - 1 ))
  fi
  doe=$(( yoe * 365 + yoe / 4 - yoe / 100 + doy ))
  printf '%s\n' $(( era * 146097 + doe - 719468 ))
}

# Generational retention, replacing a flat "keep the newest twenty".
#
#   3 dailies   the newest backup of each of the last three days that HAVE a backup
#   1 weekly    the newest backup of the most recent completed week no daily covers
#   1 monthly   the newest backup of the most recent completed month nothing above covers
#
# The spec has real ambiguity in it. Resolved deliberately, and written down here
# because the next person to read this will be deciding whether a missing backup is
# a bug or the policy working:
#
#   - Several deploys land on one day, which is normal here. The daily is the NEWEST
#     of that day; the earlier ones are superseded within the day and go.
#   - A day with no deploy does not burn a slot. The window is "the last three days
#     that produced a backup", not "the last three calendar days". The alternative
#     lets a quiet weekend silently take a five-backup directory down to two, and a
#     retention policy should not shrink because nothing happened.
#   - The weekly and the monthly are PROMOTIONS of backups already on disk, not extra
#     copies. A file kept as today's daily becomes next week's weekly by still being
#     there. Nothing is duplicated and no state file has to be maintained, which is
#     what makes the policy re-derivable from the directory alone.
#   - "Completed" means "not the period the newest backup is in". The week and month
#     in progress are the dailies' business; a weekly is chosen only once its week
#     can no longer gain a newer member. Weeks start Monday — nothing depends on
#     which day that is, but two runs must not disagree, so it is fixed here.
#
# Grouping comes out of the FILENAME, never out of the filesystem. Every backup is
# coc-YYYYmmdd-HHMMSS.db, fixed width, so plain text order is chronological order.
# mtime is not: an rsync back from BACKUP_REMOTE, a restore, or a `cp -R` of the
# directory stamps every file with the moment of the copy and destroys the ordering
# completely. The code this replaces ranked with `ls -1t`, so after any of those it
# would have kept twenty copies of the same afternoon and deleted every older
# generation — succeeding, quietly, at the exact opposite of its job.
#
# Two rules of engagement, because this runs with nobody watching and what it deletes
# is the only copy of the accounts and the card season this host has:
#
#   - A file whose name this cannot parse is reported and never deleted.
#   - When anything looks wrong — an empty keep set, the newest backup not in it —
#     delete nothing and say so. Keeping too much costs disk. Keeping too little
#     costs the database.
#
# Arguments: the directory, and the basename of the backup just taken ("" if none).
rotate_backups() {
  local dir="$1" fresh="${2:-}"

  # Scan wider than the policy deletes. `coc*` also catches the raw coc.db /
  # coc.db-wal the sqlite3-less fallback leaves behind, so they can be reported as
  # outside the policy rather than sitting there unmentioned.
  local all=("$dir"/coc*)
  if (( ${#all[@]} == 0 )); then
    info "retention: $dir is empty — nothing to rotate"
    return 0
  fi

  local recognised=() strange=()
  local f base y m d hh mi ss
  for f in "${all[@]}"; do
    base="${f##*/}"
    if [[ -f "$f" && "$base" =~ ^coc-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})\.db$ ]]; then
      y="${BASH_REMATCH[1]}"; m="${BASH_REMATCH[2]}"; d="${BASH_REMATCH[3]}"
      hh="${BASH_REMATCH[4]}"; mi="${BASH_REMATCH[5]}"; ss="${BASH_REMATCH[6]}"
      # The shape being right does not make the date real. 20261332-994499 matches
      # the pattern and would put a backup in a month that does not exist, which
      # would then quietly win a slot no real backup could reach. Anything that is
      # not a plausible date is treated as unparseable, and unparseable means keep.
      if (( 10#$y >= 1970 && 10#$m >= 1 && 10#$m <= 12 && 10#$d >= 1 && 10#$d <= 31 )) \
         && (( 10#$hh <= 23 && 10#$mi <= 59 && 10#$ss <= 60 )); then
        recognised+=("$base")
        continue
      fi
    fi
    strange+=("$base")
  done

  if (( ${#strange[@]} > 0 )); then
    info "NOTE: ${#strange[@]} file(s) here carry no coc-YYYYmmdd-HHMMSS.db stamp, so"
    info "      the retention policy does not cover them and will never delete them:"
    for base in "${strange[@]}"; do info "      $base"; done
  fi

  if (( ${#recognised[@]} == 0 )); then
    info "retention: no stamped backups in $dir — nothing to rotate"
    return 0
  fi

  # Newest first. LC_ALL=C so the ordering is byte order and not something a locale
  # decided; the names are ASCII digits either way, but the guarantee should not
  # depend on the environment.
  local sorted=() line
  while IFS= read -r line; do
    sorted+=("$line")
  done < <(printf '%s\n' "${recognised[@]}" | LC_ALL=C sort -r)

  local n=${#sorted[@]} i
  local dayk=() weekk=() monthk=() epochday
  for (( i = 0; i < n; i++ )); do
    base="${sorted[i]}"
    y="${base:4:4}"; m="${base:8:2}"; d="${base:10:2}"
    dayk[i]="$y$m$d"
    monthk[i]="$y$m"
    # 1970-01-01 was a Thursday, so +3 puts the week boundary on Monday.
    epochday="$(days_from_civil "$y" "$m" "$d")"
    weekk[i]=$(( (epochday + 3) / 7 ))
  done

  # Keep sets as |-delimited strings: bash 3.2 has no associative arrays and the
  # droplet is not the only machine this runs on. Backup names cannot contain a pipe.
  local kept="|" kept_roles="" kept_count=0 covered_weeks="|" covered_months="|"

  rot_keep() {
    local idx="$1" role="$2" name="${sorted[$1]}"
    if [[ "$kept" == *"|$name|"* ]]; then return 0; fi
    kept="$kept$name|"
    kept_roles="$kept_roles$name $role"$'\n'
    kept_count=$((kept_count + 1))
    covered_weeks="$covered_weeks${weekk[idx]}|"
    covered_months="$covered_months${monthk[idx]}|"
  }

  # The backup just taken, first and unconditionally. The deploy stopped to make it;
  # nothing downstream is allowed to decide it was not worth keeping.
  if [[ -n "$fresh" ]]; then
    for (( i = 0; i < n; i++ )); do
      if [[ "${sorted[i]}" == "$fresh" ]]; then rot_keep "$i" "just taken"; break; fi
    done
  fi

  # Dailies. Walking newest first, the first file seen for a day IS that day's
  # newest, so no second pass is needed.
  local seen_days="|" days_taken=0
  for (( i = 0; i < n; i++ )); do
    if (( days_taken >= KEEP_DAILY )); then break; fi
    if [[ "$seen_days" == *"|${dayk[i]}|"* ]]; then continue; fi
    seen_days="$seen_days${dayk[i]}|"
    days_taken=$((days_taken + 1))
    rot_keep "$i" "daily"
  done

  # Weekly. Skip the week in progress, skip any week a daily already covers, take
  # the newest file of the first week that is left. The in-progress check is
  # redundant while KEEP_DAILY is non-zero — the newest daily is in that week by
  # definition — but the policy should not become wrong if these numbers are edited.
  local current_week="${weekk[0]}" weeks_taken=0
  for (( i = 0; i < n; i++ )); do
    if (( weeks_taken >= KEEP_WEEKLY )); then break; fi
    if [[ "${weekk[i]}" == "$current_week" ]]; then continue; fi
    if [[ "$covered_weeks" == *"|${weekk[i]}|"* ]]; then continue; fi
    weeks_taken=$((weeks_taken + 1))
    rot_keep "$i" "weekly"
  done

  # Monthly, same shape one level up. covered_months has grown to include whatever
  # the weekly promoted, so "not already covered above" falls out of the order these
  # three loops run in.
  local current_month="${monthk[0]}" months_taken=0
  for (( i = 0; i < n; i++ )); do
    if (( months_taken >= KEEP_MONTHLY )); then break; fi
    if [[ "${monthk[i]}" == "$current_month" ]]; then continue; fi
    if [[ "$covered_months" == *"|${monthk[i]}|"* ]]; then continue; fi
    months_taken=$((months_taken + 1))
    rot_keep "$i" "monthly"
  done

  # Outcome checks, not exit codes — the premise of this whole file. Everything above
  # is arithmetic on strings, and arithmetic on strings is exactly the kind of thing
  # that returns a confident wrong answer. So before deleting anything, confirm the
  # two properties that make the result survivable rather than trusting the loops.
  if [[ "$kept" == "|" ]]; then
    info "WARNING: retention worked out that it should keep NOTHING, from $n backups."
    info "         That cannot be right, so nothing has been deleted. $dir is intact."
    return 0
  fi
  if [[ "$kept" != *"|${sorted[0]}|"* ]]; then
    info "WARNING: retention did not keep ${sorted[0]}, which is the newest backup on"
    info "         disk. That cannot be right, so nothing has been deleted."
    return 0
  fi
  if [[ -n "$fresh" && "$kept" != *"|$fresh|"* ]]; then
    info "WARNING: retention did not keep $fresh, the backup this deploy just took."
    info "         That cannot be right, so nothing has been deleted."
    return 0
  fi

  # Oldest first, so that if the cap below bites, what survives is the newest.
  local doomed=()
  for (( i = n - 1; i >= 0; i-- )); do
    if [[ "$kept" != *"|${sorted[i]}|"* ]]; then doomed+=("${sorted[i]}"); fi
  done

  # Blast-radius limit. A single run should be deleting the handful of backups this
  # deploy superseded. Wanting to delete twenty in one go means either a first run
  # under a new policy (the migration off "keep twenty" is exactly that, and takes
  # two deploys instead of one — fine) or something has gone wrong with the stamps.
  # Both are better served by trimming the oldest, saying so, and converging over the
  # next few deploys than by emptying the directory in one unattended pass.
  local wanted=${#doomed[@]}
  if (( wanted > KEEP_DELETE_CAP )); then
    doomed=("${doomed[@]:0:KEEP_DELETE_CAP}")
    info "NOTE: $wanted backups are past retention; deleting the oldest $KEEP_DELETE_CAP this run"
    info "      and the rest on following deploys. A run that wants to delete this many"
    info "      is either the first under this policy or a sign the stamps are wrong."
  fi

  local role_line
  while IFS= read -r role_line; do
    if [[ -n "$role_line" ]]; then info "keep   $role_line"; fi
  done <<< "$kept_roles"

  local deleted=0
  if (( ${#doomed[@]} > 0 )); then
    for base in "${doomed[@]}"; do
      rm -f -- "$dir/$base"
      # rm -f reports success for a file it never had permission to unlink in more
      # cases than is comfortable, and a backup directory that has quietly stopped
      # being writable is a real failure dressed as a working one. Ask the disk.
      if [[ -e "$dir/$base" ]]; then
        info "WARNING: could not delete $base — it is still there. Check permissions on $dir."
      else
        deleted=$((deleted + 1))
        info "delete $base"
      fi
    done
  fi

  # And confirm the directory is not empty afterwards, by looking rather than by
  # believing the loop above. This glob is wider than the policy — it will also see
  # anything reported as unparseable — which is what you want from a last-ditch "is
  # there still something here" check.
  local after=("$dir"/coc-*.db)
  if (( ${#after[@]} == 0 )); then
    die "Backup retention emptied $dir. It had $n backups a moment ago. Do not deploy
again until you know why — restore from BACKUP_REMOTE first if one is configured."
  fi
  if [[ -n "$fresh" && ! -f "$dir/$fresh" ]]; then
    die "Backup retention deleted $fresh, the backup this deploy had just taken.
Nothing has been pulled or restarted, so the site is unchanged. Do not deploy again
until you know why."
  fi

  # Counted from the keep set rather than from the directory, so the numbers stay
  # honest when there are unparseable files sitting alongside that were never in
  # scope. "kept 4 of 2" is what happens if you count the survivors instead.
  info "retention: kept $kept_count of $n stamped backups (${KEEP_DAILY}d/${KEEP_WEEKLY}w/${KEEP_MONTHLY}m), deleted $deleted"
}

# --prune-backups exists so update-test.sh can exercise the rotation against a
# directory of known stamps rather than against whatever four backups a test deploy
# happens to produce in the same minute. It runs the same function the deploy does,
# which is the only reason it is worth having: a second implementation for testing
# would test the second implementation. Handled here, before the git preconditions,
# because it has nothing to do with a checkout.
if [[ "$PRUNE_ONLY" == 1 ]]; then
  [[ -n "$PRUNE_DIR" ]] || die "--prune-backups needs a directory:
  ./deploy/update.sh --prune-backups ~/coc-backups"
  [[ -d "$PRUNE_DIR" ]] || die "$PRUNE_DIR is not a directory."
  say "Applying backup retention to $PRUNE_DIR"
  rotate_backups "$PRUNE_DIR" ""
  exit 0
fi

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

# Printed because after the re-exec above this script is running out of /tmp, and the
# question "which tree is it actually working on" stops having an obvious answer. If
# this ever names a temporary directory, ROOT was lost across the exec.
info "repo $ROOT"

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
  fresh_backup=""
  # .backup folds the write-ahead log into one consistent file and is safe while
  # the service is running; copying coc.db alone would leave the WAL behind.
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 server/data/coc.db ".backup '$BACKUP_DIR/coc-$stamp.db'"
    # The outcome, not the exit code. sqlite3 has been known to exit 0 having written
    # nothing when the destination is unwritable, and the retention policy below is
    # about to decide what to delete on the strength of this file existing.
    [[ -s "$BACKUP_DIR/coc-$stamp.db" ]] || die "sqlite3 exited 0 but $BACKUP_DIR/coc-$stamp.db
is missing or empty. Nothing has been pulled or restarted, so the site is unchanged.
Check the disk and the permissions on $BACKUP_DIR."
    fresh_backup="coc-$stamp.db"
    info "$BACKUP_DIR/coc-$stamp.db"
  else
    cp server/data/coc.db* "$BACKUP_DIR/" 2>/dev/null || true
    info "copied raw db files (sqlite3 not installed, so the WAL may lag)"
    # Those land as coc.db / coc.db-wal, with no stamp, so retention cannot place
    # them in a generation and deliberately leaves them alone. fresh_backup stays
    # empty and rotate_backups says as much when it lists them.
  fi

  # Prune to the generational policy. Everything about what survives is in the
  # comment on rotate_backups().
  rotate_backups "$BACKUP_DIR" "$fresh_backup"

  # Offsite copy, if one is configured.
  #
  # Five backups on the same droplet protect against a bad migration and against
  # nothing else: losing the droplet loses the accounts and the whole card season
  # with it. BACKUP_REMOTE is any rsync destination — `user@host:path/` or a local
  # mount — and lives in /srv/coc/.env beside the rest of the host's configuration.
  #
  # Note that the offsite side has no retention of its own: this sends the new backup
  # and never deletes anything there. Deleting on a host this script cannot inspect
  # is not something it should be doing unattended.
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
