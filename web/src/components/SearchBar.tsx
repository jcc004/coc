import { useState, type FormEvent } from 'react'
import { isValidTag, normalizeTag, usesCanonicalAlphabet } from '@coc/shared'
import { navigate } from '../hooks.ts'
import { recentsOfKind, type Recent } from '../recents.ts'

const TAG_SHAPE = 'Tags are 3–12 letters and digits, e.g. #2PP0JCCLV.'

/**
 * Advisory only — the API answers 404 for a malformed tag and an unknown one
 * alike, so it is the only authority on whether a tag exists. Warn, then go.
 */
const OFF_ALPHABET =
  'Heads up: that tag uses letters outside the usual set (0289 PYLQGRJCUV), so it may be a typo. Looking it up anyway.'

/** The minimum the server enforces on `GET /api/clans?name=…`. */
const MIN_NAME_LENGTH = 3

function Problem({ text }: { text: string }) {
  return (
    <p className="notice__hint" style={{ borderTop: 'none', paddingTop: 8 }}>
      {text}
    </p>
  )
}

/**
 * The few most recent visits of one kind, shown inside that kind's lookup card
 * so each list sits directly under the box that produced it.
 */
function RecentList({ recents, kind }: { recents: Recent[]; kind: Recent['kind'] }) {
  const shown = recentsOfKind(recents, kind)
  if (shown.length === 0) return null

  return (
    <div className="recent-block">
      <h3 className="recent-block__title">Recent {kind === 'player' ? 'players' : 'clans'}</h3>
      <div className="recents recents--stacked">
        {shown.map((recent) => (
          <button
            key={recent.tag}
            type="button"
            className="chip"
            title={recent.tag}
            onClick={() => navigate({ view: kind, tag: recent.tag })}
          >
            {recent.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function PlayerLookup({ recents }: { recents: Recent[] }) {
  const [query, setQuery] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = query.trim()
    if (!value) return

    if (!isValidTag(value)) {
      setProblem(TAG_SHAPE)
      return
    }

    setProblem(usesCanonicalAlphabet(value) ? null : OFF_ALPHABET)
    navigate({ view: 'player', tag: value })
  }

  return (
    <section className="card">
      <h2 className="section-title">Find player</h2>
      <form className="search" onSubmit={submit}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Player tag, e.g. #2PP0JCCLV"
          aria-label="Player tag"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit">Look up player</button>
      </form>
      {problem ? <Problem text={problem} /> : null}
      <RecentList recents={recents} kind="player" />
    </section>
  )
}

function ClanLookup({ recents }: { recents: Recent[] }) {
  const [query, setQuery] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const value = query.trim()
  /* Tag and name share one input, and the two are genuinely ambiguous — a short
     alphanumeric name like "Reddit" is a structurally valid tag — so say which
     branch will run before the user commits to it. */
  const preview = !value
    ? null
    : isValidTag(value)
      ? `Opens clan ${normalizeTag(value)}`
      : value.length < MIN_NAME_LENGTH
        ? `Name search needs at least ${MIN_NAME_LENGTH} characters`
        : `Searches clan names for “${value}”`

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!value) return

    if (isValidTag(value)) {
      setProblem(usesCanonicalAlphabet(value) ? null : OFF_ALPHABET)
      navigate({ view: 'clan', tag: value })
      return
    }

    if (value.length < MIN_NAME_LENGTH) {
      setProblem(`Clan name search needs at least ${MIN_NAME_LENGTH} characters.`)
      return
    }

    setProblem(null)
    navigate({ view: 'search', name: value })
  }

  return (
    <section className="card">
      <h2 className="section-title">Find clan</h2>
      <form className="search" onSubmit={submit}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Clan tag or name"
          aria-label="Clan tag or clan name"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit">Look up clan</button>
      </form>
      {problem ? <Problem text={problem} /> : null}
      {preview ? <p className="lookup-preview">{preview}</p> : null}
      <RecentList recents={recents} kind="clan" />
    </section>
  )
}

/**
 * The two lookup cards, each carrying its own Recent list.
 *
 * **Homepage only, under the saved clans**, side by side in one row that becomes one
 * column on a phone.
 *
 * They used to live in a 260px sidebar on every route, and each form carried
 * `search--stacked` because that column had no room for an input and a button on one
 * line. Both of those are now wrong: the column is half the page, and a stacked form
 * there puts a 570px gold slab of a submit button under a 570px input — seen in a
 * screenshot at 1280px. So they use the ordinary `.search` row, where the input
 * flexes and the button takes the width of its own label, and the 600px rule that
 * already stacks every other form in the app is what handles a phone.
 */
export function SearchBar({ recents }: { recents: Recent[] }) {
  return (
    <div className="lookup-row">
      <PlayerLookup recents={recents} />
      <ClanLookup recents={recents} />
    </div>
  )
}
