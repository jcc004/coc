# coc

A Clash of Clans API explorer: look up player profiles, clan details, clan rosters, wars, and
capital raid weekends.

TypeScript throughout — [Hono](https://hono.dev) API on Node, React + Vite frontend, no
component library. The API token stays on the server; the browser only ever talks to `/api`.

This file is the index; the documentation is in [`docs/`](docs/), one file per topic. It used to
be one 2,000-line README, which is past the length anyone reads and too long to search. Nothing
was rewritten in the move — the prose is the same prose, in pieces you can find.

## Running it

Node is pinned to **22.23.2** in `.nvmrc`, and the pin is not decoration: `node:sqlite` is the
entire persistence layer and it is still experimental. Then `npm install`, a `.env` holding your
Supercell token, and one boot with `ADMIN_EMAIL` / `ADMIN_PASSWORD` set to create the first
account. [Setup, deployment and scripts](docs/setup.md#setup) has the exact sequence, and the
thing that most often goes wrong first — the API key's IP binding — is immediately beneath it.

Deployment is not this repo's CI. `.github/workflows/verify.yml` typechecks, tests and builds;
the droplet pulls `main` on its own timer and deploys within five minutes. What a host has to
provide is under [Deployment](docs/setup.md#deployment); how the box is actually built — Nginx,
TLS, the systemd units — is [`deploy/README.md`](deploy/README.md).

## The docs

- **[Setup, deployment and scripts](docs/setup.md)** — running it locally, the Node pin and why
  local dev and production currently disagree, the API key's IP binding, what a host must
  provide, fetching the game art before a build, and every `npm` script.
- **[Authentication](docs/authentication.md)** — why there is a login at all, server-side
  sessions rather than JWT, scrypt, admin-mediated password recovery and why there is
  deliberately no email reset, the account columns, the SQLite storage, all seven migrations,
  and the environment variables.
- **[Layout](docs/layout.md)** — which workspace holds what, and the module conventions: rules
  live in pure tested modules, three files are machine-written, components shown twice are
  shared rather than copied.
- **[The API, and what the upstream really returns](docs/api.md)** — the routes this server
  exposes and its cache, then what Supercell's API does and does not give you per tag (probed,
  not read off the docs), and the payload quirks to know before reading the code.
- **[The UI: chrome, responsive rules and the views](docs/ui.md)** — phones and tablets first and
  the recipe a new table has to follow, the topbar and account menu, the in-app help pages and
  their deep links, the lookup forms, the war view, and capital raid weekends.
- **[Saved clans, shared data and ownership](docs/shared-data.md)** — one shared copy of the data
  rather than one per user, who may assign an owner and who may write a base, optimistic
  concurrency on the bulk apply, the one-time import out of the browser, and the row-limit and
  paging machinery every table here uses.
- **[The card-collecting event](docs/cards.md)** — the generated sixty-card list, how a tile is
  framed, the inventory tables and why the counts are shared, the season constant, the routes,
  and the four rules that make a swap legal.
- **[The card event's screens](docs/cards-ui.md)** — the card page top to bottom: base picker and
  grid, trade suggestions and why they page by pair, the collection leaderboard and its points
  curve, clan-wide totals, the Mine/All filter, the deck plaques, and the same grid on a player
  page.
- **[The Trade Tracker](docs/trade-tracker.md)** — proposing a swap, who may resolve one and why
  that rule differs from card entry, the audit record, the ordering, and what completing does to
  both bases' counts.
- **[Game art and the Fan Content Policy](docs/game-art.md)** — which asset comes from where, why
  `web/public/coc/` is gitignored, absent art as the normal case rather than an error, and the
  licensing conditions that became binding when this went to public hosting.
- **[`deploy/README.md`](deploy/README.md)** — the droplet itself: Nginx, TLS, the service and
  update units, and what CI does and does not do. Kept beside the deployment rather than here,
  and maintained with it.

## License

[MIT](LICENSE), for the code. It does not cover the game art, the league and label icons, or
anything else originating with Supercell or the community wiki — none of that is the author's to
license, and the repo redistributes none of it. The detail is in
[Licensing, and why it matters more now](docs/game-art.md#licensing-and-why-it-matters-more-now).
