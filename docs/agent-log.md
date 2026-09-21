# Agent dispatch log

Append-only. One line per subagent dispatched from a session working in this repo, written at
dispatch time (before the result is known), plus a completion line if the session is still around
to write it. See `claude-kit/rules/working-style.md`'s "Delegating" section for why this exists —
a session that loses live track of its own agents mid-run reads this file first, cross-references
it against `ListAgents`, and decides what (if anything) needs resuming from there.

## 2026-09-05 — code-review fix batch

Source: `code-review/coc/*.md` review recommendations (run `2026-09-05_0828`). Five items dispatched
in parallel as isolated-worktree subagents; four trivial doc/config fixes (monitor.yml comment,
CLAUDE.md any-enforcement doc, styles.css dedupe, nginx Permissions-Policy header) plus the nanoid
dependency bump were done directly in the main session instead.

Dispatched (all isolated worktrees, general-purpose agent, none instructed to commit or push):

- `ad14b3f762b649741` — fix `04-fix-savedclansview-row-limit-pager.md`: move `RowLimitSelect` into
  the `.roster-footer` beside `Pager` in `SavedClansView.tsx`.
- `addda00f08942825a` — fix `07-fix-n-plus-one-change-requests.md`: single `IN (...)` query for
  amendments in `change-requests/store.ts`'s `list()`, grouped in JS.
- `a87ac5c3155513a97` — fix `08-add-tradesuggestions-test-coverage.md`: new
  `TradeSuggestions.test.tsx` covering admin-vs-non-party fast-path button visibility.
- `a16f6fea7ae2a1185` — fix `11-add-temp-password-expiry.md`: `password_expires_at` column (v17
  migration), 48h TTL, login-time rejection with a clear error.
- `adf55800832e8cef4` — fix `13-add-per-user-date-format.md`: per-user date/time format
  preference, localStorage-based (mirroring `useColorScheme`), new `DateFormatCard.tsx`.

All five completed and merged. `04`/`07`/`08` reviewed and merged directly (small, single-file
diffs). `11` and `13` were reviewed in full before merging (schema/route change and a
wide-reaching call-site refactor, respectively) and each got one follow-up fix on top of the
agent's own work: `11`'s expiry was extended to the invite route (`createUser`), which the
agent's own report flagged as sharing the identical risk but outside its stated scope; `13`'s
merge required care because its worktree branched before the `03` CSS-dedupe commit landed on
main — a blind wholesale file copy would have silently reverted that fix, caught by re-checking
`styles.css` after copying rather than trusting the copy. All eight commits pushed and confirmed
live via `/api/health` and the droplet's own deploy log.

## 2026-09-21 — independent review of the nginx host-wide comment

Pre-commit review, per `claude-kit/rules/working-style.md`'s "Review and tests need independence",
of a comment-only diff to `deploy/nginx-coc.conf` (notes that `server_tokens` and
`limit_req_status` are shared with every other site on the droplet). Not isolated; read-only,
told not to contact the droplet or any browser.

Dispatched (general-purpose agent, background, not instructed to edit, commit or push):

- `aa668951b42b4957d` — review the diff for factual claims about nginx scope and duplicate
  directives, whether the live-host sentence overclaims its evidence, secrets, and syntax.

Completed. The first report found three wording problems in the added comment, all correct: an
overclaim for `limit_req_status` (it only affects a site that uses `limit_req`), "could not repeat
them" (true only at file scope; both directives are valid inside a `server {}` block), and "the only
enabled config" (wider than the grep behind it). Fixed after a full `nginx -T` on the live host and
a probe on nginx 1.30.4 in a container. A re-review through the same agent, continued with
`SendMessage`, closed all three and raised two more, both fixed: the 1.30.4 result was a container's,
not the host's, and two lines ran wide. That last edit was not reviewed a third time.

## 2026-09-21 — independent review of the development-React check in update.sh

Pre-commit review, per `claude-kit/rules/working-style.md`'s "Review and tests need independence",
of the change that replaces `deploy/update.sh`'s 450 kB size warning with a scan of the built JS for
React's development-only text (`dev_react_markers`), with its `deploy/update-test.sh` section 23,
`web/src/dev-react-markers.test.ts`, and three `deploy/README.md` edits. Not isolated; read-only,
told not to contact the droplet or any browser, and to report the Node version it used.

Dispatched (general-purpose agent, background, not instructed to edit, commit or push):

- `aeab0de45389337f2` — review for bash/`set -e` correctness, GNU/BSD grep and bash 3.2 portability,
  whether each new test assertion can fail, the guard test's failure modes, and doc accuracy.

Completed, in two rounds. The first report ranked five findings. The real defect: the scan would
flag `changelog-data-*.js`, which holds every kept commit's subject and body verbatim, so one commit
quoting a marker would make every later deploy warn on a production build. Confirmed before acting:
a kept commit's subject is in that chunk and a `No-Changelog` one is not. It also found three
mutations of `update.sh` that the harness passed (an unquoted expansion, a whole-line `grep -x`,
and a hidden grep read error). Fixed: the chunk is skipped, a grep read error is reported, the
fixtures put the marker mid-line and add a clean-words fixture, and the guard test errors on a
marker line it cannot read. The re-review, through the same agent, closed those and raised three
more, all fixed: a check that would have failed about one run in 200 on a random temp-directory
name (now it asserts nothing is printed between two known log lines), fixtures without the
changelog chunk a real build always has, and a loosely pinned scan-failure path. Twelve mutations of
`update.sh` were then each caught by the harness. That last round of test edits was verified by
those mutations and was not re-read by an agent.
