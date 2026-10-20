# Incidents

Append-only record of what went wrong in production or at deploy time: what happened,
what was missed, what changed afterwards. Check it before a deploy or a change to a unit.

## 2026-10-20: weekly progress timers failed for four weeks

**What happened.** `coc-progress-snapshot.service` failed every Tuesday from Sep 22 and
`coc-progress-reference.service` failed at least Oct 13 and Oct 20. The snapshot died on
"COC_API_TOKEN is not set" after printing ".env not found"; the reference refresh died on
"unable to open database file". No weekly progress snapshots were captured for Sep 22 to
Oct 13, and the game API cannot supply past weeks afterwards. `coc.service` stayed healthy
throughout, so nothing looked wrong from the site.

**Pattern.** A service moved to a dedicated account and its sibling units, which read the
same files, were missed. `71b7964` set `coc.service` to `User=coc` and chowned the data
directory, but the two timer units kept `User=crighjc`, which cannot read `.env` or the
database (both 0600, owned by `coc`). The symptom hid the cause: `--env-file-if-exists`
treats an unreadable file as missing.

**Found by.** A peer session working on the shared droplet noticed the failed units; no
alert existed.

**Changed.** Both units now run as `User=coc` (`2770f7b`); started by hand on the host and
both exited 0. `deploy/README.md` states the account requirement.

**Still open.** Nothing alerts on a failed timer run or a stale latest snapshot week.
Before moving any other unit to a different account, `rg` the `deploy/` units for every one
that touches `.env` or `server/data`.
