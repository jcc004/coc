# Propose a change

Any signed-in user can ask for something about this app to be different. An admin resolves the
request later, with a reason. It replaces "mention it in chat and hope somebody remembers" with a
row everybody involved can find again.

## Where it is

`#/change-requests`, reached from the account menu (**Propose a change**, directly under **Change
password**) — one page, one route, for **everyone**. Unlike the admin panel, it is not role-gated:
every signed-in user gets a submit form and their own **My requests** list, and an admin
additionally sees every account's requests in a resolution table on the same page, below their own
section. `web/src/components/ChangeRequestsView.tsx` is the whole page.

## Submitting

A subject (one line, **255 characters**, enforced server-side — not just an HTML `maxlength`) and a
free-text body (**4,000 characters**, also server-enforced). Neither existed as a length-capped
field anywhere else in this codebase to match, so 4,000 was picked directly: roughly a page of
prose, comfortably more than a considered request needs, small enough that a pasted-in log file or
config dump is refused with a clear 400 rather than landing in the table and growing every backup
for good.

No image upload — out of scope for now, but the schema and the request body do not assume "exactly
one text blob and nothing else". Adding an attachment reference later is a plain `ALTER TABLE ADD
COLUMN` and an optional field every existing caller can ignore, not a redesign.

## After submission

Three things a requester can do to their own request, independent of each other and of whatever an
admin has done with it:

- **Amend.** The original subject and body are locked — never edited in place. Instead, more text
  can be appended as a dated amendment, shown below the original in the order it was added: an
  append-only log, the same shape as an audit trail, not a second editable field. **Locked once the
  request is canceled or resolved** — a closed request is a closed record, the same way a resolved
  trade's original proposal never changes once `resolvedAt` is set (`shared/src/trade-types.ts`).
- **Cancel.** The requester's own withdrawal, at any time, whatever the request's resolution state.
  **One-way** — there is no route to un-cancel — unlike hide below. The row is never deleted or
  removed from the admin table; it stays, marked canceled, in both places.
- **Hide.** A personal, **reversible** toggle on the requester's own "My requests" list only. It
  never affects the admin table, which always shows every request regardless of what any requester
  has hidden from their own view. A toggle rather than a one-way door, since there is no reason to
  risk losing track of something the requester wanted to check on later.

## Resolving — admin only

An admin can resolve any request at any time, whatever its cancel state — resolving an
already-canceled request is harmless bookkeeping (tagging it "outside of scope" for the record),
and there is no reason to special-case it away. Exactly one of:

1. **As designed** — the app already does this on purpose.
2. **Outside of project scope.**
3. **Tied to a commit** — the admin picks a commit off the What's New list already loaded in the
   browser (`loadChanges()`, `web/src/changelog.ts`) and the client sends that commit's short hash
   and subject to the server as plain data. **The server does not validate the hash against git**:
   the changelog payload is baked into the client bundle at build time from `git log`, and the
   server has no git history at runtime to check anything against — the same reason
   `TradeRecord.category` is "recorded for display and grouping, not enforced"
   (`shared/src/trade-types.ts`). A hand-typed hash that names nothing real is possible and is not
   this feature's problem to solve.

All three additionally accept an optional free-text note, so a one-click resolve with no comment
stays possible.

**Resolving is not single-shot**, unlike completing a trade. Completing a `TradeRecord` moves real
card counts, so doing it twice would move them twice — that is what `mayResolveTrade`'s
once-only refusal protects. Resolving a change request has no effect beyond recording an answer, so
an admin may resolve the same request again later — to correct a note, or to change "outside of
scope" to "tied to commit `abc1234`" once that commit ships. Each call replaces the prior
resolution outright; there is no history of earlier resolutions kept.

The admin table shows the requesting user, the date of the request, the subject, and — once there
is one — the resolution's type, date and note. An unresolved row simply shows no resolution.

## Schema

Migration v15 (`server/src/db.ts`), two tables:

- **`change_requests`** — one row per request. `subject`/`body` repeat the shared max lengths as
  `CHECK`s, the database being the last line the way `card_inventory`'s count and card-id `CHECK`s
  already are. `canceled_at` and the five `resolution_*` columns are independent nullable columns,
  not a single status enum — a request can be canceled *and* resolved, in either order, and folding
  that into one enum would need a fifth cross-product value and a route that remembers to check two
  things whenever it means to check one.
- **`change_request_amendments`** — one row per amendment, a child table rather than a column on
  the request. An amendment is a variable-length, append-only log that can grow at any time, the
  same reasoning that keeps `auth_events` a table rather than a blob on `users`, and it lets the log
  be queried and tested on its own the way `card_inventory`'s per-card rows can be.

Full reasoning, including why `hidden_at` has no companion "hidden by" column and why the two
commit fields are gated by a `CHECK` rather than the app alone, is in the migration's own doc
comment.

## Access rules

Pure, tested functions in `server/src/change-requests/access.ts` — this repo's own `CLAUDE.md`
calls out `mayWriteBaseCounts` as the model for this discipline, and the trade rules and these
follow it the same way:

- **Submit** — every signed-in, non-disabled account.
- **Amend, cancel, hide** — the request's own author only, **no admin exception**. None of the
  three write shared data the way completing a trade or assigning an owner does; they are the
  requester's own record of their own ask, and an admin's tool for a request they disagree with is
  resolving it, not standing in for the author.
- **Resolve** — an admin only, **no author exception at all**. A request's author never resolves
  their own request, the same asymmetry `mayUndoTrade` has against `mayResolveTrade`: "resolved" is
  an answer from the app's side, not something either party may declare.

`web/src/change-request-rules.ts` mirrors the first three client-side, the same way
`trade-tracker.ts` mirrors `trade-access.ts` — the server remains the enforcement, the client rule
only stops the UI offering a button that would be refused. There is no client-side mirror of the
admin resolve rule: the resolution table only ever renders for an admin at all (the same page-level
gate `AdminView.tsx` uses for the whole admin panel), so no member's screen can offer a Resolve
button to begin with.
